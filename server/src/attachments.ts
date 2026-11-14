import { boundedResponse, generationBudgets } from './generation-limits.js'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pool } from './db/client.js'
import { config } from './config.js'
import { HttpError, inTransaction, type Queryable } from './store.js'
import { sessionIsLive, consumeAuthRate, authRateKey } from './auth-security.js'
import {
  validateAttachment,
  AttachmentValidationError,
  MAX_ATTACHMENT_BYTES,
} from './attachment-validation.js'
import type { FileAttachment, UserMessage } from '../../src/services/chat/types.js'

export const attachmentRoutes = new Hono<{ Variables: { userId: string; sessionId: string } }>()
const BETA = 'files-api-2025-04-14'
let uploads = 0
type Row = {
  id: string
  user_id: string
  name: string
  size_bytes: number | string
  mime_type: string
  is_image: boolean
  status: string
  provider_file_id: string | null
  content_hash: string
  deleted_at: Date | null
  error_code: string | null
}

function metadata(row: Row) {
  return {
    id: row.id,
    attachmentId: row.id,
    serverId: null,
    name: row.name,
    size: Number(row.size_bytes),
    mimeType: row.mime_type,
    isImage: row.is_image,
    status: row.status,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  }
}

function error(status: number, code: string, message: string): never {
  throw new HttpError(status, message, code)
}

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/** 鉴权和并发门后才读取multipart，限制总量和读入时长；不把原件写入磁盘。 */
async function form(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data;')) {
    error(400, 'INVALID_ATTACHMENT', '请使用附件上传表单')
  }
  const reader = request.body?.getReader()
  if (!reader) {
    error(400, 'INVALID_ATTACHMENT', '附件为空')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const until = Date.now() + 30_000
  try {
    while (true) {
      const remaining = until - Date.now()
      if (remaining <= 0) {
        throw new Error('timeout')
      }
      const item = await deadline(reader.read(), Math.min(10_000, remaining))
      if (item.done) {
        break
      }
      total += item.value.byteLength
      if (total > MAX_ATTACHMENT_BYTES + 16 * 1024) {
        error(413, 'ATTACHMENT_TOO_LARGE', '附件超过8MiB限制')
      }
      chunks.push(item.value)
    }
  } catch (e) {
    void reader.cancel().catch(() => {})
    if (e instanceof HttpError) {
      throw e
    }
    error(408, 'ATTACHMENT_BODY_TIMEOUT', '读取附件超时，请重新选择文件')
  } finally {
    reader.releaseLock()
  }
  try {
    return await new Response(new Uint8Array(Buffer.concat(chunks)).buffer, {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData()
  } catch {
    return error(400, 'INVALID_ATTACHMENT', '附件表单无效')
  }
}

attachmentRoutes.post('/', async (c) => {
  if (uploads >= 2) {
    return c.json({ error: { code: 'UPLOAD_BUSY', message: '同时上传数量已满，请稍后再试' } }, 429)
  }
  uploads++
  try {
    if (!config.deepseekKey) {
      error(503, 'ATTACHMENT_UNAVAILABLE', '后端尚未配置文件服务')
    }
    const data = await form(c.req.raw)
    if (
      [...data.keys()].some((k) => !['file', 'uploadKey'].includes(k)) ||
      data.getAll('file').length !== 1 ||
      data.getAll('uploadKey').length !== 1
    ) {
      error(400, 'INVALID_ATTACHMENT', '每次只能上传一个文件')
    }
    const file = data.get('file')
    if (!(file instanceof File)) {
      error(400, 'INVALID_ATTACHMENT', '附件字段无效')
    }
    const uploadKey = z.string().uuid().parse(data.get('uploadKey'))
    const bytes = new Uint8Array(await file.arrayBuffer())
    let detected: ReturnType<typeof validateAttachment>
    try {
      detected = validateAttachment(file, bytes)
    } catch (e) {
      if (e instanceof AttachmentValidationError) {
        error(e.status, e.code, e.message)
      }
      throw e
    }
    const contentHash = createHash('sha256')
      .update(JSON.stringify([file.name, detected.mimeType, file.size]))
      .update(bytes)
      .digest('hex')
    if (!(await sessionIsLive(pool, c.get('userId'), c.get('sessionId')))) {
      error(401, 'SESSION_EXPIRED', '登录已失效，请重新登录')
    }
    const reserved = await inTransaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'attachments:' + c.get('userId'),
      ])
      const prior = await q.query<Row>(
        'SELECT * FROM attachment WHERE user_id=$1 AND upload_key=$2 FOR UPDATE',
        [c.get('userId'), uploadKey]
      )
      if (prior.rows[0]) {
        const row = prior.rows[0]
        if (row.content_hash !== contentHash) {
          error(409, 'ATTACHMENT_IDEMPOTENCY_CONFLICT', '上传标识已用于另一份文件')
        }
        if (row.status === 'ready' && !row.deleted_at) {
          return { row, replay: true }
        }
        error(
          409,
          row.status === 'pending' ? 'ATTACHMENT_UPLOAD_PENDING' : 'ATTACHMENT_UPLOAD_UNKNOWN',
          '此前上传未能确认可用，不会自动重新上传或重复计费'
        )
      }
      // 失败/未知/已移除都计入尝试频率，不能通过反复失败或软删绕过限流。
      const recent = await q.query(
        "SELECT count(*)::int count FROM attachment WHERE user_id=$1 AND created_at>NOW()-INTERVAL '1 minute'",
        [c.get('userId')]
      )
      if (recent.rows[0].count >= 10) {
        error(429, 'ATTACHMENT_RATE_LIMIT', '上传尝试过于频繁，请稍后再试')
      }
      // soft-delete/unknown仍可能占供应商空间，不允许反复移除草稿绕过配额。
      const quota = await q.query(
        "SELECT count(*)::int count,COALESCE(sum(size_bytes),0)::bigint bytes FROM attachment WHERE user_id=$1 AND status<>'failed'",
        [c.get('userId')]
      )
      if (
        quota.rows[0].count >= 100 ||
        Number(quota.rows[0].bytes) + file.size > 100 * 1024 * 1024
      ) {
        error(429, 'ATTACHMENT_QUOTA', '附件数量或容量已达到本地配额')
      }
      const inserted = await q.query<Row>(
        'INSERT INTO attachment(id,user_id,upload_key,content_hash,name,size_bytes,mime_type,is_image,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          randomUUID(),
          c.get('userId'),
          uploadKey,
          contentHash,
          file.name,
          file.size,
          detected.mimeType,
          detected.isImage,
          detected.purpose ?? 'user_data',
        ]
      )
      return { row: inserted.rows[0], replay: false }
    })
    if (reserved.replay) {
      return c.json(metadata(reserved.row), 200)
    }
    const id = reserved.row.id
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180_000)
    let remoteId: string | null = null
    let definiteFailure = false
    try {
      const upload = new FormData()
      // 文档解析要求purpose在file之前，顺序不可交给浏览器表单决定。
      if (detected.purpose) {
        upload.append('purpose', detected.purpose)
      }
      upload.append('file', new Blob([bytes], { type: detected.mimeType }), id + '-' + file.name)
      // 解析开始后浏览器断开并不能阻止供应商计费，因此继续核对结果，不自动重传。
      const response = await fetch('https://api.deepseek.com/anthropic/v1/files', {
        method: 'POST',
        headers: { 'x-api-key': config.deepseekKey, 'anthropic-beta': BETA },
        body: upload,
        signal: controller.signal,
      })
      if (!response.ok) {
        definiteFailure = response.status >= 400 && response.status < 500 && response.status !== 408
        void response.body?.cancel().catch(() => {})
        error(
          response.status === 429 ? 429 : 502,
          definiteFailure ? 'ATTACHMENT_PROVIDER_FAILED' : 'ATTACHMENT_UPLOAD_UNKNOWN',
          definiteFailure
            ? '文件服务已明确拒绝附件，请检查文件或联系管理员'
            : '上传结果尚未确认，请勿重复上传'
        )
      }
      if (!response.body) {
        throw new Error('empty response')
      }
      const raw = (await deadline(
        new Response(
          boundedResponse(
            response.body,
            {
              ...generationBudgets,
              idleMs: 10_000,
              maxResponseBytes: 64 * 1024,
            },
            controller.signal
          )
        ).json(),
        10_000
      )) as Record<string, unknown>
      if (typeof raw.id === 'string' && /^file-[A-Za-z0-9_-]{1,120}$/.test(raw.id)) {
        remoteId = raw.id
      }
      if (
        typeof raw.id !== 'string' ||
        !/^file-[A-Za-z0-9_-]{1,120}$/.test(raw.id) ||
        raw.type !== 'file' ||
        raw.size_bytes !== file.size
      ) {
        error(
          502,
          'ATTACHMENT_PROVIDER_INVALID',
          '文件服务响应未能确认，上传可能已完成，请勿重复上传'
        )
      }
      remoteId = raw.id
      const ready = await pool.query<Row>(
        "UPDATE attachment SET provider_file_id=$2,status='ready',updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *",
        [id, remoteId]
      )
      if (!ready.rows[0]) {
        throw new Error('state changed')
      }
      return c.json(metadata(ready.rows[0]), 201)
    } catch (e) {
      // 网络/超时/本地最终写失败都不能推断供应商未保存。只记待核对，不DELETE。
      await pool
        .query(
          "UPDATE attachment SET status=$2,provider_file_id=COALESCE($3,provider_file_id),cleanup_pending=$4,error_code=$5,updated_at=NOW() WHERE id=$1 AND status='pending'",
          [
            id,
            definiteFailure ? 'failed' : 'unknown',
            remoteId,
            !definiteFailure,
            definiteFailure ? 'PROVIDER_REJECTED' : 'UPLOAD_UNCONFIRMED',
          ]
        )
        .catch(() => {})
      if (e instanceof HttpError) {
        throw e
      }
      error(502, 'ATTACHMENT_UPLOAD_UNKNOWN', '上传结果尚未确认，请勿自动重复上传')
    } finally {
      controller.abort()
      clearTimeout(timer)
    }
  } finally {
    uploads--
  }
})

/**
 * 只核对上传时已经取得并记录的供应商ID；不扫描账号共享列表，也不凭同名文件认领归属。
 * Files没有原文下载/内容hash，未取得ID的未知上传只能保留待人工核对，绝不自动重传。
 */
attachmentRoutes.post('/:id/reconcile', async (c) => {
  if (!(await sessionIsLive(pool, c.get('userId'), c.get('sessionId')))) {
    error(401, 'SESSION_EXPIRED', '登录已失效，请重新登录')
  }
  const found = await pool.query<Row>('SELECT * FROM attachment WHERE id=$1 AND user_id=$2', [
    c.req.param('id'),
    c.get('userId'),
  ])
  let row = found.rows[0]
  if (!row) {
    error(404, 'ATTACHMENT_NOT_FOUND', '附件不存在')
  }
  if (row.deleted_at || row.status === 'deleted') {
    error(409, 'ATTACHMENT_REMOVED', '已移除附件不会自动恢复')
  }
  if (row.status === 'ready') {
    return c.json(metadata(row))
  }
  if (row.status === 'pending') {
    const stale = await pool.query<Row>(
      "UPDATE attachment SET status='unknown',cleanup_pending=true,error_code='UPLOAD_UNCONFIRMED',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='pending' AND created_at<NOW()-INTERVAL '5 minutes' RETURNING *",
      [row.id, c.get('userId')]
    )
    if (!stale.rows[0]) {
      error(409, 'ATTACHMENT_UPLOAD_PENDING', '附件仍在上传，请稍后核对')
    }
    row = stale.rows[0]
  }
  if (
    row.status !== 'unknown' ||
    !row.provider_file_id ||
    !/^file-[A-Za-z0-9_-]{1,120}$/.test(row.provider_file_id)
  ) {
    error(
      409,
      'ATTACHMENT_RECONCILE_MANUAL',
      '缺少可安全核对的供应商引用，请联系管理员；不会自动重传'
    )
  }
  if (!config.deepseekKey) {
    error(503, 'ATTACHMENT_UNAVAILABLE', '后端尚未配置文件服务')
  }
  const limit = await consumeAuthRate(
    pool,
    authRateKey('attachment-reconcile', c.get('userId')),
    10,
    60
  )
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter))
    error(429, 'ATTACHMENT_RECONCILE_RATE_LIMIT', '附件核对过于频繁，请稍后再试')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await deadline(
      fetch(
        'https://api.deepseek.com/anthropic/v1/files/' + encodeURIComponent(row.provider_file_id),
        {
          headers: { 'x-api-key': config.deepseekKey, 'anthropic-beta': BETA },
          signal: controller.signal,
        }
      ),
      10_000
    )
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {})
      error(409, 'ATTACHMENT_RECONCILE_UNCONFIRMED', '仍无法确认附件是否保存，请勿重新上传')
    }
    const raw = (await deadline(
      new Response(
        boundedResponse(
          response.body,
          {
            ...generationBudgets,
            idleMs: 5_000,
            maxResponseBytes: 64 * 1024,
          },
          controller.signal
        )
      ).json(),
      10_000
    )) as Record<string, unknown>
    if (
      raw.id !== row.provider_file_id ||
      raw.type !== 'file' ||
      raw.filename !== row.id + '-' + row.name ||
      raw.size_bytes !== Number(row.size_bytes) ||
      raw.mime_type !== row.mime_type
    ) {
      error(409, 'ATTACHMENT_RECONCILE_MISMATCH', '供应商元数据与原上传不一致，需人工核对')
    }
    // 网络检查不占用事务；最终条件更新避免重新激活已删除或被其他请求更改的附件。
    const saved = await pool.query<Row>(
      "UPDATE attachment SET status='ready',cleanup_pending=false,error_code=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='unknown' AND deleted_at IS NULL AND provider_file_id=$3 RETURNING *",
      [row.id, c.get('userId'), row.provider_file_id]
    )
    if (!saved.rows[0]) {
      error(409, 'ATTACHMENT_STATE_CHANGED', '附件状态已变化，请刷新')
    }
    return c.json(metadata(saved.rows[0]))
  } catch (e) {
    if (e instanceof HttpError) {
      throw e
    }
    error(502, 'ATTACHMENT_RECONCILE_UNCONFIRMED', '附件核对暂时失败，请勿重新上传')
  } finally {
    controller.abort()
    clearTimeout(timer)
  }
})

// 浏览器只需原上传幂等键即可找到本账号任务，无需知道任何供应商ID。
attachmentRoutes.get('/by-upload-key/:uploadKey', async (c) => {
  const key = z.string().uuid().parse(c.req.param('uploadKey'))
  const found = await pool.query<Row>(
    'SELECT * FROM attachment WHERE upload_key=$1 AND user_id=$2',
    [key, c.get('userId')]
  )
  if (!found.rows[0]) {
    error(404, 'ATTACHMENT_NOT_FOUND', '未找到该账号的上传记录')
  }
  return c.json(metadata(found.rows[0]))
})

attachmentRoutes.get('/:id', async (c) => {
  const found = await pool.query<Row>('SELECT * FROM attachment WHERE id=$1 AND user_id=$2', [
    c.req.param('id'),
    c.get('userId'),
  ])
  if (!found.rows[0]) {
    error(404, 'ATTACHMENT_NOT_FOUND', '附件不存在')
  }
  return c.json(metadata(found.rows[0]))
})
attachmentRoutes.delete('/:id', async (c) => {
  await inTransaction(async (q) => {
    const found = await q.query<Row>(
      'SELECT * FROM attachment WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [c.req.param('id'), c.get('userId')]
    )
    if (!found.rows[0]) {
      error(404, 'ATTACHMENT_NOT_FOUND', '附件不存在')
    }
    if (found.rows[0].status === 'pending') {
      error(409, 'ATTACHMENT_UPLOAD_PENDING', '附件仍在上传，暂不能移除')
    }
    const refs = await q.query(
      'SELECT 1 FROM attachment_reference WHERE attachment_id=$1 LIMIT 1',
      [c.req.param('id')]
    )
    if (refs.rowCount) {
      error(409, 'ATTACHMENT_REFERENCED', '附件已用于消息，不能移除以免破坏历史分支')
    }
    await q.query(
      "UPDATE attachment SET status='deleted',deleted_at=COALESCE(deleted_at,NOW()),cleanup_pending=true,updated_at=NOW() WHERE id=$1",
      [c.req.param('id')]
    )
  })
  return c.json({ ok: true })
})

/** 归属/ready检查在会话写事务中完成；行共享锁防止引用过程中被移除。 */
export async function resolveAttachments(q: Queryable, userId: string, ids: string[]) {
  if (!ids.length) {
    return []
  }
  const unique = [...new Set(ids)]
  const result = await q.query<Row>(
    "SELECT * FROM attachment WHERE id=ANY($1::text[]) AND user_id=$2 AND status='ready' AND deleted_at IS NULL ORDER BY id FOR SHARE",
    [unique, userId]
  )
  if (result.rows.length !== unique.length) {
    error(404, 'ATTACHMENT_NOT_FOUND', '部分附件不存在、不可用或不属于当前账号')
  }
  const byId = new Map(result.rows.map((row) => [row.id, row]))
  return ids.map((id) => byId.get(id) as Row)
}

export async function attachmentMetadata(
  q: Queryable,
  userId: string,
  ids: string[]
): Promise<FileAttachment[]> {
  const rows = await resolveAttachments(q, userId, ids)
  return rows.map((row) => metadata(row))
}

/** provider id只出现在临时模型请求，持久化消息与SSE始终是业务附件ID。 */
export async function hydrateAttachmentMessages(
  q: Queryable,
  userId: string,
  messages: UserMessage[]
) {
  const ids = messages.flatMap((m) => m.files.map((f) => f.id))
  const rows = await resolveAttachments(q, userId, ids)
  const byId = new Map(rows.map((row) => [row.id, row]))
  let documents = 0,
    images = 0,
    imageBytes = 0
  for (const row of rows) {
    if (row.is_image) {
      images++
      imageBytes += Number(row.size_bytes)
    } else {
      documents++
    }
  }
  if (documents > 20 || images > 64 || imageBytes > 128 * 1024 * 1024) {
    error(
      413,
      'ATTACHMENT_CONTEXT_LIMIT',
      '当前上下文附件超过20份文档或图片数量/体积预算，请选择较短分支'
    )
  }
  return messages.map((m) => ({
    ...m,
    files: m.files.map((f) => {
      const row = byId.get(f.id) as Row
      return { ...metadata(row), serverId: row.provider_file_id }
    }),
  }))
}

export async function linkAttachments(q: Queryable, message: UserMessage) {
  for (const id of new Set(message.files.map((f) => f.id))) {
    await q.query(
      'INSERT INTO attachment_reference(attachment_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [id, message.id]
    )
  }
}

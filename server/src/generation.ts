import { attachmentMetadata, hydrateAttachmentMessages, linkAttachments } from './attachments.js'
import {
  bounded,
  boundedResponse,
  generationBudgets,
  GenerationFailure,
  type GenerationBudgets,
} from './generation-limits.js'
import { assertContextBudget } from './context-budget.js'
import { updateAttemptUsage, normalizeUsage } from './usage.js'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pool } from './db/client.js'
import { config } from './config.js'
import { sessionIsLive } from './auth-security.js'
import {
  HttpError,
  inTransaction,
  loadSession,
  saveSession,
  assertIdle,
  assertRevision,
} from './store.js'
import { appendBranch, getVisibleMessages } from '../../src/services/chat/branches.js'
import {
  applyEvent,
  settleReply,
  canContinueReply,
  getContextRounds,
  toRequestMessages,
} from '../../src/services/chat/reply.js'
import { readServerSentEvents } from '../../src/services/api/sse.js'
import { readMessageEvent } from '../../src/services/api/parseEvent.js'
import type { AssistantMessage, UserMessage, Message } from '../../src/services/chat/types.js'
import type { CreateMessageRequest } from '../../src/services/api/types.js'
// 客户端只能提交操作和开关，不能伪造用户归属、历史消息或上游工具参数。
export const generationInput = z
  .object({
    expectedRevision: z.number().int().nonnegative().optional(),
    operation: z.enum(['send', 'edit', 'regenerate', 'continue']),
    content: z.string().trim().max(32000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    messageId: z.string().max(128).optional(),
    parentId: z.string().max(128).nullable().optional(),
    thinking: z.boolean().default(false),
    search: z.boolean().default(false),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict()
export type GenerationInput = z.infer<typeof generationInput>
// 进程内索引仅加速取消，正确性仍依赖数据库的取消标记与运行状态。
const active = new Map<string, AbortController>()
export function cancelActive(id: string) {
  active.get(id)?.abort()
}
/** 短事务内锁定会话、检查幂等和分支、预建回答与账本；不在事务内请求模型。 */
export async function prepare(
  userId: string,
  conversationId: string,
  input: GenerationInput,
  authSessionId?: string
) {
  if (!config.deepseekKey) {
    throw new HttpError(503, '请在本机 .env 配置新的 DEEPSEEK_API_KEY')
  }
  return inTransaction(async (q) => {
    if (authSessionId && !(await sessionIsLive(q, userId, authSessionId))) {
      throw new HttpError(401, '登录已失效，请重新登录')
    }
    // 同一用户的幂等检查与创建串行化，覆盖不同会话复用同一个 key 的并发。
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [userId])
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          conversationId,
          input.operation,
          input.content ?? null,
          input.messageId ?? null,
          input.parentId ?? null,
          input.thinking,
          input.search,
          input.expectedRevision ?? null,
          input.attachmentIds ?? null,
        ])
      )
      .digest('hex')
    let session = await loadSession(q, userId, conversationId, true)
    const duplicate = await q.query(
      'SELECT id,status,conversation_id,request_hash FROM generation_run WHERE user_id=$1 AND idempotency_key=$2',
      [userId, input.idempotencyKey]
    )
    if (duplicate.rowCount) {
      const existing = duplicate.rows[0]
      if (!existing.request_hash) {
        throw new HttpError(
          409,
          '旧任务无法核验请求，请刷新会话查看结果',
          'IDEMPOTENCY_LEGACY_UNKNOWN'
        )
      }
      if (existing.request_hash !== requestHash) {
        throw new HttpError(409, '同一个请求标识不能用于不同内容', 'IDEMPOTENCY_CONFLICT')
      }
      return {
        replay: true as const,
        runId: existing.id as string,
        status: existing.status as string,
        conversationId: existing.conversation_id as string,
      }
    }
    assertRevision(session, input.expectedRevision)
    await assertIdle(q, conversationId)
    const recent = await q.query(
      "SELECT COUNT(*)::int AS n FROM generation_run WHERE user_id=$1 AND created_at>NOW()-INTERVAL '1 minute'",
      [userId]
    )
    if (recent.rows[0].n >= 10) {
      throw new HttpError(429, '调用过于频繁，请稍后再试')
    }
    if (input.attachmentIds && !['send', 'edit'].includes(input.operation)) {
      throw new HttpError(400, '此操作不能替换附件', 'INVALID_ATTACHMENT_OPERATION')
    }
    const newFiles = await attachmentMetadata(q, userId, input.attachmentIds ?? [])
    const path = getVisibleMessages(session)
    const now = Date.now()
    let history: Message[] = []
    let question: UserMessage
    let prefix: AssistantMessage | undefined
    let reply: AssistantMessage = {
      id: randomUUID(),
      role: 'assistant',
      createdAt: now,
      model: 'deepseek-flash',
      thinking: input.thinking,
      search: input.search,
      prefix: true,
      status: 'pending',
      blocks: [],
    }
    if (input.operation === 'send') {
      if (!input.content && !newFiles.length) {
        throw new HttpError(400, '消息不能为空')
      }
      const parent = path.at(-1)
      if (input.parentId !== undefined && input.parentId !== (parent?.id ?? null)) {
        throw new HttpError(409, '分支已变化，请刷新')
      }
      if (parent?.role === 'user') {
        throw new HttpError(409, '当前分支缺少回答')
      }
      history = path
      question = {
        id: randomUUID(),
        role: 'user',
        content: input.content ?? '',
        files: newFiles,
        createdAt: now,
      }
      session = appendBranch(session, parent?.id ?? null, [question, reply])
    } else {
      const index = path.findIndex((m) => m.id === input.messageId)
      if (index < 0) {
        throw new HttpError(404, '消息不在当前分支')
      }
      const target = path[index]
      if (input.operation === 'edit') {
        if (
          target.role !== 'user' ||
          (!input.content && !(input.attachmentIds === undefined ? target.files : newFiles).length)
        ) {
          throw new HttpError(400, '只能编辑用户文本消息')
        }
        history = path.slice(0, index)
        question = {
          ...target,
          id: randomUUID(),
          content: input.content ?? '',
          files: input.attachmentIds === undefined ? target.files : newFiles,
          createdAt: now,
          selectedChildId: undefined,
        }
        session = appendBranch(session, target.parentId ?? null, [question, reply])
      } else {
        if (target.role !== 'assistant' || path[index - 1]?.role !== 'user') {
          throw new HttpError(400, '请选择有效回答')
        }
        question = path[index - 1] as UserMessage
        history = path.slice(0, index - 1)
        if (input.operation === 'continue') {
          if (index !== path.length - 1 || !canContinueReply(target)) {
            throw new HttpError(400, '此回答不支持继续生成')
          }
          prefix = target
          reply = { ...target, status: 'pending', error: undefined }
          session = {
            ...session,
            messages: session.messages.map((m) => (m.id === reply.id ? reply : m)),
          }
        } else {
          session = appendBranch(session, question.id, [reply])
        }
      }
    }
    // 所有实际历史引用都重新核验归属与ready；重复文档按请求出现次数计入预算。
    const userMessages = [...getContextRounds(history).map(([user]) => user), question]
    const hydrated = await hydrateAttachmentMessages(q, userId, userMessages)
    const byId = new Map(hydrated.map((m) => [m.id, m]))
    const requestHistory = history.map((m) => (m.role === 'user' ? (byId.get(m.id) ?? m) : m))
    const requestQuestion = byId.get(question.id) as UserMessage
    // appendBranch 在节点副本上补齐 parent/selectedChild。
    // 后续流式更新必须使用树内权威节点，避免旧对象覆盖关系元数据。
    const linkedReply = session.messages.find((m) => m.id === reply.id)
    if (!linkedReply || linkedReply.role !== 'assistant') {
      throw new HttpError(500, '生成消息状态异常')
    }
    reply = linkedReply
    session.updatedAt = now
    const body: CreateMessageRequest & { max_tokens: number } = {
      model: 'deepseek-flash',
      max_tokens: config.maxTokens,
      system: '该助手为DeepSeek，由深度求索公司创造。',
      messages: toRequestMessages(
        requestHistory,
        requestQuestion,
        prefix,
        reply.thinking,
        reply.latestReminder
      ),
      thinking: { type: reply.thinking ? 'enabled' : 'disabled' },
      tools: [
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
        ...(reply.search
          ? [{ type: 'deepseek_web_search' as const, name: 'deepseek_web_search' as const }]
          : []),
      ],
      safety_check: { level: 'high' },
      title: { enabled: !session.title },
    }
    assertContextBudget(body)
    await saveSession(q, session)
    await linkAttachments(q, question)
    const runId = randomUUID()
    await q.query(
      "INSERT INTO generation_run(id,user_id,conversation_id,message_id,idempotency_key,operation,status,auth_session_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,'running',$7,$8)",
      [
        runId,
        userId,
        conversationId,
        reply.id,
        input.idempotencyKey,
        input.operation,
        authSessionId ?? null,
        requestHash,
      ]
    )
    await q.query('INSERT INTO usage_record(generation_id) VALUES($1)', [runId])
    return { replay: false as const, session, reply, runId, body, userId, authSessionId }
  })
}
/** 事务外消费上游；只有终态事务提交成功后才能向客户端宣布结果已保存。 */
export async function execute(
  prepared: Exclude<Awaited<ReturnType<typeof prepare>>, { replay: true }>,
  signal: AbortSignal,
  emit: (event: string, data: unknown) => Promise<void>,
  budgetOverrides: Partial<GenerationBudgets> = {}
) {
  const limits = { ...generationBudgets, ...budgetOverrides }
  const { runId } = prepared
  let session = prepared.session
  let reply: AssistantMessage = { ...prepared.reply, usage: undefined }
  let attemptUsage: Record<string, unknown> | null = null
  let sawFinalUsage = false
  let seenStop = false
  let refused = false
  let failure: GenerationFailure | undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  let finishing = false
  const fail = (error: GenerationFailure) => {
    if (finishing) {
      return
    }
    failure ??= error
    controller.abort()
  }
  active.set(runId, controller)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  const timer = setTimeout(() => fail(new GenerationFailure('TOTAL_TIMEOUT')), limits.totalMs)
  const current = () => ({
    ...session,
    updatedAt: Date.now(),
    messages: session.messages.map((m) => (m.id === reply.id ? reply : m)),
  })
  const publish = (event: string, data: unknown) =>
    bounded(emit(event, data), limits.clientWriteMs, 'CLIENT_SLOW', controller.signal)
  const writeUsage = async (
    q: Parameters<Parameters<typeof inTransaction>[0]>[0],
    complete: boolean
  ) => {
    const usage = normalizeUsage(attemptUsage, complete)
    await q.query(
      `UPDATE usage_record SET input_tokens=$2,cached_input_tokens=$3,output_tokens=$4,
       raw_usage=$5,completeness=$6,updated_at=NOW() WHERE generation_id=$1`,
      [
        runId,
        usage.input,
        usage.cached,
        usage.output,
        JSON.stringify(usage.raw),
        usage.completeness,
      ]
    )
  }
  // 检查点原子保存正文和本次用量；重启不会将已知用量误变成零。
  const checkpoint = async () => {
    try {
      await inTransaction(async (q) => {
        await q.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [session.id])
        const r = await q.query(
          "UPDATE generation_run SET heartbeat_at=NOW(),usage=$2 WHERE id=$1 AND status='running' RETURNING id",
          [runId, JSON.stringify(attemptUsage)]
        )
        if (!r.rowCount) {
          throw new GenerationFailure('LEASE_LOST')
        }
        await q.query('UPDATE message SET payload=$2 WHERE id=$1', [
          reply.id,
          JSON.stringify(reply),
        ])
        await writeUsage(q, false)
      })
    } catch (error) {
      throw error instanceof GenerationFailure
        ? error
        : new GenerationFailure('DATABASE_UNAVAILABLE')
    }
  }
  let heartbeatBusy = false
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) {
      return
    }
    heartbeatBusy = true
    void pool
      .query(
        "UPDATE generation_run SET heartbeat_at=NOW() WHERE id=$1 AND status='running' RETURNING id",
        [runId]
      )
      .then((r) => {
        if (!r.rowCount) {
          fail(new GenerationFailure('LEASE_LOST'))
        }
      })
      .catch(() => fail(new GenerationFailure('DATABASE_UNAVAILABLE')))
      .finally(() => {
        heartbeatBusy = false
      })
  }, limits.heartbeatMs)
  let pollBusy = false
  const poll = setInterval(() => {
    if (pollBusy) {
      return
    }
    pollBusy = true
    void pool
      .query(
        `SELECT r.cancel_requested,r.status,CASE WHEN r.auth_session_id IS NULL THEN true ELSE
      EXISTS(SELECT 1 FROM session s WHERE s.id=r.auth_session_id AND s.user_id=r.user_id AND s.expires_at>NOW())
      END AS session_live FROM generation_run r WHERE r.id=$1`,
        [runId]
      )
      .then((r) => {
        if (!r.rows[0] || r.rows[0].status !== 'running') {
          fail(new GenerationFailure('LEASE_LOST'))
        } else if (r.rows[0].session_live === false) {
          fail(new GenerationFailure('SESSION_EXPIRED'))
        } else if (r.rows[0].cancel_requested) {
          abort()
        }
      })
      .catch(() => fail(new GenerationFailure('DATABASE_UNAVAILABLE')))
      .finally(() => {
        pollBusy = false
      })
  }, limits.pollMs)
  let progressTimer: ReturnType<typeof setTimeout> | undefined
  const progress = () => {
    if (progressTimer) {
      clearTimeout(progressTimer)
    }
    progressTimer = setTimeout(() => fail(new GenerationFailure('IDLE_TIMEOUT')), limits.idleMs)
  }
  const indexes = new Map<number, number>()
  let lastSnapshot = 0
  let lastPersist = 0
  try {
    if (prepared.authSessionId) {
      let live: boolean
      try {
        live = await sessionIsLive(pool, prepared.userId, prepared.authSessionId)
      } catch {
        throw new GenerationFailure('DATABASE_UNAVAILABLE')
      }
      if (!live) {
        throw new GenerationFailure('SESSION_EXPIRED')
      }
    }
    // 预建任务可能在 execute 开始前已被取消/回收，不能再启动一次付费请求。
    try {
      const state = await pool.query(
        'SELECT status,cancel_requested FROM generation_run WHERE id=$1',
        [runId]
      )
      if (!state.rows[0] || state.rows[0].status !== 'running') {
        throw new GenerationFailure('LEASE_LOST')
      }
      if (state.rows[0].cancel_requested) {
        abort()
      }
    } catch (error) {
      throw error instanceof GenerationFailure
        ? error
        : new GenerationFailure('DATABASE_UNAVAILABLE')
    }
    controller.signal.throwIfAborted()
    await publish('snapshot', { session, runId })
    const response = await bounded(
      fetch('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.deepseekKey,
          'anthropic-beta': 'files-api-2025-04-14',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ ...prepared.body, stream: true }),
        signal: controller.signal,
      }),
      limits.connectMs,
      'CONNECT_TIMEOUT',
      controller.signal
    )
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new GenerationFailure(
        response.status === 401 || response.status === 403
          ? 'UPSTREAM_AUTH'
          : response.status === 429
            ? 'UPSTREAM_RATE_LIMIT'
            : 'UPSTREAM_UNAVAILABLE'
      )
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new GenerationFailure('STREAM_INTERRUPTED')
    }
    progress()
    for await (const frame of readServerSentEvents(
      boundedResponse(response.body, limits, controller.signal),
      controller.signal
    )) {
      if (frame.event === 'error') {
        throw new GenerationFailure('UPSTREAM_UNAVAILABLE')
      }
      let data: unknown
      try {
        data = JSON.parse(frame.data)
      } catch {
        continue
      }
      if (
        frame.event === 'error' ||
        (typeof data === 'object' && data !== null && 'error' in data)
      ) {
        throw new GenerationFailure('UPSTREAM_UNAVAILABLE')
      }
      const event = readMessageEvent(data)
      if (!event) {
        continue
      }
      if (event.type === 'message_delta' && event.usage) {
        sawFinalUsage = true
      }
      if (event.type !== 'ping') {
        progress()
      }
      attemptUsage = updateAttemptUsage(attemptUsage, event)
      reply = applyEvent(reply, event, Date.now(), indexes)
      const refusalEvent = event.type === 'message_delta' && event.delta.stop_reason === 'refusal'
      if (refusalEvent) {
        refused = true
        indexes.clear()
      }
      if (refused) {
        // 拒绝为单向状态，后续异常正文/结束原因不能重新暴露已清理文本。
        reply = {
          ...reply,
          stopReason: 'refusal',
          blocks: reply.blocks.filter(
            (block) => block.type !== 'text' && block.type !== 'thinking'
          ),
        }
      }
      if (refusalEvent) {
        // 不等待限频窗口或message_stop，立即用拒绝后的内容覆盖最近检查点。
        await checkpoint()
        lastPersist = Date.now()
        await publish('snapshot', { session: current(), runId })
        lastSnapshot = Date.now()
      }
      if (event.type === 'message_delta' && event.delta.title && !session.title) {
        session = { ...session, title: event.delta.title }
      }
      if (event.type === 'message_stop') {
        seenStop = true
        break
      }
      if (Date.now() - lastPersist > 1000) {
        await checkpoint()
        lastPersist = Date.now()
      }
      if (Date.now() - lastSnapshot > 80) {
        await publish('snapshot', { session: current(), runId })
        lastSnapshot = Date.now()
      }
    }
    if (!seenStop && !controller.signal.aborted) {
      throw new GenerationFailure('STREAM_INTERRUPTED')
    }
  } catch (error) {
    // 只允许固定业务错误进入数据库/UI；pg、网络及任意上游原文均不透传。
    if (error instanceof GenerationFailure) {
      failure ??= error
    } else if (!controller.signal.aborted) {
      failure ??= new GenerationFailure('STREAM_INTERRUPTED')
    }
    controller.abort()
  } finally {
    finishing = true
    if (progressTimer) {
      clearTimeout(progressTimer)
    }
    clearTimeout(timer)
    clearInterval(heartbeat)
    clearInterval(poll)
    signal.removeEventListener('abort', abort)
    active.delete(runId)
    try {
      await inTransaction(async (q) => {
        await q.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [session.id])
        // 取消和完成在同一行锁上线性化：先写入取消则停止，已提交完成则后来的取消不改终态。
        const locked = await q.query(
          'SELECT status,cancel_requested FROM generation_run WHERE id=$1 FOR UPDATE',
          [runId]
        )
        if (!locked.rows[0] || locked.rows[0].status !== 'running') {
          throw new GenerationFailure('LEASE_LOST')
        }
        const cancelled = locked.rows[0].cancel_requested
        if (cancelled) {
          failure = undefined
        }
        const status = cancelled ? 'stopped' : failure ? 'error' : seenStop ? 'done' : 'stopped'
        reply = settleReply(
          reply,
          status,
          Date.now(),
          failure ? { kind: 'stream', message: failure.message } : undefined
        )
        session = current()
        const updated = await q.query(
          "UPDATE generation_run SET status=$2,usage=$3,error=$4,finished_at=NOW(),heartbeat_at=NOW() WHERE id=$1 AND status='running' RETURNING id",
          [runId, status, JSON.stringify(attemptUsage), failure?.code ?? null]
        )
        if (!updated.rowCount) {
          throw new GenerationFailure('LEASE_LOST')
        }
        await writeUsage(q, status === 'done' && sawFinalUsage)
        await q.query('UPDATE message SET payload=$2 WHERE id=$1', [
          reply.id,
          JSON.stringify(reply),
        ])
        const saved = await q.query(
          "UPDATE conversation SET title=CASE WHEN title='' THEN $2 ELSE title END,updated_at=NOW(),version=version+1 WHERE id=$1 RETURNING version,updated_at",
          [session.id, session.title]
        )
        session.revision = saved.rows[0].version
        session.updatedAt = saved.rows[0].updated_at.getTime()
      })
      await bounded(
        emit(failure ? 'error' : 'done', {
          session,
          runId,
          ...(failure ? { code: failure.code, message: failure.message } : {}),
        }),
        limits.clientWriteMs,
        'CLIENT_SLOW'
      ).catch(() => {})
    } catch (error) {
      const safe = error instanceof GenerationFailure ? error : new GenerationFailure('SAVE_FAILED')
      // 终态事务失败/失去租约不能携未提交session，更不能发done。
      await bounded(
        emit('error', { runId, code: safe.code, message: safe.message }),
        limits.clientWriteMs,
        'CLIENT_SLOW'
      ).catch(() => {})
    }
  }
}

import { ContextBudgetExceededError } from './context-budget.js'
import { branchView, loadBranch } from './branch-view.js'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { auth } from './auth.js'
import { config } from './config.js'
import {
  trustedPeer,
  registrationPolicy,
  applyAuthLimits,
  enabledAuthPaths,
} from './auth-security.js'
import {
  listConversationPage,
  parseConversationPagination,
  PaginationError,
} from './conversation-pagination.js'
import { pool } from './db/client.js'
import {
  HttpError,
  inTransaction,
  loadSession,
  saveSession,
  assertIdle,
  assertRevision,
  recoverStale,
} from './store.js'
import { generationInput, prepare, execute, cancelActive } from './generation.js'
import { selectVersion } from '../../src/services/chat/branches.js'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
export const app = new Hono<{ Variables: { userId: string; sessionId: string } }>()
// 请求体上限先于认证与业务解析执行，避免无界读取。
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: { message: '请求内容过大' } }, 413),
  })
)
app.use('/api/*', async (c, next) => {
  // 私有会话不允许中间缓存；写请求必须来自配置的同源前端。
  c.header('Cache-Control', 'no-store')
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    c.req.header('Origin') !== config.origin
  ) {
    return c.json({ error: { message: '不允许此请求来源' } }, 403)
  }
  return next()
})
app.get('/api/health', (c) => c.json({ ok: true, mode: 'local-development' }))
// 认证路由先交给 Better Auth；后续业务路由统一要求有效会话。
app.get('/api/auth-policy', (c) => c.json(registrationPolicy(trustedPeer(c))))
app.all('/api/auth/*', async (c) => {
  const peer = trustedPeer(c)
  const path = c.req.path.slice('/api/auth'.length).replace(/\/+$/, '')
  if (!enabledAuthPaths.has(path)) {
    return c.json({ error: { message: '此认证功能未启用' } }, 404)
  }
  if (path === '/sign-up/email' && !registrationPolicy(peer).registrationEnabled) {
    return c.json({ error: { code: 'REGISTRATION_DISABLED', message: '当前未开放注册' } }, 403)
  }
  const limit = await applyAuthLimits(pool, peer, path, c.req.raw)
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter))
    return c.json({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' } }, 429)
  }
  const previous =
    path === '/sign-out' ? await auth.api.getSession({ headers: c.req.raw.headers }) : null
  const response = await auth.handler(c.req.raw)
  if (path === '/sign-up/email' && !response.ok) {
    return c.json(
      { error: { code: 'SIGNUP_FAILED', message: '无法完成注册，请检查输入或使用已有账号登录' } },
      400
    )
  }
  if (previous && response.ok) {
    // 注销先由认证库撤销 Cookie/session，再尽快中断当前会话发起的生成。
    // 即便此更新失败，生成任务也会通过 session 轮询发现撤销并自行结束。
    try {
      const runs = await pool.query(
        "UPDATE generation_run SET cancel_requested=true WHERE auth_session_id=$1 AND user_id=$2 AND status='running' RETURNING id",
        [previous.session.id, previous.user.id]
      )
      for (const run of runs.rows) {
        cancelActive(run.id)
      }
    } catch {
      process.stderr.write('注销后的生成取消更新失败，将由会话轮询收尾\n')
    }
  }
  return response
})
app.use('/api/*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ error: { message: '请先登录' } }, 401)
  }
  c.set('userId', session.user.id)
  c.set('sessionId', session.session.id)
  return next()
})
app.get('/api/conversations', async (c) => {
  const query = new URL(c.req.url).searchParams
  const pagination = parseConversationPagination(query)
  const legacy = !query.has('limit') && !query.has('cursor')
  await recoverStale(c.get('userId'))
  const page = await listConversationPage(
    pool,
    c.get('userId'),
    legacy ? { limit: 200, cursor: null } : pagination
  )
  // 分页导航尚未接入前端：无分页参数保留旧数组契约，显式参数返回分页对象。
  return c.json(legacy ? page.items : page)
})
app.post('/api/conversations', async (c) => {
  const body = z
    .object({ title: z.string().max(200).optional() })
    .strict()
    .parse(await c.req.json())
  const id = randomUUID()
  await pool.query('INSERT INTO conversation(id,user_id,title) VALUES($1,$2,$3)', [
    id,
    c.get('userId'),
    body.title ?? '',
  ])
  return c.json(await loadSession(pool, c.get('userId'), id), 201)
})
app.get('/api/conversations/:id', async (c) => {
  await recoverStale(c.get('userId'))
  if (c.req.query('view') === 'branch') {
    return c.json(
      await loadBranch(pool, c.get('userId'), c.req.param('id'), c.req.query('beforeId'))
    )
  }
  return c.json(await loadSession(pool, c.get('userId'), c.req.param('id')))
})
app.patch('/api/conversations/:id', async (c) => {
  const body = z
    .object({
      expectedRevision: z.number().int().nonnegative(),
      title: z.string().max(200).optional(),
      selectedMessageId: z.string().max(128).optional(),
    })
    .strict()
    .parse(await c.req.json())
  const session = await inTransaction(async (q) => {
    let s = await loadSession(q, c.get('userId'), c.req.param('id'), true)
    assertRevision(s, body.expectedRevision)
    await assertIdle(q, s.id)
    if (body.title !== undefined) {
      s = { ...s, title: body.title }
    }
    if (body.selectedMessageId !== undefined) {
      if (!s.messages.some((m) => m.id === body.selectedMessageId)) {
        throw new HttpError(404, '消息不存在')
      }
      s = selectVersion(s, body.selectedMessageId)
    }
    s.updatedAt = Date.now()
    await saveSession(q, s)
    return s
  })
  return c.json(c.req.query('view') === 'branch' ? branchView(session) : session)
})
// 用户删除会话只做软删；生成中的会话必须先停止，避免并发写入。
app.delete('/api/conversations/:id', async (c) => {
  const body = z
    .object({ expectedRevision: z.number().int().nonnegative() })
    .strict()
    .parse(await c.req.json())
  await inTransaction(async (q) => {
    const s = await loadSession(q, c.get('userId'), c.req.param('id'), true)
    assertRevision(s, body.expectedRevision)
    await assertIdle(q, s.id)
    await q.query('UPDATE conversation SET deleted_at=NOW() WHERE id=$1', [s.id])
  })
  return c.body(null, 204)
})
app.post('/api/conversations/:id/generations', async (c) => {
  const input = generationInput
    .extend({ expectedRevision: z.number().int().nonnegative() })
    .parse(await c.req.json())
  await recoverStale(c.get('userId'))
  const task = await prepare(c.get('userId'), c.req.param('id'), input, c.get('sessionId'))
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const abort = new AbortController()
    stream.onAbort(() => abort.abort())
    await execute(task, abort.signal, async (event, data) => {
      const payload = data as { session?: Parameters<typeof branchView>[0] }
      const output =
        c.req.query('view') === 'branch' && payload.session
          ? { ...payload, session: branchView(payload.session) }
          : payload
      await stream.writeSSE({ event, data: JSON.stringify(output) })
    })
  })
})
// 先持久化取消标记，再尝试中止本进程任务；其他实例通过轮询感知。
app.post('/api/generations/:id/cancel', async (c) => {
  const r = await pool.query(
    "UPDATE generation_run SET cancel_requested=true WHERE id=$1 AND user_id=$2 AND status='running' RETURNING id",
    [c.req.param('id'), c.get('userId')]
  )
  if (!r.rowCount) {
    const exists = await pool.query('SELECT id FROM generation_run WHERE id=$1 AND user_id=$2', [
      c.req.param('id'),
      c.get('userId'),
    ])
    if (!exists.rowCount) {
      throw new HttpError(404, '生成任务不存在')
    }
  }
  cancelActive(c.req.param('id'))
  return c.json({ ok: true })
})
app.onError((error, c) => {
  if (error instanceof ContextBudgetExceededError) {
    return c.json({ error: { code: 'CONTEXT_BUDGET_EXCEEDED', message: error.message } }, 413)
  }
  if (error instanceof PaginationError) {
    return c.json({ error: { message: error.message } }, 400)
  }
  if (error instanceof z.ZodError) {
    return c.json({ error: { message: '参数格式不正确' } }, 400)
  }
  if (error instanceof HttpError) {
    return c.json(
      { error: { message: error.message, ...(error.code ? { code: error.code } : {}) } },
      error.status as ContentfulStatusCode
    )
  }
  // 日志不记录请求头、凭据、连接串或上游正文，只保留错误类型。
  process.stderr.write(`API request failed: ${error.name}\n`)
  return c.json({ error: { message: '服务暂时不可用，请稍后重试' } }, 500)
})

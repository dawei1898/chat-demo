import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { auth } from './auth.js'
import { config } from './config.js'
import { pool } from './db/client.js'
import {
  HttpError,
  inTransaction,
  loadSession,
  saveSession,
  assertIdle,
  recoverStale,
} from './store.js'
import { generationInput, prepare, execute, cancelActive } from './generation.js'
import { selectVersion } from '../../src/services/chat/branches.js'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
export const app = new Hono<{ Variables: { userId: string } }>()
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: { message: '请求内容过大' } }, 413),
  })
)
app.use('/api/*', async (c, next) => {
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
app.all('/api/auth/*', (c) => auth.handler(c.req.raw))
app.use('/api/*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ error: { message: '请先登录' } }, 401)
  }
  c.set('userId', session.user.id)
  return next()
})
app.get('/api/conversations', async (c) => {
  await recoverStale(c.get('userId'))
  const r = await pool.query(
    'SELECT id,title,created_at,updated_at FROM conversation WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200',
    [c.get('userId')]
  )
  return c.json(
    r.rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at.getTime(),
      updatedAt: r.updated_at.getTime(),
    }))
  )
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
  return c.json(await loadSession(pool, c.get('userId'), c.req.param('id')))
})
app.patch('/api/conversations/:id', async (c) => {
  const body = z
    .object({
      title: z.string().max(200).optional(),
      selectedMessageId: z.string().max(128).optional(),
    })
    .strict()
    .parse(await c.req.json())
  const session = await inTransaction(async (q) => {
    let s = await loadSession(q, c.get('userId'), c.req.param('id'), true)
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
  return c.json(session)
})
app.delete('/api/conversations/:id', async (c) => {
  await inTransaction(async (q) => {
    const s = await loadSession(q, c.get('userId'), c.req.param('id'), true)
    await assertIdle(q, s.id)
    await q.query('UPDATE conversation SET deleted_at=NOW() WHERE id=$1', [s.id])
  })
  return c.body(null, 204)
})
app.post('/api/conversations/:id/generations', async (c) => {
  const input = generationInput.parse(await c.req.json())
  await recoverStale(c.get('userId'))
  const task = await prepare(c.get('userId'), c.req.param('id'), input)
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const abort = new AbortController()
    stream.onAbort(() => abort.abort())
    await execute(task, abort.signal, async (event, data) => {
      await stream.writeSSE({ event, data: JSON.stringify(data) })
    })
  })
})
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
  if (error instanceof z.ZodError) {
    return c.json({ error: { message: '参数格式不正确' } }, 400)
  }
  if (error instanceof HttpError) {
    return c.json({ error: { message: error.message } }, error.status as ContentfulStatusCode)
  }
  // Never log request headers, credentials, connection URLs or upstream bodies.
  process.stderr.write(`API request failed: ${error.name}\n`)
  return c.json({ error: { message: '服务暂时不可用，请稍后重试' } }, 500)
})

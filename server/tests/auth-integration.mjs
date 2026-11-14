// 实际 Better Auth handler + Neon dev；所有账号、会话、限流和业务写入均在隔离schema事务中回滚。
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { app } from '../src/app.ts'
import { pool } from '../src/db/client.ts'
import { config } from '../src/config.ts'
import { authRateKey, consumeAuthRate } from '../src/auth-security.ts'
import { prepare, execute } from '../src/generation.ts'
if (process.env.RUN_NEON_DEV_INTEGRATION !== '1') {
  throw new Error('Explicit dev integration opt-in required')
}
const url = process.env.DATABASE_URL_UNPOOLED
if (!url || new URL(url).hostname !== 'ep-icy-lab-aodlx62h.c-2.ap-southeast-1.aws.neon.tech') {
  throw new Error('Non-dev endpoint refused')
}
const client = new pg.Client({ connectionString: url })
const schema = 'p2_auth_' + randomUUID().replaceAll('-', '')
const oldQuery = pool.query,
  oldConnect = pool.connect,
  oldFetch = globalThis.fetch,
  oldModelKey = config.deepseekKey
const oldMode = process.env.REGISTRATION_MODE
const origin = config.origin
const environment = {
  incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 10000, remoteFamily: 'IPv4' } },
}
const password = randomUUID() + '!'
let stage = 'setup',
  count = 0,
  txDepth = 0
function pass(name) {
  count++
  process.stdout.write(`PASS ${name}\n`)
}
async function req(
  path,
  { method = 'GET', body, cookie = '', headers = {}, env = environment } = {}
) {
  // 本脚本聚焦认证，业务写请求使用当前权威 revision；并发冲突在 P3 专项验证。
  const match = path.match(/^\/api\/conversations\/([^/?]+)(?:\/generations)?$/)
  if (match && ['PATCH', 'DELETE', 'POST'].includes(method)) {
    const row = await client.query('SELECT version FROM conversation WHERE id=$1', [match[1]])
    if (row.rows[0]) {
      body = { ...body, expectedRevision: row.rows[0].version }
    }
  }
  return app.request(
    origin + path,
    {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  )
}
const cookieOf = (r) =>
  r.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ')
async function login(email) {
  const response = await req('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email, password },
  })
  assert.equal(response.status, 200, 'login failed')
  return cookieOf(response)
}
try {
  process.env.REGISTRATION_MODE = 'local'
  await client.connect()
  await client.query('BEGIN')
  await client.query(`CREATE SCHEMA "${schema}"`)
  await client.query(`SET LOCAL search_path TO "${schema}"`)
  await client.query("SET LOCAL statement_timeout='15s';SET LOCAL lock_timeout='3s'")
  const journal = JSON.parse(
    await readFile(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')
  )
  for (const entry of journal.entries) {
    const sql = (
      await readFile(new URL(`../../migrations/${entry.tag}.sql`, import.meta.url), 'utf8')
    ).replaceAll('"public".', `"${schema}".`)
    for (const part of sql.split('--> statement-breakpoint')) {
      if (part.trim()) {
        await client.query(part)
      }
    }
  }
  const query = async (sql, values) => {
    const text = typeof sql === 'string' ? sql : sql.text
    if (/^begin\b/i.test(text)) {
      txDepth++
      return client.query('SAVEPOINT nested_' + txDepth)
    }
    if (/^commit\b/i.test(text)) {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      const result = await client.query('RELEASE SAVEPOINT nested_' + txDepth)
      txDepth--
      await client.query('SET CONSTRAINTS ALL DEFERRED')
      return result
    }
    if (/^rollback\b/i.test(text)) {
      await client.query('ROLLBACK TO SAVEPOINT nested_' + txDepth)
      const result = await client.query('RELEASE SAVEPOINT nested_' + txDepth)
      txDepth--
      return result
    }
    // 保留 Drizzle 的 query config、rowMode 和类型解析，不把配置对象误当 SQL 文本。
    return client.query(sql, values)
  }
  pool.query = query
  pool.connect = async () => ({ query, release() {} })
  stage = 'registration policy'
  assert.equal((await (await req('/api/auth-policy')).json()).registrationEnabled, true)
  const remote = {
    incoming: {
      socket: { remoteAddress: '203.0.113.10', remotePort: 10001, remoteFamily: 'IPv4' },
    },
  }
  assert.equal(
    (
      await req('/api/auth/sign-up/email', {
        method: 'POST',
        body: { email: 'remote@example.test', password, name: 'test' },
        env: remote,
        headers: { 'X-Forwarded-For': '127.0.0.1' },
      })
    ).status,
    403
  )
  process.env.REGISTRATION_MODE = 'closed'
  assert.equal((await req('/api/auth/sign-up/email', { method: 'POST', body: {} })).status, 403)
  process.env.REGISTRATION_MODE = 'local'
  pass('本机注册策略、closed开关和伪造XFF拒绝')
  stage = 'real auth signup'
  const signup = await req('/api/auth/sign-up/email', {
    method: 'POST',
    body: { name: 'isolated-a', email: 'a@example.test', password },
  })
  assert.equal(signup.status, 200)
  assert.equal(signup.headers.getSetCookie().length, 0)
  assert.equal((await signup.json()).token, null)
  let cookieA = await login('a@example.test')
  const firstCookieA = cookieA
  assert.ok(cookieA)
  const a = await (await req('/api/auth/get-session', { cookie: cookieA })).json()
  assert.ok(a.user.id && a.session.id)
  assert.equal((await client.query('SELECT count(*)::int n FROM account')).rows[0].n, 1)
  const loginForCookie = await req('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: 'a@example.test', password },
  })
  const sessionCookie = loginForCookie.headers
    .getSetCookie()
    .find((v) => v.includes('session_token'))
  assert.match(sessionCookie, /HttpOnly/i)
  assert.match(sessionCookie, /SameSite=Lax/i)
  pass('真实注册、密码账户和HttpOnly SameSite会话Cookie')
  stage = 'signup duplicate and login'
  const duplicate = await req('/api/auth/sign-up/email', {
    method: 'POST',
    body: { name: 'other', email: 'a@example.test', password },
  })
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.headers.getSetCookie().length, 0)
  const duplicateData = await duplicate.json()
  assert.equal(duplicateData.token, null)
  assert.notEqual(duplicateData.user.id, a.user.id)
  assert.equal(duplicateData.user.name, 'other')
  assert.equal((await client.query('SELECT count(*)::int n FROM "user"')).rows[0].n, 1)
  assert.equal(
    (
      await req('/api/auth/sign-in/email', {
        method: 'POST',
        body: { email: 'a@example.test', password: 'wrong-password' },
      })
    ).status,
    401
  )
  cookieA = await login('a@example.test')
  pass('重复注册统一文案、错误密码拒绝、正确登录成功')
  stage = 'Origin and ownership'
  assert.equal(
    (
      await req('/api/conversations', {
        method: 'POST',
        cookie: cookieA,
        body: {},
        headers: { Origin: 'https://evil.invalid' },
      })
    ).status,
    403
  )
  assert.equal((await req('/api/conversations')).status, 401)
  const created = await req('/api/conversations', {
    method: 'POST',
    cookie: cookieA,
    body: { title: 'isolated' },
  })
  assert.equal(created.status, 201)
  const conversation = await created.json()
  const signupB = await req('/api/auth/sign-up/email', {
    method: 'POST',
    body: { name: 'isolated-b', email: 'b@example.test', password },
  })
  assert.equal(signupB.status, 200)
  const cookieB = await login('b@example.test')
  assert.equal(
    (await req('/api/conversations/' + conversation.id, { cookie: cookieB })).status,
    404
  )
  assert.equal(
    (
      await req('/api/conversations/' + conversation.id, {
        method: 'PATCH',
        cookie: cookieB,
        body: { title: 'unauthorized' },
      })
    ).status,
    404
  )
  pass('未登录、跨用户读写和伪造Origin拒绝')
  stage = 'session expiry'
  const activeA = await (await req('/api/auth/get-session', { cookie: cookieA })).json()
  await client.query("UPDATE session SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [
    activeA.session.id,
  ])
  assert.equal((await req('/api/conversations', { cookie: cookieA })).status, 401)
  cookieA = await login('a@example.test')
  const renewedA = await (await req('/api/auth/get-session', { cookie: cookieA })).json()
  pass('数据库会话过期立即使受保护API返回401')
  stage = 'session revoke'
  const revoke = await req('/api/auth/revoke-other-sessions', {
    method: 'POST',
    cookie: cookieA,
    body: {},
  })
  assert.equal(revoke.status, 200)
  assert.equal((await req('/api/conversations', { cookie: firstCookieA })).status, 401)
  pass('真实撤销其他会话后旧Cookie不可继续访问')
  stage = 'generation session expiry'
  config.deepseekKey = 'mock-only-no-provider-requests'
  globalThis.fetch = async (_url, init) => {
    init.signal.throwIfAborted()
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"isolated partial"}}\n\n'
            )
          )
          init.signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('Stopped', 'AbortError')),
            { once: true }
          )
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const input = {
    operation: 'send',
    content: 'isolated',
    parentId: null,
    thinking: false,
    search: false,
    idempotencyKey: randomUUID(),
  }
  const task = await prepare(renewedA.user.id, conversation.id, input, renewedA.session.id)
  let invalidated = false
  const events = []
  await execute(task, new AbortController().signal, async (name, data) => {
    events.push({ name, data })
    if (
      !invalidated &&
      name === 'snapshot' &&
      data.session.messages.some((m) => m.role === 'assistant' && m.blocks.length)
    ) {
      invalidated = true
      await client.query("UPDATE session SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [
        renewedA.session.id,
      ])
    }
  })
  assert.ok(events.some((e) => e.name === 'error' && e.data.code === 'SESSION_EXPIRED'))
  assert.equal(
    (await client.query('SELECT status FROM generation_run WHERE id=$1', [task.runId])).rows[0]
      .status,
    'error'
  )
  pass('真实会话过期被运行中生成察觉并保存部分内容')
  stage = 'logout cancels session generation'
  cookieA = await login('a@example.test')
  const finalA = await (await req('/api/auth/get-session', { cookie: cookieA })).json()
  const nextConversation = await (
    await req('/api/conversations', { method: 'POST', cookie: cookieA, body: {} })
  ).json()
  const task2 = await prepare(
    finalA.user.id,
    nextConversation.id,
    { ...input, idempotencyKey: randomUUID() },
    finalA.session.id
  )
  let loggedOut = false
  await execute(task2, new AbortController().signal, async (name) => {
    if (!loggedOut && name === 'snapshot') {
      loggedOut = true
      assert.equal(
        (await req('/api/auth/sign-out', { method: 'POST', cookie: cookieA, body: {} })).status,
        200
      )
    }
  })
  assert.equal((await req('/api/conversations', { cookie: cookieA })).status, 401)
  const cancelled = (
    await client.query('SELECT status,cancel_requested FROM generation_run WHERE id=$1', [
      task2.runId,
    ])
  ).rows[0]
  assert.equal(cancelled.status, 'stopped')
  assert.equal(cancelled.cancel_requested, true)
  pass('真实注销撤销Cookie并取消同会话生成')
  stage = 'persistent login rate limit'
  const limitKey = authRateKey('login-email', 'blocked@example.test')
  const decisions = await Promise.all(
    Array.from({ length: 12 }, () => consumeAuthRate(pool, limitKey, 10, 300))
  )
  assert.equal(decisions.filter((x) => x.allowed).length, 10)
  const limited = await req('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: 'blocked@example.test', password },
    headers: { 'X-Forwarded-For': '192.0.2.99' },
  })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('Retry-After')) > 0)
  assert.equal((await limited.json()).error.code, 'RATE_LIMITED')
  await client.query("UPDATE auth_rate_limit SET reset_at=NOW()-INTERVAL '1 second' WHERE key=$1", [
    limitKey,
  ])
  assert.equal((await consumeAuthRate(pool, limitKey, 10, 300)).allowed, true)
  pass('持久原子限流、429 Retry-After和过期窗口重置')
  stage = 'disabled endpoints'
  for (const endpoint of ['request-password-reset', 'verify-email', 'sign-in/social']) {
    assert.equal((await req('/api/auth/' + endpoint, { method: 'POST', body: {} })).status, 404)
  }
  pass('已取消认证功能没有可用API链路')
  await client.query('ROLLBACK')
  assert.equal(
    (await client.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1', [schema]))
      .rows[0].n,
    0
  )
  pass('所有新账号、会话、限流和业务数据随schema回滚，无public残留')
  process.stdout.write(`Auth integration: ${count} checks passed\n`)
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  process.stderr.write(`Auth integration failed at ${stage}; code=${error.code ?? error.name}\n`)
  process.exitCode = 1
} finally {
  pool.query = oldQuery
  pool.connect = oldConnect
  globalThis.fetch = oldFetch
  config.deepseekKey = oldModelKey
  if (oldMode === undefined) {
    delete process.env.REGISTRATION_MODE
  } else {
    process.env.REGISTRATION_MODE = oldMode
  }
  await client.end()
  await pool.end()
}

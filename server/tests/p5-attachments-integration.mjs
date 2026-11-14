// 附件只用模拟供应商；真实dev随机schema事务回滚，不读写public业务数据。
// Opt-in Neon dev test: isolated schema and one outer rollback; no model requests.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { pool } from '../src/db/client.ts'
import { config } from '../src/config.ts'
import { prepare } from '../src/generation.ts'
import { loadSession } from '../src/store.ts'
import { Hono } from 'hono'
import { attachmentRoutes } from '../src/attachments.ts'
if (process.env.RUN_NEON_DEV_INTEGRATION !== '1') {
  throw new Error('Explicit dev test opt-in required')
}
const url = process.env.DATABASE_URL_UNPOOLED
if (!url || new URL(url).hostname !== 'ep-icy-lab-aodlx62h.c-2.ap-southeast-1.aws.neon.tech') {
  throw new Error('Non-dev endpoint refused')
}
const client = new pg.Client({ connectionString: url })
const schema = 'p5_attachment_' + randomUUID().replaceAll('-', '')
const oldFetch = globalThis.fetch
const oldConnect = pool.connect
const oldQuery = pool.query
const oldKey = config.deepseekKey
let stage = 'setup'
try {
  await client.connect()
  await client.query('BEGIN')
  await client.query(`CREATE SCHEMA "${schema}"`)
  await client.query(`SET LOCAL search_path TO "${schema}"`)
  const journal = JSON.parse(
    await readFile(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')
  )
  for (const entry of journal.entries) {
    const name = entry.tag + '.sql'
    const sql = (
      await readFile(new URL('../../migrations/' + name, import.meta.url), 'utf8')
    ).replaceAll('"public".', `"${schema}".`)
    for (const part of sql.split('--> statement-breakpoint')) {
      if (part.trim()) {
        await client.query(part)
      }
    }
  }
  await client.query(`INSERT INTO "user"(id,name,email) VALUES('u','fixture','usage@example.test')`)
  await client.query(`INSERT INTO conversation(id,user_id) VALUES('c','u')`)
  const query = async (sql, values) => {
    if (sql === 'BEGIN') {
      await client.query('SAVEPOINT app_transaction')
      return client.query('SET CONSTRAINTS ALL DEFERRED')
    }
    if (sql === 'COMMIT') {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      return client.query('RELEASE SAVEPOINT app_transaction')
    }
    if (sql === 'ROLLBACK') {
      await client.query('ROLLBACK TO SAVEPOINT app_transaction')
      return client.query('RELEASE SAVEPOINT app_transaction')
    }
    return client.query(sql, values)
  }
  pool.query = query
  pool.connect = async () => ({ query, release() {} })
  config.deepseekKey = 'mock-only'

  await client.query(
    `INSERT INTO "user"(id,name,email) VALUES('other','other','other@example.test')`
  )
  await client.query("INSERT INTO conversation(id,user_id) VALUES('other-c','other')")
  await client.query(
    "INSERT INTO session(id,token,user_id,expires_at) VALUES('test','test-token','u',NOW()+INTERVAL '1 hour')"
  )
  const app = new Hono()
  app.onError((error, c) =>
    c.json({ error: { code: error.code, message: 'test error' } }, error.status ?? 500)
  )
  let actor = 'u'
  app.use('*', async (c, next) => {
    c.set('userId', actor)
    c.set('sessionId', 'test')
    await next()
  })
  app.route('/api/attachments', attachmentRoutes)
  let providerMode = 'success'
  let uploadCalls = 0
  const remote = 'file-private-provider-only'
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/files')
    assert.equal(init.method, 'POST')
    uploadCalls++
    const headers = new Headers(init.headers)
    assert.equal(headers.get('anthropic-beta'), 'files-api-2025-04-14')
    const keys = [...init.body.keys()]
    assert.ok(keys.indexOf('purpose') < keys.indexOf('file'))
    assert.equal(init.body.get('purpose'), 'user_data')
    if (providerMode === '5xx') {
      return new Response('private', { status: 500 })
    }
    if (providerMode === 'unknown') {
      throw new Error('private transport detail')
    }
    return Response.json({
      id: uploadCalls === 1 ? remote : remote + uploadCalls,
      type: 'file',
      size_bytes: 5,
      filename: 'test.txt',
      mime_type: 'text/plain',
      created_at: new Date().toISOString(),
    })
  }
  const upload = async (key, text = 'hello') => {
    const body = new FormData()
    body.set('uploadKey', key)
    body.set('file', new File([text], 'test.txt', { type: 'text/plain' }))
    return app.request('/api/attachments', { method: 'POST', body })
  }
  stage = 'upload and replay'
  const key = randomUUID()
  const response = await upload(key)
  assert.equal(response.status, 201)
  const meta = await response.json()
  assert.ok(meta.id)
  assert.equal(meta.serverId, null)
  assert.ok(!JSON.stringify(meta).includes(remote))
  assert.equal((await upload(key)).status, 200)
  assert.equal(uploadCalls, 1)
  assert.equal((await upload(key, 'different')).status, 409)
  assert.equal(uploadCalls, 1)
  stage = 'owner isolation'
  actor = 'other'
  assert.equal((await app.request('/api/attachments/' + meta.id)).status, 404)
  await assert.rejects(() =>
    prepare('other', 'other-c', {
      operation: 'send',
      content: 'x',
      thinking: false,
      search: false,
      idempotencyKey: randomUUID(),
      attachmentIds: [meta.id],
    })
  )
  actor = 'u'
  stage = 'generation private resolution'
  const task = await prepare('u', 'c', {
    operation: 'send',
    content: 'read',
    thinking: false,
    search: false,
    idempotencyKey: randomUUID(),
    attachmentIds: [meta.id],
  })
  assert.equal(task.replay, false)
  assert.ok(JSON.stringify(task.body).includes(remote))
  const saved = await loadSession(pool, 'u', 'c')
  assert.ok(!JSON.stringify(saved).includes(remote))
  assert.ok(!JSON.stringify(task.session).includes(remote))
  assert.equal((await app.request('/api/attachments/' + meta.id, { method: 'DELETE' })).status, 409)
  stage = 'unknown not automatically retried'
  providerMode = 'unknown'
  const uncertainKey = randomUUID()
  const uncertain = await upload(uncertainKey)
  assert.ok(uncertain.status >= 400)
  const count = uploadCalls
  await upload(uncertainKey)
  assert.equal(uploadCalls, count)
  stage = 'soft deletion'
  providerMode = 'success'
  const extra = await (await upload(randomUUID())).json()
  assert.equal(
    (await app.request('/api/attachments/' + extra.id, { method: 'DELETE' })).status < 300,
    true
  )
  const deleted = await app.request('/api/attachments/' + extra.id)
  assert.ok(deleted.status === 404 || (await deleted.json()).status === 'deleted')
  stage = '5xx conservatively unknown'
  providerMode = '5xx'
  const errorKey = randomUUID()
  await upload(errorKey)
  const unknown = (
    await client.query('SELECT status,cleanup_pending FROM attachment WHERE upload_key=$1', [
      errorKey,
    ])
  ).rows[0]
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.cleanup_pending, true)
  const priorCalls = uploadCalls
  await upload(errorKey)
  assert.equal(uploadCalls, priorCalls)
  stage = 'failed attempts still rate limited'
  await client.query(`INSERT INTO attachment(id,user_id,upload_key,content_hash,name,size_bytes,mime_type,is_image,purpose,status)
   SELECT 'rate-'||i,'u','rate-key-'||i,'hash','fixture.txt',1,'text/plain',false,'user_data','failed' FROM generate_series(1,10) i`)
  const rateLimited = await upload(randomUUID())
  assert.equal(rateLimited.status, 429)
  assert.equal((await rateLimited.json()).error.code, 'ATTACHMENT_RATE_LIMIT')
  assert.equal(uploadCalls, priorCalls)
  // 隔离限频与容量断言，不能把限频拒绝误当容量配额通过。
  await client.query("UPDATE attachment SET created_at=NOW()-INTERVAL '2 minutes'")
  stage = 'soft deleted and unknown count toward quota'
  await client.query(`INSERT INTO attachment(id,user_id,upload_key,content_hash,name,size_bytes,mime_type,is_image,purpose,status,cleanup_pending,created_at)
   SELECT 'quota-'||i,'u','quota-key-'||i,'hash','fixture.txt',1,'text/plain',false,'user_data','unknown',true,NOW()-INTERVAL '2 minutes'
   FROM generate_series(1,100-(SELECT count(*)::int FROM attachment WHERE user_id='u' AND status<>'failed')) i`)
  providerMode = 'success'
  const limited = await upload(randomUUID())
  assert.equal(limited.status, 429)
  assert.equal((await limited.json()).error.code, 'ATTACHMENT_QUOTA')
  assert.equal(uploadCalls, priorCalls)
  await client.query('ROLLBACK')
  assert.equal(
    (await client.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1', [schema]))
      .rows[0].n,
    0
  )
  process.stdout.write(
    'PASS attachment upload/privacy/ownership/replay/unknown/soft-delete; schema rolled back\n'
  )
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  process.stderr.write(
    'P5 attachments failed at ' + stage + '; ' + (error.code ?? error.name) + '\n'
  )
  process.exitCode = 1
} finally {
  pool.query = oldQuery
  pool.connect = oldConnect
  globalThis.fetch = oldFetch
  config.deepseekKey = oldKey
  await client.end()
  await pool.end()
}

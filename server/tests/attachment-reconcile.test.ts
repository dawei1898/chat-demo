import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { attachmentRoutes } from '../src/attachments.js'
import { pool } from '../src/db/client.js'
import { config } from '../src/config.js'
import { HttpError } from '../src/store.js'

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const originalQuery = pool.query
  const originalFetch = globalThis.fetch
  const originalKey = config.deepseekKey
  const f = setup()
  pool.query = f.query as typeof pool.query
  globalThis.fetch = f.fetch
  config.deepseekKey = 'mock-only'
  try {
    await run(f)
  } finally {
    pool.query = originalQuery
    globalThis.fetch = originalFetch
    config.deepseekKey = originalKey
  }
}
function setup() {
  const row = {
    id: 'b4ff0dd5-a21e-47c3-aa1e-70b32be03ee8',
    upload_key: 'fd7fd8b5-9097-4344-b45e-67dc139d54f5',
    user_id: 'owner',
    name: 'test.txt',
    size_bytes: 4,
    mime_type: 'text/plain',
    is_image: false,
    status: 'unknown',
    provider_file_id: 'file-private-reference' as string | null,
    deleted_at: null as Date | null,
    error_code: 'UPLOAD_UNCONFIRMED' as string | null,
    cleanup_pending: true,
  }
  const f = {
    row,
    actor: 'owner',
    live: true,
    allowed: true,
    stale: false,
    calls: [] as string[],
    remoteStatus: 200,
    mismatch: false,
    deleteDuringFetch: false,
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM session')) {
        return { rows: f.live ? [{ id: 'session' }] : [], rowCount: f.live ? 1 : 0 }
      }
      if (sql.includes('INSERT INTO auth_rate_limit')) {
        return { rows: [{ allowed: f.allowed, retry_after: 21 }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT * FROM attachment')) {
        const identity = sql.includes('upload_key=$1') ? row.upload_key : row.id
        return {
          rows: values[0] === identity && values[1] === row.user_id ? [{ ...row }] : [],
          rowCount: 1,
        }
      }
      if (sql.includes("SET status='unknown'")) {
        if (!f.stale || row.status !== 'pending') {
          return { rows: [], rowCount: 0 }
        }
        row.status = 'unknown'
        return { rows: [{ ...row }], rowCount: 1 }
      }
      if (sql.includes("SET status='ready'")) {
        if (row.status !== 'unknown' || row.deleted_at) {
          return { rows: [], rowCount: 0 }
        }
        row.status = 'ready'
        row.cleanup_pending = false
        row.error_code = null
        return { rows: [{ ...row }], rowCount: 1 }
      }
      throw new Error('Unexpected test SQL')
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      f.calls.push(url)
      assert.equal(init?.method ?? 'GET', 'GET')
      assert.equal(url, 'https://api.deepseek.com/anthropic/v1/files/file-private-reference')
      assert.equal(new Headers(init?.headers).get('anthropic-beta'), 'files-api-2025-04-14')
      if (f.deleteDuringFetch) {
        row.status = 'deleted'
        row.deleted_at = new Date()
      }
      return new Response(
        JSON.stringify({
          id: row.provider_file_id,
          type: 'file',
          filename: row.id + '-' + row.name,
          size_bytes: f.mismatch ? 99 : 4,
          mime_type: row.mime_type,
        }),
        { status: f.remoteStatus, headers: { 'content-type': 'application/json' } }
      )
    },
    request: (async () => new Response()) as (path?: string, method?: string) => Promise<Response>,
  }
  const app = new Hono<{ Variables: { userId: string; sessionId: string } }>()
  app.use('*', async (c, next) => {
    c.set('userId', f.actor)
    c.set('sessionId', 'session')
    return next()
  })
  app.onError((e, c) =>
    c.json(
      { error: { code: e instanceof HttpError ? e.code : 'TEST_ERROR' } },
      e instanceof HttpError ? (e.status as 400) : 500
    )
  )
  app.route('/api/attachments', attachmentRoutes)
  f.request = (path = '/' + row.id + '/reconcile', method = 'POST') =>
    app.request('http://localhost/api/attachments' + path, { method })
  return f
}

test('本账号可按uploadKey找任务但不泄露providerID，其他账号404', () =>
  fixture(async (f) => {
    const response = await f.request('/by-upload-key/' + f.row.upload_key, 'GET')
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(!text.includes('file-private'))
    assert.equal(JSON.parse(text).id, f.row.id)
    f.actor = 'other'
    assert.equal((await f.request('/by-upload-key/' + f.row.upload_key, 'GET')).status, 404)
  }))
test('仅核对已记录ID的完整匹配元数据，ready后重放不再请求供应商', () =>
  fixture(async (f) => {
    const response = await f.request()
    assert.equal(response.status, 200)
    assert.ok(!(await response.text()).includes('file-private'))
    assert.equal(f.row.status, 'ready')
    assert.equal(f.row.cleanup_pending, false)
    assert.equal((await f.request()).status, 200)
    assert.equal(f.calls.length, 1)
  }))
test('无providerID不扫描共享列表、不重传，保留unknown待人工核对', () =>
  fixture(async (f) => {
    f.row.provider_file_id = null
    const response = await f.request()
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'ATTACHMENT_RECONCILE_MANUAL')
    assert.equal(f.row.status, 'unknown')
    assert.equal(f.calls.length, 0)
  }))
test('404或不匹配不能证明未上传，保留unknown和配额标记', async () => {
  for (const mode of ['missing', 'mismatch']) {
    await fixture(async (f) => {
      if (mode === 'missing') {
        f.remoteStatus = 404
      } else {
        f.mismatch = true
      }
      assert.equal((await f.request()).status, 409)
      assert.equal(f.row.status, 'unknown')
      assert.equal(f.row.cleanup_pending, true)
    })
  }
})
test('已删除、跨用户、失效会话和限频均不调用供应商', async () => {
  for (const mode of ['deleted', 'owner', 'session', 'rate']) {
    await fixture(async (f) => {
      if (mode === 'deleted') {
        f.row.deleted_at = new Date()
      }
      if (mode === 'owner') {
        f.actor = 'other'
      }
      if (mode === 'session') {
        f.live = false
      }
      if (mode === 'rate') {
        f.allowed = false
      }
      const response = await f.request()
      assert.equal(response.status, { deleted: 409, owner: 404, session: 401, rate: 429 }[mode])
      assert.equal(f.calls.length, 0)
    })
  }
})
test('对账期间软删的条件写入失败，不重新激活附件', () =>
  fixture(async (f) => {
    f.deleteDuringFetch = true
    assert.equal((await f.request()).status, 409)
    assert.equal(f.row.status, 'deleted')
  }))
test('近期pending继续等待，陈旧pending转unknown但无ID不重传', () =>
  fixture(async (f) => {
    f.row.status = 'pending'
    f.row.provider_file_id = null
    assert.equal((await f.request()).status, 409)
    assert.equal(f.row.status, 'pending')
    f.stale = true
    assert.equal((await f.request()).status, 409)
    assert.equal(f.row.status, 'unknown')
    assert.equal(f.calls.length, 0)
  }))

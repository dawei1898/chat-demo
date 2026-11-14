// 实际 Better Auth handler + Neon dev；所有账号、会话、限流和业务写入均在隔离schema事务中回滚。
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { prepare, execute } from '../src/generation.ts'
import {
  listConversationPage,
  parseConversationPagination,
} from '../src/conversation-pagination.ts'
import { selectVersion, getVisibleMessages } from '../../src/services/chat/branches.ts'
import { app } from '../src/app.ts'
import { pool } from '../src/db/client.ts'
import { config } from '../src/config.ts'
import { branchView } from '../src/branch-view.ts'
import { loadSession, saveSession, inTransaction } from '../src/store.ts'
if (process.env.RUN_NEON_DEV_INTEGRATION !== '1') {
  throw new Error('Explicit dev integration opt-in required')
}
const url = process.env.DATABASE_URL_UNPOOLED
if (!url || new URL(url).hostname !== 'ep-icy-lab-aodlx62h.c-2.ap-southeast-1.aws.neon.tech') {
  throw new Error('Non-dev endpoint refused')
}
const client = new pg.Client({ connectionString: url })
// 连接中断交由主流程统一报错并尝试回滚，避免未捕获事件输出内部堆栈。
client.on('error', () => {})
const schema = 'p3_tree_' + randomUUID().replaceAll('-', '')
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
const large = process.env.P3_LARGE === '1'
const seededId = randomUUID()
const seededOwner = randomUUID()
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
  await client.query("SET LOCAL statement_timeout='120s';SET LOCAL lock_timeout='3s'")
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

    if (large && entry.idx === 0) {
      stage = 'seed before constraint migration'
      const ids = Array.from({ length: 1000 }, () => randomUUID())
      const now = Date.now()
      const payloads = ids.map((id, i) => ({
        id,
        parentId: ids[i - 1] ?? null,
        selectedChildId: ids[i + 1],
        createdAt: now + i,
        ...(i % 2
          ? {
              role: 'assistant',
              blocks: [{ type: 'text', text: 'answer' }],
              status: 'done',
              model: 'deepseek-flash',
              thinking: false,
              search: false,
            }
          : { role: 'user', content: 'x'.repeat(5000), files: [] }),
      }))
      await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
        seededOwner,
        'Isolated seed',
        seededOwner + '@example.test',
      ])
      await client.query('INSERT INTO conversation(id,user_id,root_message_id) VALUES($1,$2,$3)', [
        seededId,
        seededOwner,
        ids[0],
      ])
      await client.query(
        `INSERT INTO message(id,conversation_id,parent_id,selected_child_id,payload,created_at)
        SELECT x->>'id',$1,x->>'parentId',x->>'selectedChildId',x,to_timestamp((x->>'createdAt')::bigint/1000.0)
        FROM jsonb_array_elements($2::jsonb) x`,
        [seededId, JSON.stringify(payloads)]
      )
      stage = 'validate preexisting 1000 nodes through migration'
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

  stage = 'signup and login'
  const email = randomUUID() + '@example.test'
  assert.equal(
    (
      await req('/api/auth/sign-up/email', {
        method: 'POST',
        body: { email, password, name: 'P3 isolated' },
      })
    ).status,
    200
  )
  const cookie = await login(email)
  const create = await req('/api/conversations', { method: 'POST', body: {}, cookie })
  let session = await create.json()
  const owner = (await client.query('SELECT user_id FROM conversation WHERE id=$1', [session.id]))
    .rows[0].user_id
  if (large) {
    await client.query('UPDATE conversation SET user_id=$2 WHERE id=$1', [seededId, owner])
    session = await loadSession(pool, owner, seededId)
  }
  const branchOnly = process.env.P3_BRANCH_ONLY === '1'
  config.deepseekKey = 'isolated-not-a-real-key'
  if (!branchOnly) {
    const initial = session.revision
    stage = 'revision'
    const patch = await req('/api/conversations/' + session.id, {
      method: 'PATCH',
      body: { title: 'new', expectedRevision: initial },
      cookie,
    })
    assert.equal(patch.status, 200)
    const revised = await patch.json()
    assert.equal(revised.revision, initial + 1)
    for (const method of ['PATCH', 'DELETE']) {
      const stale = await req('/api/conversations/' + session.id, {
        method,
        body: { expectedRevision: initial },
        cookie,
      })
      assert.equal(stale.status, 409)
      assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT')
    }
    config.deepseekKey = 'isolated-not-a-real-key'
    globalThis.fetch = async () => {
      throw new Error('No upstream calls permitted in P3 test')
    }
    const staleGeneration = await req('/api/conversations/' + session.id + '/generations', {
      method: 'POST',
      cookie,
      body: {
        expectedRevision: initial,
        operation: 'send',
        content: 'hello',
        idempotencyKey: randomUUID(),
      },
    })
    assert.equal(staleGeneration.status, 409)
    assert.equal((await staleGeneration.json()).error.code, 'REVISION_CONFLICT')
    pass('PATCH/DELETE/generation旧revision拒绝，成功写入递增')
    const nodeCount = process.env.P3_LARGE === '1' ? 1000 : 122
    stage = 'large branch'
    if (!large) {
      await inTransaction(async (q) => {
        const s = await loadSession(q, owner, session.id, true)
        const ids = Array.from({ length: nodeCount }, () => randomUUID())
        s.rootMessageId = ids[0]
        s.messages = ids.map((id, i) =>
          i % 2 === 0
            ? {
                id,
                role: 'user',
                content: 'x'.repeat(5000),
                files: [],
                createdAt: Date.now() + i,
                parentId: ids[i - 1] ?? null,
                selectedChildId: ids[i + 1],
              }
            : {
                id,
                role: 'assistant',
                blocks: [{ type: 'text', text: 'answer' }],
                status: 'done',
                model: 'deepseek-flash',
                thinking: false,
                search: false,
                createdAt: Date.now() + i,
                parentId: ids[i - 1],
                selectedChildId: ids[i + 1],
              }
        )
        await saveSession(q, s)
      })
    }
    const readStarted = performance.now()
    const first = await (
      await req('/api/conversations/' + session.id + '?view=branch', { cookie })
    ).json()
    const readMs = Math.round(performance.now() - readStarted)
    assert.equal(first.view, 'branch')
    assert.equal(first.messages.length, 50)
    assert.equal(first.treeIndex.length, nodeCount)
    assert.equal(first.hasEarlier, true)
    const second = await (
      await req('/api/conversations/' + session.id + '?view=branch&beforeId=' + first.beforeId, {
        cookie,
      })
    ).json()
    assert.equal(second.messages.length, 50)
    const third = await (
      await req('/api/conversations/' + session.id + '?view=branch&beforeId=' + second.beforeId, {
        cookie,
      })
    ).json()
    assert.equal(third.messages.length, Math.min(50, nodeCount - 100))
    assert.equal(third.hasEarlier, nodeCount > 150)
    assert.equal(
      new Set([...first.messages, ...second.messages, ...third.messages].map((x) => x.id)).size,
      Math.min(nodeCount, 150)
    )
    const invalid = await req(
      '/api/conversations/' + session.id + '?view=branch&beforeId=missing',
      {
        cookie,
      }
    )
    assert.equal(invalid.status, 400)
    pass(nodeCount + '节点分支正文窗口50，前三页无重叠，非法游标400')
    stage = 'budget rollback'
    const fullStarted = performance.now()
    const before = await loadSession(pool, owner, session.id)
    const fullMs = Math.round(performance.now() - fullStarted)
    const snapshotBytes = Buffer.byteLength(
      JSON.stringify({ session: branchView(before), runId: 'mock' })
    )
    process.stdout.write(
      JSON.stringify({
        nodes: nodeCount,
        branchReadMs: readMs,
        fullReadMs: fullMs,
        branchBytes: Buffer.byteLength(JSON.stringify(first)),
        fullBytes: Buffer.byteLength(JSON.stringify(before)),
        sseSnapshotBytes: snapshotBytes,
      }) + '\n'
    )
    const over = await req('/api/conversations/' + session.id + '/generations', {
      method: 'POST',
      cookie,
      body: {
        operation: 'send',
        content: 'next',
        idempotencyKey: randomUUID(),
        expectedRevision: before.revision,
      },
    })
    assert.equal(over.status, 413)
    assert.equal((await over.json()).error.code, 'CONTEXT_BUDGET_EXCEEDED')
    const after = await loadSession(pool, owner, session.id)
    assert.deepEqual(after, before)
    assert.equal((await client.query('SELECT count(*)::int n FROM generation_run')).rows[0].n, 0)
    pass('超预算明确413且消息、revision及generation全部无修改')
    stage = 'pagination revision'
    const listing = await (await req('/api/conversations?limit=1', { cookie })).json()
    assert.equal(listing.items[0].revision, before.revision)
    pass('列表summary携带权威revision')
  }
  if (!large) {
    if (!branchOnly) {
      stage = 'static 250 pagination'
      const listOwner = randomUUID()
      await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
        listOwner,
        'pagination',
        listOwner + '@example.test',
      ])
      const ids = Array.from({ length: 250 }, (_, i) => 'list-' + String(i).padStart(4, '0'))
      await client.query(
        `INSERT INTO conversation(id,user_id,updated_at) SELECT unnest($1::text[]),$2,'2026-01-01 00:00:00.123456'::timestamp`,
        [ids, listOwner]
      )
      const seen = []
      let cursor = null
      do {
        const params = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })
        const page = await listConversationPage(
          pool,
          listOwner,
          parseConversationPagination(params)
        )
        seen.push(...page.items.map((x) => x.id))
        cursor = page.nextCursor
      } while (cursor)
      assert.deepEqual(seen, [...ids].reverse())
      assert.equal(
        (await listConversationPage(pool, owner, { limit: 100, cursor: null })).items.some((x) =>
          x.id.startsWith('list-')
        ),
        false
      )
      await client.query('UPDATE conversation SET deleted_at=NOW() WHERE id=$1', [ids[249]])
      assert.equal(
        (await listConversationPage(pool, listOwner, { limit: 50, cursor: null })).items[0].id,
        ids[248]
      )
      assert.throws(() => parseConversationPagination(new URLSearchParams({ cursor: 'invalid' })))
      pass('真实DB同微秒250列表分页无重无漏、归属隔离、软删与非法游标')
    }
    stage = 'generation branch roundtrip'
    const branchId = randomUUID()
    await client.query('INSERT INTO conversation(id,user_id) VALUES($1,$2)', [branchId, owner])
    globalThis.fetch = async () => {
      const events = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'isolated reply' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        { type: 'message_stop' },
      ]
      return new Response(
        events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
    const run = async (operation, extra = {}) => {
      stage = 'generation ' + operation
      const s = await loadSession(pool, owner, branchId)
      const task = await prepare(owner, branchId, {
        operation,
        thinking: false,
        search: false,
        idempotencyKey: randomUUID(),
        expectedRevision: s.revision,
        ...extra,
      })
      let terminal
      await execute(task, new AbortController().signal, async (name, data) => {
        if (name === 'done' || name === 'error') {
          terminal = { name, data }
        }
      })
      assert.equal(terminal?.name, 'done')
      const persisted = await loadSession(pool, owner, branchId)
      assert.equal(persisted.revision, terminal.data.session.revision)
      return persisted
    }
    let tree = await run('send', { content: 'original', parentId: null })
    const originalIds = getVisibleMessages(tree).map((m) => m.id)
    const originalNodes = JSON.parse(JSON.stringify(tree.messages))
    tree = await run('regenerate', { messageId: originalIds[1] })
    const regenerated = getVisibleMessages(tree).at(-1).id
    assert.notEqual(regenerated, originalIds[1])
    tree = await run('continue', { messageId: regenerated })
    assert.equal(getVisibleMessages(tree).at(-1).id, regenerated)
    tree = await run('edit', { messageId: originalIds[0], content: 'edited' })
    assert.equal(tree.messages.length, 5)
    assert.equal(getVisibleMessages(tree)[0].content, 'edited')
    await inTransaction(async (q) => {
      const current = await loadSession(q, owner, branchId, true)
      // 先切回旧用户根版本，再切旧回答；不能直接选择当前路径之外的后代。
      await saveSession(q, selectVersion(selectVersion(current, originalIds[0]), originalIds[1]))
    })
    const restored = await loadSession(pool, owner, branchId)
    assert.deepEqual(
      getVisibleMessages(restored).map((m) => m.id),
      originalIds
    )
    assert.equal(
      restored.messages.find((m) => m.id === originalIds[0]).content,
      originalNodes.find((m) => m.id === originalIds[0]).content
    )
    assert.deepEqual(
      restored.messages.find((m) => m.id === originalIds[1]).blocks,
      originalNodes.find((m) => m.id === originalIds[1]).blocks
    )
    pass('真实DB send/regenerate/continue/edit/selectVersion及重载保留旧分支与权威revision')
  }
  await client.query('ROLLBACK')
  assert.equal(
    (await client.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1', [schema]))
      .rows[0].n,
    0
  )
  pass('所有新账号、会话、限流和业务数据随schema回滚，无public残留')
  process.stdout.write(`P3 integration: ${count} checks passed\n`)
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  process.stderr.write(
    `P3 integration failed at ${stage}; code=${error.code ?? error.name}; actual=${typeof error.actual === 'number' ? error.actual : '-'}; expected=${typeof error.expected === 'number' ? error.expected : '-'}\n`
  )
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

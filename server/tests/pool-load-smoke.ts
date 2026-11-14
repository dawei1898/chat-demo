import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { config } from '../src/config.js'
import { pool } from '../src/db/client.js'
import { prepare, execute } from '../src/generation.js'
import { loadSession } from '../src/store.js'

// Explicit opt-in; never reaches the model provider. Test records stay in dev.
assert.ok(['ep-icy-lab-aodlx62h.c-2.ap-southeast-1.aws.neon.tech', 'ep-icy-lab-aodlx62h-pooler.c-2.ap-southeast-1.aws.neon.tech'].includes(new URL(config.databaseUrl).hostname), 'Only verified dev endpoint allowed')
config.deepseekKey = 'mock-load-only'
const originalFetch = globalThis.fetch
let opened = 0
let release!: () => void
const gate = new Promise<void>((resolve) => { release = resolve })
globalThis.fetch = async () => {
  opened += 1
  await gate
  return new Response([
    { type: 'message_start', message: { id: 'mock', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'mock load verified' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 3 } },
    { type: 'message_stop' },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
try {
  const start = performance.now()
  const u = await pool.query('SELECT id FROM "user" WHERE email LIKE \'local-test-%@example.test\' LIMIT 1')
  assert.ok(u.rowCount, 'Existing dev test user required')
  const connectMs = Math.round(performance.now() - start)
  const uid = u.rows[0].id
  const tasks = []
  for (let i = 0; i < 3; i++) {
    const id = randomUUID()
    await pool.query('INSERT INTO conversation(id,user_id,title) VALUES($1,$2,$3)', [id, uid, 'P1 mocked concurrent stream'])
    tasks.push(await prepare(uid, id, { operation: 'send', content: 'load test', parentId: null, thinking: false, search: false, idempotencyKey: randomUUID() }))
  }
  const streams = tasks.map((task) => execute(task, new AbortController().signal, async () => {}))
  for (let i = 0; i < 100 && opened < 3; i++) { await new Promise((r) => setTimeout(r, 20)) }
  assert.equal(opened, 3)
  // Provider responses remain blocked: an API streaming request must not hold a DB client.
  assert.equal(pool.totalCount, pool.idleCount)
  assert.equal(pool.waitingCount, 0)
  const readStart = performance.now()
  await Promise.all(Array.from({ length: 20 }, () => loadSession(pool, uid, tasks[0].session.id)))
  const concurrentReadMs = Math.round(performance.now() - readStart)
  assert.ok(pool.totalCount <= 5)
  release()
  await Promise.all(streams)
  assert.equal(pool.waitingCount, 0)
  assert.equal(pool.totalCount, pool.idleCount)
  const client = await pool.connect()
  let largeHistoryReadMs = 0
  try {
    await client.query('BEGIN')
    const id = randomUUID()
    await client.query('INSERT INTO conversation(id,user_id,title) VALUES($1,$2,$3)', [id, uid, 'P1 rolled-back large history'])
    const ids = Array.from({ length: 1000 }, () => randomUUID())
    const payloads = ids.map((mid, i) => ({ id: mid, role: i % 2 ? 'assistant' : 'user', createdAt: i,
      ...(i ? { parentId: ids[i - 1] } : {}), ...(i < ids.length - 1 ? { selectedChildId: ids[i + 1] } : {}),
      ...(i % 2 ? { status: 'done', blocks: [{ type: 'text', text: 'x'.repeat(1000) }] } : { content: 'x'.repeat(1000), files: [] }) }))
    await client.query(`INSERT INTO message(id,conversation_id,parent_id,selected_child_id,payload,created_at)
      SELECT v->>'id',$1,v->>'parentId',v->>'selectedChildId',v,to_timestamp((v->>'createdAt')::double precision/1000)
      FROM jsonb_array_elements($2::jsonb) v`, [id, JSON.stringify(payloads)])
    await client.query('UPDATE conversation SET root_message_id=$2 WHERE id=$1', [id, ids[0]])
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    const readAt = performance.now()
    const large = await loadSession(client, uid, id)
    largeHistoryReadMs = Math.round(performance.now() - readAt)
    assert.equal(large.messages.length, 1000)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
  process.stdout.write(JSON.stringify({ pass: true, initialConnectionMs: connectMs, largeHistoryMessages: 1000, largeHistoryReadMs, concurrentReads: 20, concurrentReadMs, mockStreams: 3, totalConnections: pool.totalCount, idleConnections: pool.idleCount, retainedDevTestConversations: 3 }) + '\n')
} finally {
  release?.()
  globalThis.fetch = originalFetch
  await pool.end()
}

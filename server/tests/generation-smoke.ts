import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../src/config.js'
import { pool } from '../src/db/client.js'
import { prepare, execute } from '../src/generation.js'
import { loadSession } from '../src/store.js'
// Opt-in integration test: dev database only; mocked provider, no model charges.
config.deepseekKey = 'mock-test-only'
const originalFetch = globalThis.fetch
const events = [
  {
    type: 'message_start',
    message: {
      id: 'mock',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '本地流式测试通过' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 5, output_tokens: 8 },
  },
  { type: 'message_stop' },
]
globalThis.fetch = async (input, init) => {
  if (String(input) !== 'https://api.deepseek.com/anthropic/v1/messages') {
    return originalFetch(input, init)
  }
  init?.signal?.throwIfAborted()
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}
try {
  const users = await pool.query(
    'SELECT id FROM "user" WHERE email LIKE \'local-test-%@example.test\' LIMIT 1'
  )
  assert.ok(users.rowCount, 'run local-smoke first')
  const userId = users.rows[0].id
  const id = randomUUID()
  await pool.query('INSERT INTO conversation(id,user_id,title) VALUES($1,$2,$3)', [
    id,
    userId,
    'Mock generation test',
  ])
  const input = {
    operation: 'send' as const,
    content: 'hello',
    parentId: null,
    thinking: false,
    search: false,
    idempotencyKey: randomUUID(),
  }
  const task = await prepare(userId, id, input)
  const names: string[] = []
  await execute(task, new AbortController().signal, async (name) => {
    names.push(name)
  })
  assert.ok(names.includes('snapshot'))
  assert.ok(names.includes('done'))
  const s = await loadSession(pool, userId, id)
  const reply = s.messages.find((m) => m.role === 'assistant')
  assert.equal(reply?.role === 'assistant' && reply.status, 'done')
  assert.ok(
    reply?.role === 'assistant' &&
      reply.blocks.some((b) => b.type === 'text' && b.text === '本地流式测试通过')
  )
  await assert.rejects(() => prepare(userId, id, input))
  assert.ok(reply)
  assert.equal(reply.parentId, s.messages.find((m) => m.role === 'user')?.id)
  const again = await prepare(userId, id, {
    ...input,
    operation: 'regenerate',
    messageId: reply.id,
    idempotencyKey: randomUUID(),
  })
  const aborted = new AbortController()
  aborted.abort()
  await execute(again, aborted.signal, async () => {})
  const final = await loadSession(pool, userId, id)
  assert.equal(final.messages.length, 3)
  const stopped = final.messages.find((m) => m.id === again.reply.id)
  assert.equal(stopped?.role === 'assistant' && stopped.status, 'stopped')
  process.stdout.write(
    'PASS: mocked SSE aggregation, persistence, idempotency, regeneration tree. Test session retained in dev.\n'
  )
} finally {
  globalThis.fetch = originalFetch
  await pool.end()
}

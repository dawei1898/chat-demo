import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/client.js'
import { execute, type prepare } from '../src/generation.js'

const usage = {
  input_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 3,
}
const events = [
  {
    type: 'message_start',
    message: {
      id: 'mock',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      usage,
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '部分结果' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
  { type: 'message_stop' },
]
function stream(complete: boolean) {
  return new Response(
    (complete ? events : events.slice(0, 3))
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}
function task() {
  const reply = {
    id: 'a',
    parentId: 'q',
    role: 'assistant',
    createdAt: 1,
    model: 'deepseek-flash',
    thinking: false,
    search: false,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
  return {
    userId: 'u',
    runId: 'r',
    reply,
    body: { model: 'deepseek-flash', messages: [] },
    session: {
      id: 'c',
      title: '',
      rootMessageId: 'q',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'q',
          role: 'user',
          parentId: null,
          selectedChildId: 'a',
          createdAt: 1,
          content: 'fixture',
          files: [],
        },
        reply,
      ],
    },
  } as Exclude<Awaited<ReturnType<typeof prepare>>, { replay: true }>
}
// 所有 DB 与上游调用均替换为本测试进程内实现，绝不发网络请求。
for (const scenario of [
  '401',
  '429',
  '500',
  'early-close',
  'final-db-failure',
  'connect',
  'idle',
  'client-slow',
  'total',
  'oversized',
  'poll-db',
  'ping-only',
  'malformed-error',
  'refusal-disconnect',
] as const) {
  test(`P4 execute 故障：${scenario}`, async (t) => {
    const emitted: { event: string; data: unknown }[] = []
    let committedStatus = 'running'
    let stagedStatus = committedStatus
    let rollbacks = 0
    const checkpoints: {
      status: string
      payload: { stopReason?: string; blocks?: { type: string }[] }
    }[] = []
    const query = async (sql: string, values: unknown[] = []) => {
      if (scenario === 'poll-db' && sql.includes('session_live')) {
        throw new Error('private-db-poll')
      }
      if (sql.includes('UPDATE message SET payload=')) {
        checkpoints.push({ status: stagedStatus, payload: JSON.parse(String(values[1])) })
      }
      if (sql === 'BEGIN') {
        stagedStatus = committedStatus
      }
      if (sql === 'COMMIT') {
        committedStatus = stagedStatus
      }
      if (sql === 'ROLLBACK') {
        stagedStatus = committedStatus
        rollbacks++
      }
      if (sql.includes('UPDATE generation_run SET status=')) {
        stagedStatus = String(values[1])
      }
      if (
        sql.includes('UPDATE usage_record') &&
        scenario === 'final-db-failure' &&
        stagedStatus !== 'running'
      ) {
        throw new Error('private-database-detail')
      }
      return {
        rowCount: 1,
        rows: [
          {
            id: 'r',
            status: 'running',
            cancel_requested: false,
            session_live: true,
            version: 2,
            updated_at: new Date(),
          },
        ],
      }
    }
    t.mock.method(pool, 'query', query)
    t.mock.method(pool, 'connect', async () => ({ query, release() {} }))
    t.mock.method(globalThis, 'fetch', async () => {
      if (scenario === 'refusal-disconnect') {
        const rejected = [
          ...events.slice(0, 3),
          { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage },
        ]
        return new Response(
          rejected.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
      if (scenario === 'malformed-error') {
        return new Response('event: error\ndata: not-json\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (scenario === 'ping-only') {
        let interval: ReturnType<typeof setInterval>
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              interval = setInterval(
                () => controller.enqueue(new TextEncoder().encode(': ping\n\n')),
                5
              )
            },
            cancel() {
              clearInterval(interval)
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
      if (scenario === 'connect') {
        return new Promise<Response>(() => {})
      }
      if (['idle', 'total', 'poll-db'].includes(scenario)) {
        return new Response(new ReadableStream<Uint8Array>({}), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (scenario === 'oversized') {
        return new Response('x'.repeat(2000), { headers: { 'content-type': 'text/event-stream' } })
      }
      return Number(scenario)
        ? new Response('private-provider-detail', { status: Number(scenario) })
        : stream(scenario === 'final-db-failure' || scenario === 'client-slow')
    })
    const started = Date.now()
    await execute(
      task(),
      new AbortController().signal,
      async (event, data) => {
        emitted.push({ event, data })
        if (scenario === 'client-slow') {
          await new Promise<void>(() => {})
        }
      },
      {
        connectMs: 30,
        idleMs: scenario === 'total' || scenario === 'poll-db' ? 1000 : 30,
        totalMs: scenario === 'total' ? 30 : 1000,
        clientWriteMs: 30,
        maxResponseBytes: 1000,
        pollMs: scenario === 'poll-db' ? 10 : 1500,
      }
    )
    assert.ok(Date.now() - started < 1500, 'must terminate within bounded test time')
    assert.ok(emitted.some((e) => e.event === 'error'))
    assert.ok(!emitted.some((e) => e.event === 'done'))
    assert.ok(!JSON.stringify(emitted).includes('private-'))
    const codes: Record<string, string> = {
      '401': 'UPSTREAM_AUTH',
      '429': 'UPSTREAM_RATE_LIMIT',
      '500': 'UPSTREAM_UNAVAILABLE',
      'early-close': 'STREAM_INTERRUPTED',
      'final-db-failure': 'SAVE_FAILED',
      connect: 'CONNECT_TIMEOUT',
      idle: 'IDLE_TIMEOUT',
      'client-slow': 'CLIENT_SLOW',
      total: 'TOTAL_TIMEOUT',
      oversized: 'RESPONSE_TOO_LARGE',
      'poll-db': 'DATABASE_UNAVAILABLE',
      'ping-only': 'IDLE_TIMEOUT',
      'malformed-error': 'UPSTREAM_UNAVAILABLE',
      'refusal-disconnect': 'STREAM_INTERRUPTED',
    }
    assert.ok(emitted.some((e) => (e.data as { code?: string }).code === codes[scenario]))
    if (scenario === 'refusal-disconnect') {
      assert.ok(
        checkpoints.some(
          (c) =>
            c.status === 'running' &&
            c.payload.stopReason === 'refusal' &&
            !c.payload.blocks?.some((b) => b.type === 'text' || b.type === 'thinking')
        ),
        'refusal must flush a sanitized checkpoint before terminal persistence'
      )
      const last = checkpoints.at(-1)
      assert.ok(!last?.payload.blocks?.some((b) => b.type === 'text' || b.type === 'thinking'))
    }
    if (scenario === 'final-db-failure') {
      assert.equal(committedStatus, 'running')
      assert.ok(rollbacks >= 1)
    } else {
      assert.equal(committedStatus, 'error')
    }
  })
}

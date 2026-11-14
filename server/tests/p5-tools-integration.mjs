// Opt-in Neon dev test: isolated schema and one outer rollback; no model requests.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { pool } from '../src/db/client.ts'
import { config } from '../src/config.ts'
import { prepare, execute } from '../src/generation.ts'
import { loadSession } from '../src/store.ts'
if (process.env.RUN_NEON_DEV_INTEGRATION !== '1') {
  throw new Error('Explicit dev test opt-in required')
}
const url = process.env.DATABASE_URL_UNPOOLED
if (!url || new URL(url).hostname !== 'ep-icy-lab-aodlx62h.c-2.ap-southeast-1.aws.neon.tech') {
  throw new Error('Non-dev endpoint refused')
}
const client = new pg.Client({ connectionString: url })
const schema = 'p5_tools_' + randomUUID().replaceAll('-', '')
const oldFetch = globalThis.fetch
const oldConnect = pool.connect
const oldQuery = pool.query
const oldKey = config.deepseekKey
let stage = 'setup'
let fetchCount = 0
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

  const search = {
    type: 'server_tool_use',
    id: 'search1',
    name: 'deepseek_web_search',
    kind: 'search',
    input: { action: 'search', queries: ['fixture'] },
    caller: { type: 'direct' },
  }
  const searchResult = {
    type: 'web_search_tool_result',
    tool_use_id: 'search1',
    kind: 'search',
    content: [
      {
        type: 'web_search_result',
        url: 'https://example.com/search',
        title: '<script>not HTML</script>',
        snippet: 'fixture',
        site_name: 'Example',
        site_icon: null,
        page_age: null,
        encrypted_content: 'fixture-search-signature',
      },
    ],
  }
  const deep = {
    type: 'server_tool_use',
    id: 'deep1',
    name: 'deepseek_web_search',
    kind: 'deep_search',
    input: { action: 'open_page', url: 'https://example.com/deep' },
    caller: { type: 'direct' },
  }
  const page = {
    type: 'web_fetch_result',
    url: 'https://example.com/',
    published_at: null,
    content: {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: '' },
      title: 'Example',
    },
  }
  const deepResult = {
    type: 'web_fetch_tool_result',
    tool_use_id: 'deep1',
    kind: 'deep_search',
    content: page,
  }
  const read = {
    type: 'server_tool_use',
    id: 'read1',
    name: 'deepseek_read_url',
    kind: 'read_link',
    input: { action: 'read_link', url: 'https://example.com/' },
    caller: { type: 'direct' },
  }
  const readResult = {
    type: 'web_fetch_tool_result',
    tool_use_id: 'read1',
    kind: 'read_link',
    signature: 'synthetic-signed-page-完整',
    content: page,
  }
  const failed = { ...read, id: 'read-error' }
  const failedResult = {
    type: 'web_fetch_tool_result',
    tool_use_id: 'read-error',
    kind: 'read_link',
    content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
  }
  const citation = {
    type: 'web_search_result_location',
    url: 'https://example.com/search',
    title: 'Example',
    cited_text: 'answer',
    encrypted_index: 'fixture',
  }
  const blocks = [
    search,
    searchResult,
    deep,
    deepResult,
    read,
    readResult,
    failed,
    failedResult,
    { type: 'text', text: 'answer' },
  ]
  const requests = []
  globalThis.fetch = async (_url, init) => {
    fetchCount++
    requests.push(JSON.parse(init.body))
    const chosen = fetchCount === 1 ? blocks : [{ type: 'text', text: 'second answer' }]
    const events = chosen.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block },
      ...(block.type === 'text'
        ? [{ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } }]
        : []),
      { type: 'content_block_stop', index },
    ])
    events.push(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 8,
          server_tool_use: {
            web_search_requests: 2,
            web_fetch_requests: 2,
            tool_search: 1,
            tool_fetch: 1,
            tool_image_search: 0,
          },
        },
      },
      { type: 'message_stop' }
    )
    return new Response(
      events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
  stage = 'search and read stream'
  const first = await prepare('u', 'c', {
    operation: 'send',
    content: 'Search and read https://example.com/',
    thinking: true,
    search: true,
    parentId: null,
    idempotencyKey: randomUUID(),
  })
  assert.equal(first.replay, false)
  assert.deepEqual(first.body.tools, [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
    { type: 'deepseek_web_search', name: 'deepseek_web_search' },
  ])
  const emitted = []
  await execute(first, new AbortController().signal, async (event, data) => {
    emitted.push({ event, data })
  })
  assert.equal(emitted.at(-1).event, 'done')
  const saved = await loadSession(pool, 'u', 'c')
  const answer = saved.messages.find((m) => m.id === first.reply.id)
  assert.equal(answer.status, 'done')
  assert.deepEqual(answer.blocks.slice(0, 8), blocks.slice(0, 8))
  assert.deepEqual(answer.blocks[8].citations, [citation])
  const ledger = (
    await client.query('SELECT raw_usage,completeness FROM usage_record WHERE generation_id=$1', [
      first.runId,
    ])
  ).rows[0]
  assert.equal(ledger.completeness, 'complete')
  assert.equal(ledger.raw_usage.server_tool_use.web_search_requests, 2)
  stage = 'follow-up signed context'
  const second = await prepare('u', 'c', {
    operation: 'send',
    content: 'follow up',
    thinking: false,
    search: false,
    parentId: answer.id,
    expectedRevision: saved.revision,
    idempotencyKey: randomUUID(),
  })
  assert.equal(second.replay, false)
  assert.deepEqual(second.body.tools, [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }])
  const context = second.body.messages.find((m) => m.role === 'assistant').content
  assert.deepEqual(
    context.filter((b) => b.type === 'server_tool_use').map((b) => b.id),
    ['read1', 'read-error']
  )
  assert.deepEqual(
    context.find((b) => b.type === 'web_fetch_tool_result' && b.tool_use_id === 'read1'),
    readResult
  )
  assert.deepEqual(
    context.find((b) => b.type === 'web_fetch_tool_result' && b.tool_use_id === 'read-error'),
    failedResult
  )
  assert.equal(
    context.some((b) => 'citations' in b),
    false
  )
  assert.equal(
    context.some((b) => b.type === 'web_search_tool_result'),
    false
  )
  await execute(second, new AbortController().signal, async () => {})
  assert.equal(fetchCount, 2)
  assert.deepEqual(requests[1].messages, second.body.messages)
  assert.deepEqual(
    (await loadSession(pool, 'u', 'c')).messages.find((m) => m.id === answer.id).blocks,
    answer.blocks
  )
  stage = 'rollback'
  await client.query('ROLLBACK')
  assert.equal(
    (await client.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1', [schema]))
      .rows[0].n,
    0
  )
  process.stdout.write(
    'PASS P5 search/deep_search/read_link/error/citation stream -> DB -> signed follow-up, 2 mock calls, full schema rollback\n'
  )
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  process.stderr.write('P5 tools failed at ' + stage + '; ' + (error.code ?? error.name) + '\n')
  process.exitCode = 1
} finally {
  pool.query = oldQuery
  pool.connect = oldConnect
  globalThis.fetch = oldFetch
  config.deepseekKey = oldKey
  await client.end()
  await pool.end()
}

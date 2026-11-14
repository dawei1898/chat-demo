// Opt-in Neon dev test: isolated schema and one outer rollback; no model requests.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { pool } from '../src/db/client.ts'
import { config } from '../src/config.ts'
import { prepare, execute } from '../src/generation.ts'
if (process.env.RUN_NEON_DEV_INTEGRATION !== '1') {
  throw new Error('Explicit dev test opt-in required')
}
const url = process.env.DATABASE_URL_UNPOOLED
if (!url || new URL(url).hostname !== 'ep-icy-lab-aodlx62h.c-2.ap-southeast-1.aws.neon.tech') {
  throw new Error('Non-dev endpoint refused')
}
const client = new pg.Client({ connectionString: url })
const schema = 'p1_usage_' + randomUUID().replaceAll('-', '')
const oldFetch = globalThis.fetch
const oldConnect = pool.connect
const oldQuery = pool.query
let output = 8
let failLedger = false
let stage = 'setup'
try {
  await client.connect()
  await client.query('BEGIN')
  await client.query(`CREATE SCHEMA "${schema}"`)
  await client.query(`SET LOCAL search_path TO "${schema}"`)
  for (const name of [
    '0000_flat_gorgon.sql',
    '0001_illegal_quicksilver.sql',
    '0002_spooky_ben_grimm.sql',
    '0003_dusty_puff_adder.sql',
    '0004_woozy_skrulls.sql',
  ]) {
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
      await client.query('SET CONSTRAINTS ALL DEFERRED')
      return client.query('SAVEPOINT app_transaction')
    }
    if (sql === 'COMMIT') {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      return client.query('RELEASE SAVEPOINT app_transaction')
    }
    if (sql === 'ROLLBACK') {
      await client.query('ROLLBACK TO SAVEPOINT app_transaction')
      return client.query('RELEASE SAVEPOINT app_transaction')
    }
    if (failLedger && sql.includes('UPDATE usage_record')) {
      throw new Error('injected ledger failure')
    }
    return client.query(sql, values)
  }
  pool.query = query
  pool.connect = async () => ({ query, release() {} })
  config.deepseekKey = 'mock-only'
  globalThis.fetch = async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'mock',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'fixture' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens' },
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: output,
        },
      },
      { type: 'message_stop' },
    ]
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const input = {
    operation: 'send',
    content: 'fixture',
    parentId: null,
    thinking: false,
    search: false,
    idempotencyKey: randomUUID(),
  }
  stage = 'initial generation'
  const first = await prepare('u', 'c', input)
  await execute(first, new AbortController().signal, async () => {})
  let rows = (
    await client.query(
      'SELECT output_tokens,completeness FROM usage_record WHERE generation_id=$1',
      [first.runId]
    )
  ).rows
  assert.equal(Number(rows[0].output_tokens), 8)
  assert.equal(rows[0].completeness, 'complete')
  const replay = await prepare('u', 'c', input)
  assert.equal(replay.replay, true)
  assert.equal(replay.runId, first.runId)
  assert.equal(Number((await client.query('SELECT count(*) FROM usage_record')).rows[0].count), 1)
  stage = 'continuation isolation'
  output = 3
  const second = await prepare('u', 'c', {
    ...input,
    operation: 'continue',
    messageId: first.reply.id,
    idempotencyKey: randomUUID(),
  })
  await execute(second, new AbortController().signal, async () => {})
  rows = (
    await client.query('SELECT output_tokens FROM usage_record WHERE generation_id=$1', [
      second.runId,
    ])
  ).rows
  assert.equal(Number(rows[0].output_tokens), 3)
  stage = 'atomic failure'
  const third = await prepare('u', 'c', {
    ...input,
    operation: 'continue',
    messageId: first.reply.id,
    idempotencyKey: randomUUID(),
  })
  failLedger = true
  await execute(third, new AbortController().signal, async () => {})
  rows = (
    await client.query(
      'SELECT g.status,u.completeness,u.output_tokens FROM generation_run g JOIN usage_record u ON u.generation_id=g.id WHERE g.id=$1',
      [third.runId]
    )
  ).rows
  assert.equal(rows[0].status, 'running')
  assert.equal(rows[0].completeness, 'unknown')
  assert.equal(rows[0].output_tokens, null)
  process.stdout.write(
    'PASS: real prepare/execute ledger, idempotent replay, isolated continuation usage, atomic failure rollback\n'
  )
} catch (e) {
  process.stderr.write(`FAIL stage=${stage} type=${e.name} code=${e.code ?? 'none'}\n`)
  process.exitCode = 1
} finally {
  globalThis.fetch = oldFetch
  pool.query = oldQuery
  pool.connect = oldConnect
  await client.query('ROLLBACK').catch(() => {})
  await client.end()
  await pool.end()
  process.stdout.write('Isolated schema transaction rolled back; no public test rows written.\n')
}

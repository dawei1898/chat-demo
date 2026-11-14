/**
 * Opt-in real Neon DEV integration; no model calls, no public-table writes.
 * Creates an isolated schema inside one transaction and rolls back all fixtures,
 * schema DDL and constraints. Does not delete or repair existing application data.
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
if (process.env.RUN_NEON_DEV_INTEGRATION !== '1') {
  throw new Error('Set RUN_NEON_DEV_INTEGRATION=1 to run the isolated dev test')
}
const url = process.env.DATABASE_URL_UNPOOLED
if (!url || new URL(url).hostname !== 'ep-icy-lab-aodlx62h.c-2.ap-southeast-1.aws.neon.tech') {
  throw new Error('Refusing non-dev database endpoint')
}
const client = new pg.Client({ connectionString: url })
const schema = 'p1_tree_' + randomUUID().replaceAll('-', '')
let checks = 0
let currentCheck = 'setup'
async function expectConstraint(
  name: string,
  change: () => Promise<unknown>,
  code: string[] = ['23514', '23503']
) {
  currentCheck = name
  await client.query('SAVEPOINT invalid_change')
  let rejected = false
  try {
    await change()
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
  } catch (error) {
    assert.ok(code.includes((error as { code: string }).code), `unexpected SQLSTATE in ${name}`)
    rejected = true
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT invalid_change')
    await client.query('RELEASE SAVEPOINT invalid_change')
  }
  assert.ok(rejected, `${name} must reject`)
  checks++
  process.stdout.write(`PASS ${name}\n`)
}
async function graphNode(
  id: string,
  conv: string,
  role: 'user' | 'assistant',
  parent: string | null,
  child: string | null
) {
  const payload = {
    id,
    role,
    parentId: parent,
    ...(child ? { selectedChildId: child } : {}),
    createdAt: 1,
    ...(role === 'user'
      ? { content: 'integration fixture', files: [] }
      : { blocks: [], prefix: true, status: 'done', model: 'deepseek-flash' }),
  }
  await client.query(
    'INSERT INTO message(id,conversation_id,parent_id,selected_child_id,payload) VALUES($1,$2,$3,$4,$5)',
    [id, conv, parent, child, JSON.stringify(payload)]
  )
}
async function run(id: string, owner = 'u1', conv = 'c1', message = 'a1') {
  await client.query(
    "INSERT INTO generation_run(id,user_id,conversation_id,message_id,idempotency_key,operation,status) VALUES($1,$2,$3,$4,$1,'send','running')",
    [id, owner, conv, message]
  )
}
try {
  await client.connect()
  await client.query('BEGIN')
  await client.query(`CREATE SCHEMA "${schema}"`)
  await client.query(`SET LOCAL search_path TO "${schema}",pg_catalog`)
  await client.query("SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='3s'")
  for (const migration of [
    '0000_flat_gorgon.sql',
    '0001_illegal_quicksilver.sql',
    '0002_spooky_ben_grimm.sql',
  ]) {
    const sql = (
      await readFile(new URL('../../migrations/' + migration, import.meta.url), 'utf8')
    ).replaceAll('"public".', `"${schema}".`)
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) {
        await client.query(statement)
      }
    }
  }
  await client.query(
    `INSERT INTO "user"(id,name,email) VALUES('u1','fixture','u1@example.test'),('u2','fixture','u2@example.test')`
  )
  await client.query(
    "INSERT INTO conversation(id,user_id,root_message_id) VALUES('c1','u1','q1'),('c2','u2','qOther')"
  )
  await graphNode('q1', 'c1', 'user', null, 'a1')
  await graphNode('a1', 'c1', 'assistant', 'q1', null)
  await graphNode('qOther', 'c2', 'user', null, 'aOther')
  await graphNode('aOther', 'c2', 'assistant', 'qOther', null)
  await graphNode('q2', 'c1', 'user', null, 'a2')
  await graphNode('a2', 'c1', 'assistant', 'q2', null)
  await client.query('SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED')
  checks++
  process.stdout.write('PASS deferred forward references and alternative roots\n')
  await expectConstraint('cross-conversation parent', () =>
    client.query(
      `UPDATE message SET parent_id='qOther',payload=jsonb_set(payload,'{parentId}','"qOther"') WHERE id='a1'`
    )
  )
  await expectConstraint('selected child not direct child', () =>
    client.query(
      `UPDATE message SET selected_child_id='a2',payload=jsonb_set(payload,'{selectedChildId}','"a2"') WHERE id='q1'`
    )
  )
  await expectConstraint('cross-conversation selected child', () =>
    client.query(
      `UPDATE message SET selected_child_id='aOther',payload=jsonb_set(payload,'{selectedChildId}','"aOther"') WHERE id='q1'`
    )
  )
  await expectConstraint('invalid selected root role', () =>
    client.query("UPDATE conversation SET root_message_id='a1' WHERE id='c1'")
  )
  await expectConstraint('cross-conversation root', () =>
    client.query("UPDATE conversation SET root_message_id='qOther' WHERE id='c1'")
  )
  await expectConstraint('nonempty conversation missing root', () =>
    client.query("UPDATE conversation SET root_message_id=NULL WHERE id='c1'")
  )
  await expectConstraint('detached ancestry cycle', () =>
    client.query(
      `UPDATE message SET parent_id='a2',payload=jsonb_set(payload,'{parentId}','"a2"') WHERE id='q2'`
    )
  )
  await expectConstraint(
    'payload relational identity mismatch',
    () =>
      client.query(
        `UPDATE message SET payload=jsonb_set(payload,'{parentId}','"foreign"') WHERE id='a1'`
      ),
    ['23514']
  )
  await expectConstraint('parent mutation invalidates previous selection', () =>
    client.query(
      `UPDATE message SET parent_id='q2',payload=jsonb_set(payload,'{parentId}','"q2"') WHERE id='a1'`
    )
  )
  await expectConstraint('generation wrong owner', () => run('badOwner', 'u2'))
  await expectConstraint('generation cross-conversation message', () =>
    run('badMessage', 'u1', 'c1', 'aOther')
  )
  await expectConstraint('generation user message', () => run('badRole', 'u1', 'c1', 'q1'))
  await run('goodRun')
  await client.query('SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED')
  await expectConstraint('second active generation', () => run('secondRun'), ['23505'])
  await client.query(
    `UPDATE message SET payload=jsonb_set(payload,'{blocks}','[{"type":"text","text":"stream snapshot"}]') WHERE id='a1'`
  )
  await client.query('SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED')
  assert.equal(
    (await client.query("SELECT parent_id FROM message WHERE id='a1'")).rows[0].parent_id,
    'q1'
  )
  assert.equal((await client.query('SELECT count(*)::int n FROM generation_run')).rows[0].n, 1)
  checks++
  process.stdout.write('PASS stream snapshot update and failed transaction rollback\n')
  await client.query("UPDATE generation_run SET status='done',finished_at=now() WHERE id='goodRun'")
  await run('nextRun')
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')
  checks++
  process.stdout.write('PASS terminal run releases active-generation slot\n')
  await client.query("INSERT INTO usage_record(generation_id) VALUES('goodRun')")
  const unknownUsage = (
    await client.query(
      "SELECT input_tokens,output_tokens,completeness FROM usage_record WHERE generation_id='goodRun'"
    )
  ).rows[0]
  assert.deepEqual(unknownUsage, {
    input_tokens: null,
    output_tokens: null,
    completeness: 'unknown',
  })
  checks++
  process.stdout.write('PASS unknown usage preserves null rather than inventing zero\n')
  await expectConstraint(
    'one usage row per generation',
    () => client.query("INSERT INTO usage_record(generation_id) VALUES('goodRun')"),
    ['23505']
  )
  for (const column of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    await expectConstraint(
      `negative ${column}`,
      () => client.query(`UPDATE usage_record SET ${column}=-1 WHERE generation_id='goodRun'`),
      ['23514']
    )
  }
  await expectConstraint(
    'invalid usage completeness',
    () =>
      client.query("UPDATE usage_record SET completeness='invented' WHERE generation_id='goodRun'"),
    ['23514']
  )
  await expectConstraint(
    'usage requires existing generation',
    () => client.query("INSERT INTO usage_record(generation_id) VALUES('missingRun')"),
    ['23503']
  )
  await client.query(
    "UPDATE usage_record SET input_tokens=12,cached_input_tokens=3,output_tokens=8,completeness='complete' WHERE generation_id='goodRun'"
  )
  const completedUsage = (
    await client.query(
      "SELECT input_tokens::int, cached_input_tokens::int,output_tokens::int,completeness FROM usage_record WHERE generation_id='goodRun'"
    )
  ).rows[0]
  assert.deepEqual(completedUsage, {
    input_tokens: 12,
    cached_input_tokens: 3,
    output_tokens: 8,
    completeness: 'complete',
  })
  assert.equal((await client.query('SELECT count(*)::int n FROM usage_record')).rows[0].n, 1)
  checks++
  process.stdout.write('PASS usage updates and failed writes rollback without residue\n')
  await client.query('ROLLBACK')
  assert.equal(
    (await client.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1', [schema]))
      .rows[0].n,
    0
  )
  checks++
  process.stdout.write(`PASS full DDL and fixture rollback; ${checks} checks passed\n`)
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  process.stderr.write(
    `Integration failed at ${currentCheck}; code=${(error as { code?: string }).code ?? (error as Error).name}\n`
  )
  process.exitCode = 1
} finally {
  await client.end()
}

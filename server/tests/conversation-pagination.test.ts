import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import {
  encodeConversationCursor,
  parseConversationPagination,
  listConversationPage,
  PaginationError,
} from '../src/conversation-pagination.js'

const query = (value = '') => parseConversationPagination(new URLSearchParams(value))
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const timestamp = '2026-11-14T01:02:03.123456'
const cursor = encodeConversationCursor(timestamp, 'c2')

test('defaults and limit bounds are strict', () => {
  assert.deepEqual(query(), { limit: 50, cursor: null })
  assert.equal(query('limit=1').limit, 1)
  assert.equal(query('limit=100').limit, 100)
  for (const limit of ['', '0', '-1', '101', '1.2', '1e2', ' 50', '01', 'NaN']) {
    assert.throws(() => query(`limit=${encodeURIComponent(limit)}`), PaginationError, limit)
  }
  assert.throws(() => query('limit=10&limit=10'), PaginationError)
})

test('cursor round-trips without truncating PG microseconds', () => {
  assert.deepEqual(query(`cursor=${cursor}`).cursor, { v: 1, updatedAt: timestamp, id: 'c2' })
  assert.equal(query(`cursor=${cursor}&limit=7`).limit, 7)
})

test('malformed, unsupported and impossible cursors are rejected', () => {
  const invalid = [
    '',
    '*',
    cursor + '=',
    'a'.repeat(1025),
    encode(null),
    encode([]),
    encode('x'),
    encode({ v: 2, updatedAt: timestamp, id: 'c2' }),
    encode({ v: 1, updatedAt: timestamp, id: '' }),
    encode({ v: 1, updatedAt: timestamp, id: 'a'.repeat(129) }),
    encode({ v: 1, updatedAt: timestamp, id: 'c2', userId: 'other' }),
    encode({ v: 1, updatedAt: '2026-02-30T01:02:03.123456', id: 'c2' }),
    encode({ v: 1, updatedAt: '2026-11-14T01:02:03.123Z', id: 'c2' }),
  ]
  for (const value of invalid) {
    assert.throws(() => query(`cursor=${encodeURIComponent(value)}`), PaginationError)
  }
  assert.throws(() => query(`cursor=${cursor}&cursor=${cursor}`), PaginationError)
})

const row = (id: string, time = timestamp) => ({
  id,
  title: `title ${id}`,
  created_at: new Date('2026-11-01T00:00:00Z'),
  updated_at: new Date(time.slice(0, 23) + 'Z'),
  cursor_updated_at: time,
})
function database(
  rows: ReturnType<typeof row>[],
  check?: (sql: string, values: unknown[]) => void
) {
  return {
    query: async (sql: string, values: unknown[]) => {
      check?.(sql, values)
      return { rows }
    },
  } as unknown as Pick<Pool, 'query'>
}

test('first page scopes owner and soft deletion, returns lookahead cursor', async () => {
  const page = await listConversationPage(
    database([row('c3'), row('c2'), row('c1')], (sql, values) => {
      assert.match(sql, /WHERE user_id=\$1 AND deleted_at IS NULL/)
      assert.match(sql, /ORDER BY updated_at DESC,id DESC LIMIT \$2/)
      assert.deepEqual(values, ['owner', 3])
    }),
    'owner',
    query('limit=2')
  )
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['c3', 'c2']
  )
  assert.equal(page.nextCursor, cursor)
  assert.equal(page.items[0].createdAt, new Date('2026-11-01T00:00:00Z').getTime())
})

test('next page preserves tie-break ordering and bound parameters', async () => {
  const page = await listConversationPage(
    database([row('c1')], (sql, values) => {
      assert.match(sql, /AND \(updated_at,id\) < \(\$2::timestamp,\$3::text\)/)
      assert.match(sql, /LIMIT \$4/)
      assert.deepEqual(values, ['owner', timestamp, 'c2', 3])
    }),
    'owner',
    query(`limit=2&cursor=${cursor}`)
  )
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['c1']
  )
  assert.equal(page.nextCursor, null)
})

test('empty and exact-size terminal pages do not invent a cursor', async () => {
  const empty = await listConversationPage(database([]), 'owner', query())
  assert.deepEqual(empty, { items: [], nextCursor: null })
  const exact = await listConversationPage(
    database([row('c2'), row('c1')]),
    'owner',
    query('limit=2')
  )
  assert.equal(exact.nextCursor, null)
})

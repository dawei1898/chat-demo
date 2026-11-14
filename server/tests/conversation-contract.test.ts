import test from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { auth } from '../src/auth.js'
import { pool } from '../src/db/client.js'

test('conversation route preserves legacy array and opt-in page envelope', async (t) => {
  t.mock.method(auth.api, 'getSession', async () => ({
    user: { id: 'test-user' },
    session: { id: 'test-session' },
  }))
  const limits: unknown[] = []
  t.mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('heartbeat_at')) {
      return { rows: [] }
    }
    limits.push(values.at(-1))
    return {
      rows: [
        {
          id: 'test-conversation',
          title: 'test',
          created_at: new Date(0),
          updated_at: new Date(0),
          cursor_updated_at: '1970-01-01T00:00:00.000000',
        },
      ],
    }
  })
  const legacy = await app.request('/api/conversations')
  assert.equal(legacy.status, 200)
  const items = await legacy.json()
  assert.ok(Array.isArray(items))
  assert.equal(items.length, 1)
  const paged = await app.request('/api/conversations?limit=1')
  assert.equal(paged.status, 200)
  assert.deepEqual(await paged.json(), { items, nextCursor: null })
  assert.deepEqual(limits, [201, 2])
  assert.equal((await app.request('/api/conversations?limit=0')).status, 400)
})

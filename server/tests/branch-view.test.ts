import assert from 'node:assert/strict'
import test from 'node:test'
import { branchView } from '../src/branch-view.js'
import { assertRevision, saveSession } from '../src/store.js'
import type { Session } from '../../src/services/chat/types.js'

function fixture(): Session {
  return {
    id: 'c',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    revision: 4,
    rootMessageId: '0',
    messages: Array.from({ length: 125 }, (_, i) => ({
      id: String(i),
      parentId: i ? String(i - 1) : null,
      selectedChildId: i < 124 ? String(i + 1) : undefined,
      createdAt: i,
      role: 'user' as const,
      content: 'test',
      files: [],
    })),
  }
}
test('分支视图只给50条正文，索引保留，按需历史不重不漏', () => {
  const original = fixture()
  const a = branchView(original)
  const b = branchView(original, a.beforeId ?? undefined)
  const c = branchView(original, b.beforeId ?? undefined)
  assert.deepEqual([a.messages.length, b.messages.length, c.messages.length], [50, 50, 25])
  assert.equal(a.treeIndex.length, 125)
  assert.equal(c.hasEarlier, false)
  assert.equal(new Set([...a.messages, ...b.messages, ...c.messages].map((m) => m.id)).size, 125)
  assert.equal(original.messages.length, 125)
  assert.throws(() => branchView(original, 'unknown'))
})
test('乐观锁拒绝旧revision，部分DTO禁止完整树写入', async () => {
  const session = fixture()
  assert.doesNotThrow(() => assertRevision(session, 4))
  assert.throws(() => assertRevision(session, 3), { status: 409, code: 'REVISION_CONFLICT' })
  await assert.rejects(
    () =>
      saveSession(
        {
          query: async () => {
            throw new Error('must not query')
          },
        } as never,
        branchView(session)
      ),
    { status: 400 }
  )
})

test('显式branch标记即使没有treeIndex也不能写回', async () => {
  const partial = { ...fixture(), view: 'branch' as const }
  await assert.rejects(
    () =>
      saveSession(
        {
          query: async () => {
            throw new Error('must not query')
          },
        } as never,
        partial
      ),
    { status: 400 }
  )
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { assertMessageTree, MessageTreeIntegrityError } from '../src/message-tree.js'
import { appendBranch } from '../../src/services/chat/branches.js'
import type { Session, UserMessage, AssistantMessage } from '../../src/services/chat/types.js'
const q: UserMessage = { id: 'q', role: 'user', content: 'test', files: [], createdAt: 1 }
const a: AssistantMessage = {
  id: 'a',
  role: 'assistant',
  blocks: [],
  prefix: true,
  status: 'done',
  model: 'deepseek-flash',
  createdAt: 2,
}
const base: Session = {
  id: 'c',
  title: '',
  createdAt: 1,
  updatedAt: 1,
  rootMessageId: null,
  messages: [],
}
const valid = () => appendBranch(base, null, [q, a])
test('complete tree accepts empty and alternative branches', () => {
  assert.doesNotThrow(() => assertMessageTree(base))
  assert.doesNotThrow(() =>
    assertMessageTree(
      appendBranch(valid(), null, [
        { ...q, id: 'q2' },
        { ...a, id: 'a2' },
      ])
    )
  )
})
test('reject duplicate ids and references outside the supplied conversation', () => {
  const s = valid()
  assert.throws(
    () => assertMessageTree({ ...s, messages: [...s.messages, s.messages[0]] }),
    MessageTreeIntegrityError
  )
  assert.throws(
    () =>
      assertMessageTree({
        ...s,
        messages: s.messages.map((m) => (m.id === 'a' ? { ...m, parentId: 'foreign' } : m)),
      }),
    MessageTreeIntegrityError
  )
})
test('reject root and selected-child mismatches', () => {
  const s = valid()
  assert.throws(() => assertMessageTree({ ...s, rootMessageId: 'a' }), MessageTreeIntegrityError)
  assert.throws(() => assertMessageTree({ ...s, rootMessageId: null }), MessageTreeIntegrityError)
  assert.throws(
    () =>
      assertMessageTree({
        ...s,
        messages: s.messages.map((m) => (m.id === 'q' ? { ...m, selectedChildId: 'q' } : m)),
      }),
    MessageTreeIntegrityError
  )
})
test('detect cycles in unselected branches', () => {
  const s = valid()
  s.messages.push(
    { ...q, id: 'q2', parentId: 'a2', selectedChildId: 'a2' },
    { ...a, id: 'a2', parentId: 'q2', selectedChildId: 'q2' }
  )
  assert.throws(() => assertMessageTree(s), /cycle/)
})
test('reject same-role edges and assistant alternative roots', () => {
  const s = valid()
  s.messages.push({ ...a, id: 'a2', parentId: 'a' })
  assert.throws(() => assertMessageTree(s), MessageTreeIntegrityError)
  assert.throws(
    () =>
      assertMessageTree({
        ...valid(),
        messages: [...valid().messages, { ...a, id: 'root', parentId: null }],
      }),
    MessageTreeIntegrityError
  )
})

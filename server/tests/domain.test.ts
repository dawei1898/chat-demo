import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendBranch,
  getVisibleMessages,
  selectVersion,
} from '../../src/services/chat/branches.js'
import {
  applyEvent,
  settleReply,
  canContinueReply,
  toRequestMessages,
} from '../../src/services/chat/reply.js'
import { ServerSentEventDecoder } from '../../src/services/api/sse.js'
import { generationInput } from '../src/generation.js'
import { app } from '../src/app.js'
import type { Session, UserMessage, AssistantMessage } from '../../src/services/chat/types.js'
const q: UserMessage = { id: 'q', role: 'user', content: '你好', files: [], createdAt: 1 }
const a: AssistantMessage = {
  id: 'a',
  role: 'assistant',
  createdAt: 2,
  model: 'deepseek-flash',
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text: '你好' }],
}
const initial: Session = {
  id: 'c',
  title: '',
  createdAt: 1,
  updatedAt: 1,
  rootMessageId: null,
  messages: [],
}
test('branches preserve original messages when regenerate/edit/select', () => {
  const s = appendBranch(initial, null, [q, a])
  const regenerated = appendBranch(s, q.id, [{ ...a, id: 'a2' }])
  assert.equal(regenerated.messages.length, 3)
  assert.deepEqual(
    getVisibleMessages(regenerated).map((x) => x.id),
    ['q', 'a2']
  )
  assert.deepEqual(
    getVisibleMessages(selectVersion(regenerated, 'a')).map((x) => x.id),
    ['q', 'a']
  )
})
test('wire input rejects trusted history, ownership and file fields', () => {
  assert.equal(
    generationInput.safeParse({
      operation: 'send',
      content: 'hi',
      idempotencyKey: 'abcdefgh',
      userId: 'other',
    }).success,
    false
  )
  assert.equal(
    generationInput.safeParse({
      operation: 'send',
      content: 'hi',
      idempotencyKey: 'abcdefgh',
      messages: [a],
    }).success,
    false
  )
  assert.equal(
    generationInput.safeParse({ operation: 'send', content: 'hi', idempotencyKey: 'abcdefgh' })
      .success,
    true
  )
})
test('partial response persists stopped state and retains text', () => {
  const r = applyEvent(
    { ...a, blocks: [] },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } },
    1,
    new Map()
  )
  const stopped = settleReply(r, 'stopped', 2)
  assert.equal(stopped.status, 'stopped')
  assert.equal(canContinueReply(stopped), true)
  assert.deepEqual(stopped.blocks, [{ type: 'text', text: 'partial', citations: [] }])
})
test('thinking is excluded from normal history', () => {
  const r = {
    ...a,
    blocks: [
      { type: 'thinking' as const, thinking: 'private', signature: 'sig' },
      { type: 'text' as const, text: 'answer' },
    ],
  }
  const messages = toRequestMessages([q, r], { ...q, id: 'q2' })
  assert.ok(!JSON.stringify(messages).includes('private'))
})
test('SSE split frames remain parseable', () => {
  const decoder = new ServerSentEventDecoder()
  assert.deepEqual(decoder.push('event: x\r'), [])
  assert.deepEqual(
    decoder.push('\ndata: {"你好":1}\r\n\r\n').map((x) => x.data),
    ['{"你好":1}']
  )
})
test('health and Origin rejection do not access authentication database', async () => {
  assert.equal((await app.request('/api/health')).status, 200)
  const response = await app.request('/api/conversations', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 403)
})

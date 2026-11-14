import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEvent,
  settleReply,
  canContinueReply,
  toRequestMessages,
} from '../../src/services/chat/reply.js'
import {
  appendBranch,
  getVisibleMessages,
  selectVersion,
} from '../../src/services/chat/branches.js'
import type { AssistantMessage, Session } from '../../src/services/chat/types.js'
import type { MessageStreamEvent } from '../../src/services/api/types.js'
import {
  question,
  empty,
  textEvents,
  thinkingEvents,
  tool,
  result,
  expectedText,
  expectedThinking,
} from './fixtures/protocol-golden.js'
function replay(events: MessageStreamEvent[], initial = empty) {
  const indexes = new Map<number, number>()
  return events.reduce((reply, event, i) => applyEvent(reply, event, 10 + i, indexes), initial)
}
test('golden ordinary text events merge into fixed content', () => {
  assert.deepEqual(settleReply(replay(textEvents), 'done', 20).blocks, expectedText)
})
test('golden thinking indexes and split signatures preserve order and times', () => {
  assert.deepEqual(settleReply(replay(thinkingEvents), 'done', 20).blocks, expectedThinking)
})
test('golden tool blocks survive stream and signed read-link history', () => {
  const events: MessageStreamEvent[] = [
    { type: 'content_block_start', index: 0, content_block: tool },
    { type: 'content_block_start', index: 1, content_block: result },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'answer' } },
  ]
  const reply = settleReply(replay(events), 'done', 20)
  assert.deepEqual(reply.blocks, [tool, result, { type: 'text', text: 'answer', citations: [] }])
  const requestTool = {
    type: tool.type,
    id: tool.id,
    name: tool.name,
    input: tool.input,
    kind: tool.kind,
  }
  assert.deepEqual(toRequestMessages([question, reply], { ...question, id: 'q2' }), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [requestTool, result, { type: 'text', text: 'answer' }] },
    { role: 'user', content: 'hello' },
  ])
  assert.equal(canContinueReply({ ...reply, status: 'stopped' }), false)
})
test('golden unsigned read-link drops call and result from history', () => {
  const reply: AssistantMessage = {
    ...empty,
    status: 'done',
    blocks: [tool, { ...result, signature: '' }, { type: 'text', text: 'answer' }],
  }
  assert.deepEqual(toRequestMessages([question, reply], question)[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
  })
})
test('golden refusal discards thinking/text but retains tools and excludes history', () => {
  const reply = settleReply(
    {
      ...empty,
      stopReason: 'refusal',
      blocks: [{ type: 'thinking', thinking: 'fixture' }, tool, { type: 'text', text: 'discard' }],
    },
    'done',
    20
  )
  assert.deepEqual(reply.blocks, [tool])
  assert.equal(canContinueReply(reply), false)
  assert.deepEqual(toRequestMessages([question, reply], question), [
    { role: 'user', content: 'hello' },
  ])
})
test('golden continuation keeps current thinking while ordinary history omits it', () => {
  const reply: AssistantMessage = {
    ...empty,
    status: 'stopped',
    thinking: true,
    blocks: [
      { type: 'thinking', thinking: 'reason', signature: 'fixture' },
      { type: 'text', text: 'answer' },
    ],
  }
  assert.equal(canContinueReply(reply), true)
  assert.deepEqual(toRequestMessages([], question, reply), [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reason', signature: 'fixture' },
        { type: 'text', text: 'answer' },
      ],
    },
  ])
  assert.deepEqual(toRequestMessages([question, reply], question)[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
  })
  assert.equal(canContinueReply({ ...reply, status: 'error' }), false)
  assert.equal(
    canContinueReply({ ...reply, blocks: [{ type: 'text', text: 'notice', isTemplate: true }] }),
    false
  )
})
test('golden regenerate and edit preserve tree and selected path', () => {
  const initial: Session = {
    id: 'c',
    title: '',
    createdAt: 1,
    updatedAt: 1,
    rootMessageId: null,
    messages: [],
  }
  const reply = { ...empty, status: 'done' as const }
  const first = appendBranch(initial, null, [question, reply])
  const second = appendBranch(first, question.id, [{ ...reply, id: 'a2' }])
  const edited = appendBranch(second, null, [
    { ...question, id: 'q2', content: 'edited' },
    { ...reply, id: 'a3' },
  ])
  assert.deepEqual(
    getVisibleMessages(edited).map((m) => m.id),
    ['q2', 'a3']
  )
  assert.deepEqual(
    getVisibleMessages(selectVersion(second, 'a')).map((m) => m.id),
    ['q', 'a']
  )
  assert.deepEqual(
    edited.messages.map((m) => [m.id, m.parentId]),
    [
      ['q', null],
      ['a', 'q'],
      ['a2', 'q'],
      ['q2', null],
      ['a3', 'q2'],
    ]
  )
})

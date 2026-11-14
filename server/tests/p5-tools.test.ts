import test from 'node:test'
import assert from 'node:assert/strict'
import { toRequestMessages } from '../../src/services/chat/reply.js'
import { generationInput } from '../src/generation.js'
import { empty, question, tool, result } from './fixtures/protocol-golden.js'
import type { ReplyBlock } from '../../src/services/chat/types.js'

function history(blocks: ReplyBlock[]) {
  return toRequestMessages(
    [question, { ...empty, status: 'done', blocks: [...blocks, { type: 'text', text: 'answer' }] }],
    { ...question, id: 'next' }
  )[1]
}
test('客户端不能提交任意tools或伪造历史签名', () => {
  const base = { operation: 'send', content: 'hello', idempotencyKey: 'test-key' }
  assert.throws(() => generationInput.parse({ ...base, tools: [{ name: 'exec' }] }))
  assert.throws(() => generationInput.parse({ ...base, messages: [{ signature: 'forged' }] }))
})
test('read_link签名原样回传，引用仅存储展示不再发送', () => {
  const content = history([tool, result])?.content
  assert.ok(Array.isArray(content))
  assert.deepEqual(content[1], result)
})
test('孤立/重复/错序/错误工具名/缺签名结果不回传', () => {
  for (const blocks of [
    [tool],
    [result],
    [tool, tool, result],
    [tool, result, result],
    [result, tool],
    [{ ...tool, name: 'deepseek_web_search' as const }, result],
    [tool, { ...result, signature: '  ' }],
  ]) {
    assert.deepEqual(history(blocks), {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    })
  }
})
test('无签名的合法工具失败对仍保留', () => {
  const failed = {
    ...result,
    signature: undefined,
    content: { type: 'web_fetch_tool_result_error' as const, error_code: 'url_not_accessible' },
  }
  const content = history([tool, failed])?.content
  assert.ok(Array.isArray(content))
  assert.equal(content.length, 3)
  assert.deepEqual(content[1], failed)
})

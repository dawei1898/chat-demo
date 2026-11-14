import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertContextBudget,
  ContextBudgetExceededError,
  DEFAULT_CONTEXT_BUDGET_BYTES,
} from '../src/context-budget.js'

test('按完整 JSON 的 UTF-8 字节计量，包含中文与表情', () => {
  const request = { messages: [{ role: 'user', content: '你好🌍' }] }
  const json = JSON.stringify(request)
  const bytes = Buffer.byteLength(json, 'utf8')
  assert.ok(bytes > json.length)
  assert.equal(assertContextBudget(request), bytes)
  assert.throws(() => assertContextBudget(request, json.length), ContextBudgetExceededError)
})
test('预算边界包含等号，超出一字节拒绝', () => {
  const request = { content: 'abc' }
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  assert.equal(assertContextBudget(request, bytes), bytes)
  assert.throws(() => assertContextBudget(request, bytes - 1), ContextBudgetExceededError)
  assert.equal(DEFAULT_CONTEXT_BUDGET_BYTES, 262144)
  assert.throws(
    () => assertContextBudget({ text: 'x'.repeat(DEFAULT_CONTEXT_BUDGET_BYTES) }),
    ContextBudgetExceededError
  )
})
test('system、工具定义/结果和续写前缀全部计入且不改写请求', () => {
  const request = {
    system: '系统规则',
    tools: [{ name: 'read_url', description: '读取链接', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: '问题' },
      {
        role: 'assistant',
        content: [{ type: 'server_tool_use', id: 'tool', input: { url: 'https://example.test' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool', content: '工具结果' }],
      },
      { role: 'assistant', prefix: true, content: '续写前缀' },
    ],
    max_tokens: 4096,
  }
  const before = JSON.stringify(request)
  const bytes = Buffer.byteLength(before, 'utf8')
  assert.equal(assertContextBudget(request, bytes), bytes)
  const userOnly = Buffer.byteLength(JSON.stringify(request.messages[0]), 'utf8')
  assert.throws(() => assertContextBudget(request, userOnly), ContextBudgetExceededError)
  assert.equal(JSON.stringify(request), before)
})
test('超限错误不包含正文或工具参数', () => {
  const secretContent = 'private-fixture-content'
  assert.throws(
    () => assertContextBudget({ text: secretContent }, 1),
    (error: unknown) => {
      assert.ok(error instanceof ContextBudgetExceededError)
      assert.ok(!error.message.includes(secretContent))
      assert.equal(error.name, 'ContextBudgetExceededError')
      return true
    }
  )
})
test('非法预算及不可序列化请求明确拒绝，不泄漏序列化异常', () => {
  for (const budget of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertContextBudget({}, budget), RangeError)
  }
  assert.throws(() => assertContextBudget(undefined), TypeError)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => assertContextBudget(cyclic), TypeError)
  assert.throws(() => assertContextBudget({ value: 1n }), TypeError)
})

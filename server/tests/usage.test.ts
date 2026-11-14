import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsage, updateAttemptUsage } from '../src/usage.js'
import type { MessageStreamEvent } from '../../src/services/api/types.js'
const delta = (output: number): MessageStreamEvent => ({ type: 'message_delta', delta: {}, usage: {
  input_tokens: 5, output_tokens: output, cache_read_input_tokens: 2, cache_creation_input_tokens: 0,
} })
test('attempt usage overwrites cumulative values instead of adding them', () => {
  const first = updateAttemptUsage(null, delta(3))
  const final = updateAttemptUsage(first, delta(7))
  assert.equal(normalizeUsage(final, true).output, 7)
  assert.equal(normalizeUsage(final, true).completeness, 'complete')
})
test('new attempt has no inherited reply usage and unknown is not zero', () => {
  assert.deepEqual(normalizeUsage(null, false), { raw: null, input: null, output: null, cached: null, completeness: 'unknown' })
  assert.equal(normalizeUsage(updateAttemptUsage(null, delta(2)), true).output, 2)
})
test('cancelled, invalid and missing counts cannot be complete', () => {
  assert.equal(normalizeUsage({ input_tokens: 4, output_tokens: 0 }, false).completeness, 'partial')
  assert.equal(normalizeUsage({ input_tokens: -1, output_tokens: 1 }, true).input, null)
  assert.equal(normalizeUsage({ output_tokens: 1 }, true).completeness, 'partial')
})

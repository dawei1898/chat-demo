import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionEpoch,
  invalidateSession,
  assertCurrentSession,
  onSessionInvalidated,
} from '../../src/services/auth/sessionBoundary.js'

test('注销使旧异步代次失效并通知清理，新的代次仍有效', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  const before = sessionEpoch()
  let cleared = 0
  const cleanup = onSessionInvalidated(() => {
    cleared += 1
  })
  assertCurrentSession(before)
  invalidateSession()
  assert.equal(cleared, 1)
  assert.throws(() => assertCurrentSession(before), { name: 'AbortError' })
  assertCurrentSession(sessionEpoch())
  cleanup()
  invalidateSession()
  assert.equal(cleared, 1)
})

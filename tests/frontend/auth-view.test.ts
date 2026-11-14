import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfirmedIdentity, authGateView } from '../../src/services/auth/sessionView.js'

test('会话刷新和临时错误不改变已确认身份，只有成功空响应退出', () => {
  assert.equal(resolveConfirmedIdentity('A', null, true, false), 'A')
  assert.equal(resolveConfirmedIdentity('A', null, false, true), 'A')
  assert.equal(resolveConfirmedIdentity('A', null, false, false), null)
  assert.equal(resolveConfirmedIdentity('A', 'B', false, false), 'B')
})
test('focus核验、超时和网络失败不出现登录表单，也不显示私有内容', () => {
  const state = { pending: false, unavailable: false, locked: false, userId: 'A', identity: 'A' }
  assert.equal(authGateView(state), 'authenticated')
  assert.equal(authGateView({ ...state, locked: true }), 'checking')
  assert.equal(authGateView({ ...state, unavailable: true }), 'unavailable')
  assert.equal(authGateView({ ...state, pending: true, userId: null }), 'checking')
  assert.equal(authGateView({ ...state, userId: 'B' }), 'checking')
})
test('真实未登录显示表单，连接恢复后回到已认证视图', () => {
  assert.equal(
    authGateView({
      pending: false,
      unavailable: false,
      locked: false,
      userId: null,
      identity: null,
    }),
    'login'
  )
  assert.equal(
    authGateView({ pending: false, unavailable: false, locked: false, userId: 'A', identity: 'A' }),
    'authenticated'
  )
})

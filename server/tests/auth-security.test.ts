import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  trustedPeer,
  registrationPolicy,
  authRateKey,
  enabledAuthPaths,
} from '../src/auth-security.js'

test('注册默认仅本机，关闭开关及公网origin均拒绝', () => {
  assert.equal(
    registrationPolicy('127.0.0.1', 'http://localhost:8095', 'local').registrationEnabled,
    true
  )
  for (const peer of ['203.0.113.2', 'unknown-peer']) {
    assert.equal(
      registrationPolicy(peer, 'http://localhost:8095', 'local').registrationEnabled,
      false
    )
  }
  assert.equal(
    registrationPolicy('127.0.0.1', 'https://example.com', 'local').registrationEnabled,
    false
  )
  assert.equal(
    registrationPolicy('127.0.0.1', 'http://localhost:8095', 'closed').registrationEnabled,
    false
  )
  assert.equal(
    registrationPolicy('127.0.0.1', 'http://localhost:8095', 'invalid').registrationEnabled,
    false
  )
})
test('可信IP只由连接socket获取，伪造转发头不能改变身份', async () => {
  const app = new Hono().get('/', (c) => c.text(trustedPeer(c)))
  const headers = {
    'X-Forwarded-For': '127.0.0.1',
    'X-Real-IP': '127.0.0.1',
    Forwarded: 'for=127.0.0.1',
  }
  const env = {
    incoming: { socket: { remoteAddress: '203.0.113.5', remotePort: 1, remoteFamily: 'IPv4' } },
  }
  assert.equal(await (await app.request('/', { headers }, env)).text(), '203.0.113.5')
  assert.equal(await (await app.request('/', { headers })).text(), 'unknown-peer')
})
test('限流标识是域隔离HMAC，不保存原始邮箱或IP', () => {
  const email = 'test@example.test'
  const key = authRateKey('login-email', email)
  assert.match(key, /^login-email:[0-9a-f]{64}$/)
  assert.ok(!key.includes(email))
  assert.notEqual(key, authRateKey('signup-email', email))
})
test('已取消邮件验证、找回密码和OAuth功能不在认证路由白名单', () => {
  for (const path of [
    '/request-password-reset',
    '/reset-password',
    '/verify-email',
    '/sign-in/social',
    '/%73ign-up/email',
  ]) {
    assert.equal(enabledAuthPaths.has(path), false)
  }
})

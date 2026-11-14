import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const base = 'http://localhost:8095'
async function req(path, method = 'GET', body, cookie = '') {
  return fetch(base + path, {
    method,
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}
const a = await req('/api/conversations')
assert.equal(a.status, 401)
const csrf = await fetch(base + '/api/conversations', {
  method: 'POST',
  headers: { Origin: 'https://not-allowed.invalid', 'Content-Type': 'application/json' },
  body: '{}',
})
assert.equal(csrf.status, 403)
const email = `local-test-${Date.now()}@example.test`
const password = randomUUID() + '!'
const signup = await req('/api/auth/sign-up/email', 'POST', {
  name: 'Local integration test',
  email,
  password,
})
assert.equal(signup.status, 200, 'registration failed')
// 注册不自动登录；需显式登录后获取会话 Cookie。
const signin = await req('/api/auth/sign-in/email', 'POST', { email, password })
assert.equal(signin.status, 200, 'login failed')
const cookies = signin.headers
  .getSetCookie()
  .map((v) => v.split(';')[0])
  .join('; ')
assert.ok(cookies)
const who = await req('/api/auth/get-session', 'GET', undefined, cookies)
assert.equal(who.status, 200)
assert.ok((await who.json()).user)
const create = await req('/api/conversations', 'POST', {}, cookies)
assert.equal(create.status, 201)
const c = await create.json()
const read = await req('/api/conversations/' + c.id, 'GET', undefined, cookies)
assert.equal(read.status, 200)
const rename = await req('/api/conversations/' + c.id, 'PATCH', { title: '本地后端测试' }, cookies)
assert.equal(rename.status, 200)
const list = await req('/api/conversations', 'GET', undefined, cookies)
assert.ok((await list.json()).some((x) => x.id === c.id))
const otherEmail = `isolation-${Date.now()}@example.test`
const otherPassword = randomUUID() + '!'
const otherSignup = await req('/api/auth/sign-up/email', 'POST', {
  name: 'Isolation test',
  email: otherEmail,
  password: otherPassword,
})
assert.equal(otherSignup.status, 200)
const otherSignin = await req('/api/auth/sign-in/email', 'POST', {
  email: otherEmail,
  password: otherPassword,
})
assert.equal(otherSignin.status, 200)
const other = otherSignin.headers
  .getSetCookie()
  .map((v) => v.split(';')[0])
  .join('; ')
const cross = await req('/api/conversations/' + c.id, 'GET', undefined, other)
assert.equal(cross.status, 404)
const del = await req('/api/conversations/' + c.id, 'DELETE', undefined, cookies)
assert.equal(del.status, 204)
const signout = await req('/api/auth/sign-out', 'POST', {}, cookies)
assert.equal(signout.status, 200)
const after = await req('/api/conversations', 'GET', undefined, cookies)
assert.equal(after.status, 401)
process.stdout.write(
  'PASS: unauthenticated, CSRF, registration/session, create/read/rename/list, cross-user isolation, soft delete, logout. Test accounts retained in dev.'
)

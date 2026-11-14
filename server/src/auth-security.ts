import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Queryable } from './store.js'
import { config } from './config.js'

// 当前仅支持本机直连/本机 Rspack 代理，绝不相信客户端 X-Forwarded-For。
// 将来部署代理平台时，必须新增并验证对应平台的可信网络边界，不能直接复用这些假设。
export function trustedPeer(c: Context): string {
  try {
    const address = getConnInfo(c).remote.address
    if (!address || !isIP(address)) {
      return 'unknown-peer'
    }
    return address.startsWith('::ffff:') ? address.slice(7) : address
  } catch {
    return 'unknown-peer'
  }
}
export function isLoopbackPeer(peer: string): boolean {
  return peer === '::1' || (isIP(peer) === 4 && peer.startsWith('127.'))
}
export function registrationPolicy(
  peer: string,
  origin = config.origin,
  mode = process.env.REGISTRATION_MODE || 'local'
) {
  let localOrigin = false
  try {
    const hostname = new URL(origin).hostname
    localOrigin = hostname === 'localhost' || hostname === '[::1]' || isLoopbackPeer(hostname)
  } catch {
    /* 非法配置一律关闭注册 */
  }
  const registrationMode = mode === 'local' ? 'local' : 'closed'
  return {
    registrationMode,
    registrationEnabled:
      registrationMode === 'local' &&
      localOrigin &&
      isLoopbackPeer(peer) &&
      process.env.NODE_ENV !== 'production',
  }
}
export function authRateKey(scope: string, value: string): string {
  // 表中只存带域隔离的 HMAC，不保存原始邮箱/IP。密钥只来自服务端配置。
  return scope + ':' + createHmac('sha256', config.secret).update(value).digest('hex')
}
export async function consumeAuthRate(
  q: Queryable,
  key: string,
  max: number,
  windowSeconds: number
) {
  // 使用数据库时间及原子 UPSERT；多个进程/并发请求不会丢失计数。
  const result = await q.query(
    `INSERT INTO auth_rate_limit(key,count,reset_at)
    VALUES($1,1,clock_timestamp()+$3*INTERVAL '1 second')
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN auth_rate_limit.reset_at<=clock_timestamp() THEN 1 ELSE LEAST(auth_rate_limit.count+1,$2+1) END,
      reset_at=CASE WHEN auth_rate_limit.reset_at<=clock_timestamp() THEN clock_timestamp()+$3*INTERVAL '1 second' ELSE auth_rate_limit.reset_at END
    RETURNING count <= $2 AS allowed, GREATEST(1,CEIL(EXTRACT(EPOCH FROM reset_at-clock_timestamp())))::int AS retry_after`,
    [key, max, windowSeconds]
  )
  return {
    allowed: result.rows[0].allowed as boolean,
    retryAfter: result.rows[0].retry_after as number,
  }
}
// 未纳入本轮的找回密码、邮件验证和 OAuth 路由一律不向外开放。
export const enabledAuthPaths = new Set([
  '/sign-up/email',
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/change-password',
  '/update-user',
])
export async function applyAuthLimits(q: Queryable, peer: string, path: string, request: Request) {
  const global = await consumeAuthRate(q, authRateKey('auth-peer', peer), 120, 60)
  if (!global.allowed) {
    return global
  }
  if (request.method !== 'POST') {
    return global
  }
  if (path === '/sign-up/email') {
    return consumeAuthRate(q, authRateKey('signup-peer', peer), 5, 3600)
  }
  if (path !== '/sign-in/email') {
    return global
  }
  const ip = await consumeAuthRate(q, authRateKey('login-peer', peer), 20, 300)
  if (!ip.allowed) {
    return ip
  }
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return ip
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('email' in body) ||
    typeof body.email !== 'string'
  ) {
    return ip
  }
  const email = body.email.trim().toLowerCase().slice(0, 320)
  return consumeAuthRate(q, authRateKey('login-email', email), 10, 300)
}
export async function sessionIsLive(
  q: Queryable,
  userId: string,
  sessionId: string
): Promise<boolean> {
  // 只按非 bearer 的 session.id 查询；不读取/记录 session.token。
  const found = await q.query(
    'SELECT id FROM session WHERE id=$1 AND user_id=$2 AND expires_at>NOW()',
    [sessionId, userId]
  )
  return !!found.rowCount
}

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db/client.js'
import * as schema from './db/schema.js'
import { config } from './config.js'
// 使用自托管 Better Auth 与业务库共享连接，但认证表及令牌由认证库管理。
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  baseURL: config.origin,
  basePath: '/api/auth',
  secret: config.secret,
  // 仅信任明确配置的前端源；本地 localhost 与 127.0.0.1 不应混用。
  trustedOrigins: [config.origin],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    // 仅供本地开发；接入真实发信链路前不开放公网注册。
    requireEmailVerification: false,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    // 每次向服务端核验会话，避免缓存延迟反映撤销状态。
    cookieCache: { enabled: false },
  },
  rateLimit: { enabled: true, window: 60, max: 60 },
})

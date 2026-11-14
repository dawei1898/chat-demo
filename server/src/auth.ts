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
    // 新注册和重复注册均不自动登录，使用库的合成用户通用响应降低账号枚举风险。
    autoSignIn: false,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    // 用户已取消邮箱验证；邮箱只作登录标识，注册边界由前置策略控制。
    requireEmailVerification: false,
    disableSignUp: process.env.REGISTRATION_MODE === 'closed',
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    // 每次向服务端核验会话，避免缓存延迟反映撤销状态。
    cookieCache: { enabled: false },
  },
  // 由 Hono 前置数据库限流处理；避免默认内存限流和不可信转发头。
  rateLimit: { enabled: false },
  // 库的 info 级重复注册日志包含邮箱；本地只保留警告和错误。
  logger: { level: 'warn' },
  advanced: { ipAddress: { ipAddressHeaders: [] } },
})

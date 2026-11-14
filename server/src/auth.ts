import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db/client.js'
import * as schema from './db/schema.js'
import { config } from './config.js'
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  baseURL: config.origin,
  basePath: '/api/auth',
  secret: config.secret,
  trustedOrigins: [config.origin],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    requireEmailVerification: false,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false },
  },
  rateLimit: { enabled: true, window: 60, max: 60 },
})

import 'dotenv/config'
export const config = {
  origin: process.env.BETTER_AUTH_URL || 'http://localhost:8095',
  databaseUrl: process.env.DATABASE_URL || '',
  secret: process.env.BETTER_AUTH_SECRET || '',
  deepseekKey: process.env.DEEPSEEK_API_KEY || '',
  port: Number(process.env.API_PORT || 8096),
  maxTokens: Math.min(8192, Math.max(256, Number(process.env.MAX_OUTPUT_TOKENS || 4096))),
}
export function validateConfig() {
  if (!config.databaseUrl || config.secret.length < 32) {
    throw new Error('Configure DATABASE_URL and a 32+ character BETTER_AUTH_SECRET in .env')
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This local development implementation is not yet approved for production')
  }
}

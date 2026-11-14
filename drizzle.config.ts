import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'
// eslint-disable-next-line import/no-default-export
export default defineConfig({
  schema: './server/src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || '' },
})

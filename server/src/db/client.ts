import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { config } from '../config.js'
import * as schema from './schema.js'
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
})
export const db = drizzle(pool, { schema })

import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { config } from '../config.js'
import * as schema from './schema.js'
// 模块级复用有限连接池；流式等待模型时不能长期占用事务或连接。
// 连接串保留 TLS 校验，应用使用 pooled 地址，迁移使用独立 direct 地址。
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
})
export const db = drizzle(pool, { schema })

import { serve } from '@hono/node-server'
import { app } from './app.js'
import { config, validateConfig } from './config.js'
import { pool } from './db/client.js'
validateConfig()
// 只监听回环地址；浏览器经 8095 的同源代理访问，不直接暴露后端端口。
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, () =>
  process.stdout.write(`Local API listening at http://127.0.0.1:${config.port}\n`)
)
// 先停止接收请求，再关闭数据库池；异常中断后的任务由租约恢复处理。
const stop = () =>
  server.close(() => {
    void pool.end().then(() => process.exit(0))
  })
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

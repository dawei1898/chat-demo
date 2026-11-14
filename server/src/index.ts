import { serve } from '@hono/node-server'
import { app } from './app.js'
import { config, validateConfig } from './config.js'
import { pool } from './db/client.js'
validateConfig()
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, () =>
  process.stdout.write(`Local API listening at http://127.0.0.1:${config.port}\n`)
)
const stop = () =>
  server.close(() => {
    void pool.end().then(() => process.exit(0))
  })
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

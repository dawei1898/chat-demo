import type { PoolClient } from 'pg'
import { pool } from './db/client.js'
import type { Session, Message } from '../../src/services/chat/types.js'
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
export type Queryable = Pick<PoolClient, 'query'>
export async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
export async function loadSession(
  q: Queryable,
  userId: string,
  id: string,
  lock = false
): Promise<Session> {
  const r = await q.query(
    `SELECT * FROM conversation WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id, userId]
  )
  if (!r.rows[0]) {
    throw new HttpError(404, '会话不存在')
  }
  const c = r.rows[0]
  const messages = await q.query(
    'SELECT payload FROM message WHERE conversation_id=$1 ORDER BY created_at,id',
    [id]
  )
  return {
    id,
    title: c.title,
    createdAt: c.created_at.getTime(),
    updatedAt: c.updated_at.getTime(),
    rootMessageId: c.root_message_id,
    messages: messages.rows.map((r) => r.payload as Message),
  }
}
export async function saveSession(q: Queryable, s: Session): Promise<void> {
  await q.query(
    'UPDATE conversation SET title=$2,root_message_id=$3,updated_at=$4,version=version+1 WHERE id=$1',
    [s.id, s.title, s.rootMessageId ?? null, new Date(s.updatedAt)]
  )
  for (const m of s.messages) {
    await q.query(
      `INSERT INTO message(id,conversation_id,parent_id,selected_child_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,selected_child_id=excluded.selected_child_id,payload=excluded.payload WHERE message.conversation_id=excluded.conversation_id`,
      [
        m.id,
        s.id,
        m.parentId ?? null,
        m.selectedChildId ?? null,
        JSON.stringify(m),
        new Date(m.createdAt),
      ]
    )
  }
}
export async function assertIdle(q: Queryable, id: string) {
  const r = await q.query(
    "SELECT id FROM generation_run WHERE conversation_id=$1 AND status='running'",
    [id]
  )
  if (r.rowCount) {
    throw new HttpError(409, '此会话正在生成，请先停止或稍后重试')
  }
}
// Crash recovery never guesses success. Partial durable content is retained.
export async function recoverStale(userId: string) {
  const stale = await pool.query(
    "SELECT id,conversation_id,message_id FROM generation_run WHERE user_id=$1 AND status='running' AND heartbeat_at < NOW()-INTERVAL '60 seconds'",
    [userId]
  )
  for (const r of stale.rows) {
    await inTransaction(async (q) => {
      await q.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [r.conversation_id])
      const update = await q.query(
        "UPDATE generation_run SET status='interrupted',finished_at=NOW(),error='服务中断' WHERE id=$1 AND status='running' AND heartbeat_at < NOW()-INTERVAL '60 seconds' RETURNING id",
        [r.id]
      )
      if (update.rowCount) {
        await q.query(
          `UPDATE message SET payload=jsonb_set(jsonb_set(payload,'{status}','"stopped"'),'{error}','null') WHERE id=$1 AND conversation_id=$2`,
          [r.message_id, r.conversation_id]
        )
      }
    })
  }
}

import type { PoolClient } from 'pg'
import { pool } from './db/client.js'
import { assertMessageTree } from './message-tree.js'
import type { Session, Message } from '../../src/services/chat/types.js'
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message)
  }
}
export type Queryable = Pick<PoolClient, 'query'>
/** 仅包裹短数据库操作；异常统一回滚，连接始终归还池中。 */
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
/** 先核验用户归属和软删状态，再加载整棵消息树；写操作可锁定会话行。 */
export async function loadSession(
  q: Queryable,
  userId: string,
  id: string,
  lock = false
): Promise<Session> {
  if (lock) {
    // 先等到行锁，再开始读取快照，避免等待其他事务时读到旧消息正文。
    await q.query(
      'SELECT id FROM conversation WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',
      [id, userId]
    )
  }
  const r = await q.query(
    `SELECT conversation.*,COALESCE((SELECT jsonb_agg(payload ORDER BY created_at,id) FROM message WHERE conversation_id=conversation.id),'[]'::jsonb) AS messages FROM conversation WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [id, userId]
  )
  if (!r.rows[0]) {
    throw new HttpError(404, '会话不存在')
  }
  const c = r.rows[0]

  return {
    id,
    title: c.title,
    revision: c.version,
    createdAt: c.created_at.getTime(),
    updatedAt: c.updated_at.getTime(),
    rootMessageId: c.root_message_id,
    messages: c.messages as Message[],
  }
}
/** 应在事务中调用：先校验完整树，再原子保存关系字段和展示用 payload。 */
export async function saveSession(q: Queryable, s: Session): Promise<void> {
  if (s.view === 'branch' || s.treeIndex !== undefined) {
    throw new HttpError(400, '部分消息视图不可作为完整树保存')
  }
  assertMessageTree(s)
  const updated = await q.query(
    'UPDATE conversation SET title=$2,root_message_id=$3,updated_at=$4,version=version+1 WHERE id=$1 RETURNING version',
    [s.id, s.title, s.rootMessageId ?? null, new Date(s.updatedAt)]
  )
  s.revision = updated.rows[0].version
  // 一次批量写入避免 N 次数据库往返；未变化的 payload 不触发 UPDATE。
  const written = await q.query(
    `INSERT INTO message(id,conversation_id,parent_id,selected_child_id,payload,created_at)
      SELECT x.id,$1,x.parent_id,x.selected_child_id,x.payload,to_timestamp(x.created_at / 1000.0)
      FROM jsonb_to_recordset($2::jsonb) AS x(id text,parent_id text,selected_child_id text,payload jsonb,created_at bigint)
      ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,
        selected_child_id=excluded.selected_child_id,payload=excluded.payload
      WHERE message.conversation_id=excluded.conversation_id
        AND (message.parent_id,message.selected_child_id,message.payload)
          IS DISTINCT FROM (excluded.parent_id,excluded.selected_child_id,excluded.payload)
      RETURNING id`,
    [
      s.id,
      JSON.stringify(
        s.messages.map((m) => ({
          id: m.id,
          parent_id: m.parentId ?? null,
          selected_child_id: m.selectedChildId ?? null,
          payload: m,
          created_at: m.createdAt,
        }))
      ),
    ]
  )
  // 未改动节点不会 RETURNING，另查归属冲突，异常使整个事务回滚。
  if (written.rowCount !== s.messages.length) {
    const conflicts = await q.query(
      'SELECT id FROM message WHERE id=ANY($1::text[]) AND conversation_id<>$2 LIMIT 1',
      [s.messages.map((m) => m.id), s.id]
    )
    if (conflicts.rowCount) {
      throw new HttpError(409, '消息标识已被其他会话使用')
    }
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
// 心跳超时只认定中断，绝不猜测模型已完成；保留最近落库的部分内容。
export async function recoverStale(userId: string) {
  const stale = await pool.query(
    "SELECT id,conversation_id,message_id FROM generation_run WHERE user_id=$1 AND status='running' AND heartbeat_at < NOW()-INTERVAL '60 seconds'",
    [userId]
  )
  for (const r of stale.rows) {
    await inTransaction(async (q) => {
      await q.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [r.conversation_id])
      // 在锁内再次检查租约，避免首次查询后心跳恢复却仍被错误回收。
      const update = await q.query(
        "UPDATE generation_run SET status='interrupted',finished_at=NOW(),error='服务中断' WHERE id=$1 AND status='running' AND heartbeat_at < NOW()-INTERVAL '60 seconds' RETURNING id",
        [r.id]
      )
      if (update.rowCount) {
        await q.query('UPDATE conversation SET version=version+1,updated_at=NOW() WHERE id=$1', [
          r.conversation_id,
        ])
        await q.query(
          `UPDATE message SET payload=jsonb_set(jsonb_set(payload,'{status}','"stopped"'),'{error}','null') WHERE id=$1 AND conversation_id=$2`,
          [r.message_id, r.conversation_id]
        )
      }
    })
  }
}

/** 调用方必须先锁住会话，避免检查与更新之间出现竞争。 */
export function assertRevision(session: Session, expected: number | undefined) {
  if (expected !== undefined && session.revision !== expected) {
    throw new HttpError(409, '会话已在其他窗口更新，请刷新后重试', 'REVISION_CONFLICT')
  }
}

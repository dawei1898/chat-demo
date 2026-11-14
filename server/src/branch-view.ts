import type { Session } from '../../src/services/chat/types.js'
import { getVisibleMessages } from '../../src/services/chat/branches.js'
import { HttpError, type Queryable } from './store.js'

export const BRANCH_PAGE_SIZE = 50

/** 明确标记部分视图，禁止作为完整树直接写回。 */
export function branchView(session: Session, beforeId?: string) {
  const path = getVisibleMessages(session)
  const end = beforeId ? path.findIndex((m) => m.id === beforeId) : path.length
  if (end < 0) {
    throw new HttpError(400, '历史游标不在当前分支', 'INVALID_MESSAGE_CURSOR')
  }
  const start = Math.max(0, end - BRANCH_PAGE_SIZE)
  const messages = path.slice(start, end)
  return {
    ...session,
    view: 'branch' as const,
    messages,
    treeIndex: session.messages.map(({ id, parentId, selectedChildId, role, createdAt }) => ({
      id,
      parentId: parentId ?? null,
      selectedChildId,
      role,
      createdAt,
    })),
    hasEarlier: start > 0,
    beforeId: messages[0]?.id ?? null,
  }
}

/** 单条 SQL 的一致快照只传输当前窗口正文，其余节点仅返回导航索引。 */
export async function loadBranch(q: Queryable, userId: string, id: string, beforeId?: string) {
  const result = await q.query(
    `
    WITH RECURSIVE owned AS (
      SELECT * FROM conversation WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
    ), path AS (
      SELECT m.id,m.selected_child_id,m.payload,1 AS depth
      FROM message m JOIN owned c ON m.id=c.root_message_id AND m.conversation_id=c.id
      UNION ALL
      SELECT m.id,m.selected_child_id,m.payload,p.depth+1
      FROM path p JOIN message m ON m.id=p.selected_child_id AND m.conversation_id=$1
    ), page_window AS (
      SELECT * FROM path WHERE depth < COALESCE((SELECT depth FROM path WHERE id=$3),2147483647)
      ORDER BY depth DESC LIMIT 51
    )
    SELECT c.*,
      ($3::text IS NULL OR EXISTS(SELECT 1 FROM path WHERE id=$3)) AS valid_cursor,
      (SELECT count(*) FROM page_window)>50 AS has_earlier,
      COALESCE((SELECT jsonb_agg(payload ORDER BY depth) FROM (SELECT * FROM page_window ORDER BY depth DESC LIMIT 50) page),'[]'::jsonb) AS messages,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'parentId',m.parent_id,
        'selectedChildId',m.selected_child_id,'role',m.payload->>'role',
        'createdAt',m.payload->'createdAt') ORDER BY m.created_at,m.id)
        FROM message m WHERE m.conversation_id=c.id),'[]'::jsonb) AS tree_index
    FROM owned c`,
    [id, userId, beforeId ?? null]
  )
  const c = result.rows[0]
  if (!c) {
    throw new HttpError(404, '会话不存在')
  }
  if (!c.valid_cursor) {
    throw new HttpError(400, '历史游标不在当前分支', 'INVALID_MESSAGE_CURSOR')
  }
  return {
    id: c.id,
    title: c.title,
    revision: c.version,
    createdAt: c.created_at.getTime(),
    updatedAt: c.updated_at.getTime(),
    rootMessageId: c.root_message_id,
    view: 'branch' as const,
    messages: c.messages,
    treeIndex: c.tree_index,
    hasEarlier: c.has_earlier,
    beforeId: c.messages[0]?.id ?? null,
  }
}

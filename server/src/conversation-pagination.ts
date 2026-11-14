import type { Pool } from 'pg'
import type { SessionSummary } from '../../src/services/chat/types.js'

export class PaginationError extends Error {}

type Cursor = { v: 1; updatedAt: string; id: string }
export type ConversationPagination = { limit: number; cursor: Cursor | null }
export type ConversationPage = { items: SessionSummary[]; nextCursor: string | null }

const invalid = () => new PaginationError('分页参数无效')
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !timestampPattern.test(value)) {
    return false
  }
  // PG timestamp is timezone-free; retain all six fractional digits in the cursor.
  // Date is used only to reject impossible calendar values, never to build the cursor.
  const milliseconds = value.slice(0, 23) + 'Z'
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds
}

export function encodeConversationCursor(updatedAt: string, id: string): string {
  if (!isTimestamp(updatedAt) || !id || id.length > 128) {
    throw invalid()
  }
  return Buffer.from(JSON.stringify({ v: 1, updatedAt, id } satisfies Cursor)).toString('base64url')
}

function decodeCursor(value: string): Cursor {
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalid()
  }
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) {
      throw invalid()
    }
    const decoded: unknown = JSON.parse(bytes.toString('utf8'))
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw invalid()
    }
    const record = decoded as Record<string, unknown>
    if (
      Object.keys(record).length !== 3 ||
      record.v !== 1 ||
      !isTimestamp(record.updatedAt) ||
      typeof record.id !== 'string' ||
      record.id.length === 0 ||
      record.id.length > 128
    ) {
      throw invalid()
    }
    return { v: 1, updatedAt: record.updatedAt, id: record.id }
  } catch {
    throw invalid()
  }
}

export function parseConversationPagination(query: URLSearchParams): ConversationPagination {
  if (query.getAll('limit').length > 1 || query.getAll('cursor').length > 1) {
    throw invalid()
  }
  const rawLimit = query.get('limit')
  if (rawLimit !== null && !/^(?:[1-9]\d?|100)$/.test(rawLimit)) {
    throw invalid()
  }
  const rawCursor = query.get('cursor')
  return {
    limit: rawLimit === null ? 50 : Number(rawLimit),
    cursor: rawCursor === null ? null : decodeCursor(rawCursor),
  }
}

type ConversationRow = {
  id: string
  title: string
  created_at: Date
  updated_at: Date
  cursor_updated_at: string
}

export async function listConversationPage(
  db: Pick<Pool, 'query'>,
  userId: string,
  pagination: ConversationPagination
): Promise<ConversationPage> {
  const { limit, cursor } = pagination
  const values: (string | number)[] = [userId]
  let boundary = ''
  if (cursor) {
    values.push(cursor.updatedAt, cursor.id)
    boundary = ' AND (updated_at,id) < ($2::timestamp,$3::text)'
  }
  values.push(limit + 1)
  const result = await db.query<ConversationRow>(
    `SELECT id,title,created_at,updated_at,
      to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_updated_at
     FROM conversation
     WHERE user_id=$1 AND deleted_at IS NULL${boundary}
     ORDER BY updated_at DESC,id DESC LIMIT $${values.length}`,
    values
  )
  const rows = result.rows.slice(0, limit)
  const last = rows.at(-1)
  return {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
    })),
    nextCursor:
      result.rows.length > limit && last
        ? encodeConversationCursor(last.cursor_updated_at, last.id)
        : null,
  }
}

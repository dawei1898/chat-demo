import { sql } from 'drizzle-orm'
import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  bigint,
  check,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import type { Message } from '../../../src/services/chat/types.js'
// 认证表由 Better Auth 使用；业务数据清理不得连带删除账号和登录状态。
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})
export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
// 会话保存归属、选中根节点与版本；deletedAt 是业务软删标记。
export const conversation = pgTable(
  'conversation',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    rootMessageId: text('root_message_id'),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    index('conversation_user_updated').on(t.userId, t.updatedAt),
    uniqueIndex('conversation_id_owner').on(t.id, t.userId),
  ]
)
// 关系列用于数据库约束，payload 保留完整展示协议；两者必须同步写入。
export const message = pgTable(
  'message',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    selectedChildId: text('selected_child_id'),
    payload: jsonb('payload').$type<Message>().notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('message_conversation_created').on(t.conversationId, t.createdAt),
    uniqueIndex('message_id_conversation').on(t.id, t.conversationId),
  ]
)
// 一次生成对应独立任务；幂等键与活动任务索引共同防止重复生成。
export const generationRun = pgTable(
  'generation_run',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    // 会话可被撤销或删除，保留审计ID而不建立阻止注销的外键。该值不是会话token。
    authSessionId: text('auth_session_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    // 请求语义指纹用于同键重试核验；旧记录null不可推断为相同请求，也不回填旧内容。
    requestHash: text('request_hash'),
    operation: text('operation').notNull(),
    status: text('status').notNull(),
    usage: jsonb('usage'),
    error: text('error'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    heartbeatAt: timestamp('heartbeat_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
  },
  (t) => [
    uniqueIndex('generation_user_idempotency').on(t.userId, t.idempotencyKey),
    index('generation_conversation').on(t.conversationId),
    uniqueIndex('generation_one_running_per_conversation')
      .on(t.conversationId)
      .where(sql`${t.status} = 'running'`),
  ]
)

// 延迟复合外键、payload 检查及消息树触发器由 migrations/0001_* SQL 维护。
// Drizzle 无法完整表达这些延迟约束；修改表结构必须走版本化迁移，不能用 push 替代。

// 每次任务独立记账；未知 token 不补零，续写不能重复累计上一任务用量。
export const usageRecord = pgTable(
  'usage_record',
  {
    generationId: text('generation_id')
      .primaryKey()
      .references(() => generationRun.id),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    rawUsage: jsonb('raw_usage'),
    completeness: text('completeness').notNull().default('unknown'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'usage_counts_nonnegative',
      sql`${t.inputTokens} >= 0 AND ${t.cachedInputTokens} >= 0 AND ${t.outputTokens} >= 0`
    ),
    check('usage_completeness_valid', sql`${t.completeness} IN ('unknown','partial','complete')`),
  ]
)

// 自建认证限流使用原子数据库计数，进程重启不会清空窗口。
export const authRateLimit = pgTable(
  'auth_rate_limit',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('auth_rate_count_positive', sql`${t.count} > 0`),
    index('auth_rate_expiry').on(t.resetAt),
  ]
)

// 原件只交给 DeepSeek Files；业务库只存归属、状态和私有供应商引用，不存原文。
export const attachment = pgTable(
  'attachment',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    uploadKey: text('upload_key').notNull(),
    contentHash: text('content_hash').notNull(),
    name: text('name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mimeType: text('mime_type').notNull(),
    isImage: boolean('is_image').notNull(),
    purpose: text('purpose').notNull(),
    providerFileId: text('provider_file_id'),
    status: text('status').notNull().default('pending'),
    errorCode: text('error_code'),
    cleanupPending: boolean('cleanup_pending').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    uniqueIndex('attachment_owner_upload_key').on(t.userId, t.uploadKey),
    index('attachment_owner_status').on(t.userId, t.status),
    check('attachment_size_valid', sql`${t.sizeBytes}>0 AND ${t.sizeBytes}<=8388608`),
    check(
      'attachment_status_valid',
      sql`${t.status} IN ('pending','ready','failed','unknown','deleted')`
    ),
    check(
      'attachment_ready_has_provider',
      sql`${t.status}<>'ready' OR ${t.providerFileId} IS NOT NULL`
    ),
  ]
)

// 分支复用同一附件时只增加引用；移除草稿不能删除已被历史消息使用的文件。
export const attachmentReference = pgTable(
  'attachment_reference',
  {
    attachmentId: text('attachment_id')
      .notNull()
      .references(() => attachment.id),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id),
  },
  (t) => [uniqueIndex('attachment_message_unique').on(t.attachmentId, t.messageId)]
)

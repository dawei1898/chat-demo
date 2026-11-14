import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import type { Message } from '../../../src/services/chat/types.js'
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
  (t) => [index('conversation_user_updated').on(t.userId, t.updatedAt)]
)
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
  (t) => [index('message_conversation_created').on(t.conversationId, t.createdAt)]
)
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
    idempotencyKey: text('idempotency_key').notNull(),
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
  ]
)

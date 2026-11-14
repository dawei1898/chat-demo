import { updateAttemptUsage, normalizeUsage } from './usage.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pool } from './db/client.js'
import { config } from './config.js'
import { sessionIsLive } from './auth-security.js'
import { HttpError, inTransaction, loadSession, saveSession, assertIdle } from './store.js'
import { appendBranch, getVisibleMessages } from '../../src/services/chat/branches.js'
import {
  applyEvent,
  settleReply,
  canContinueReply,
  toRequestMessages,
} from '../../src/services/chat/reply.js'
import { readServerSentEvents } from '../../src/services/api/sse.js'
import { readMessageEvent } from '../../src/services/api/parseEvent.js'
import type { AssistantMessage, UserMessage, Message } from '../../src/services/chat/types.js'
import type { CreateMessageRequest } from '../../src/services/api/types.js'
// 客户端只能提交操作和开关，不能伪造用户归属、历史消息或上游工具参数。
export const generationInput = z
  .object({
    operation: z.enum(['send', 'edit', 'regenerate', 'continue']),
    content: z.string().trim().max(32000).optional(),
    messageId: z.string().max(128).optional(),
    parentId: z.string().max(128).nullable().optional(),
    thinking: z.boolean().default(false),
    search: z.boolean().default(false),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict()
export type GenerationInput = z.infer<typeof generationInput>
// 进程内索引仅加速取消，正确性仍依赖数据库的取消标记与运行状态。
const active = new Map<string, AbortController>()
export function cancelActive(id: string) {
  active.get(id)?.abort()
}
/** 短事务内锁定会话、检查幂等和分支、预建回答与账本；不在事务内请求模型。 */
export async function prepare(
  userId: string,
  conversationId: string,
  input: GenerationInput,
  authSessionId?: string
) {
  if (!config.deepseekKey) {
    throw new HttpError(503, '请在本机 .env 配置新的 DEEPSEEK_API_KEY')
  }
  return inTransaction(async (q) => {
    if (authSessionId && !(await sessionIsLive(q, userId, authSessionId))) {
      throw new HttpError(401, '登录已失效，请重新登录')
    }
    let session = await loadSession(q, userId, conversationId, true)
    const duplicate = await q.query(
      'SELECT id,status FROM generation_run WHERE user_id=$1 AND idempotency_key=$2',
      [userId, input.idempotencyKey]
    )
    if (duplicate.rowCount) {
      throw new HttpError(409, '此请求已经提交，请刷新会话查看结果，不要重复生成')
    }
    await assertIdle(q, conversationId)
    const recent = await q.query(
      "SELECT COUNT(*)::int AS n FROM generation_run WHERE user_id=$1 AND created_at>NOW()-INTERVAL '1 minute'",
      [userId]
    )
    if (recent.rows[0].n >= 10) {
      throw new HttpError(429, '调用过于频繁，请稍后再试')
    }
    const path = getVisibleMessages(session)
    const now = Date.now()
    let history: Message[] = []
    let question: UserMessage
    let prefix: AssistantMessage | undefined
    let reply: AssistantMessage = {
      id: randomUUID(),
      role: 'assistant',
      createdAt: now,
      model: 'deepseek-flash',
      thinking: input.thinking,
      search: input.search,
      prefix: true,
      status: 'pending',
      blocks: [],
    }
    if (input.operation === 'send') {
      if (!input.content) {
        throw new HttpError(400, '消息不能为空')
      }
      const parent = path.at(-1)
      if (input.parentId !== undefined && input.parentId !== (parent?.id ?? null)) {
        throw new HttpError(409, '分支已变化，请刷新')
      }
      if (parent?.role === 'user') {
        throw new HttpError(409, '当前分支缺少回答')
      }
      history = path
      question = {
        id: randomUUID(),
        role: 'user',
        content: input.content,
        files: [],
        createdAt: now,
      }
      session = appendBranch(session, parent?.id ?? null, [question, reply])
    } else {
      const index = path.findIndex((m) => m.id === input.messageId)
      if (index < 0) {
        throw new HttpError(404, '消息不在当前分支')
      }
      const target = path[index]
      if (input.operation === 'edit') {
        if (target.role !== 'user' || !input.content) {
          throw new HttpError(400, '只能编辑用户文本消息')
        }
        history = path.slice(0, index)
        question = {
          ...target,
          id: randomUUID(),
          content: input.content,
          createdAt: now,
          selectedChildId: undefined,
        }
        session = appendBranch(session, target.parentId ?? null, [question, reply])
      } else {
        if (target.role !== 'assistant' || path[index - 1]?.role !== 'user') {
          throw new HttpError(400, '请选择有效回答')
        }
        question = path[index - 1] as UserMessage
        history = path.slice(0, index - 1)
        if (input.operation === 'continue') {
          if (index !== path.length - 1 || !canContinueReply(target)) {
            throw new HttpError(400, '此回答不支持继续生成')
          }
          prefix = target
          reply = { ...target, status: 'pending', error: undefined }
          session = {
            ...session,
            messages: session.messages.map((m) => (m.id === reply.id ? reply : m)),
          }
        } else {
          session = appendBranch(session, question.id, [reply])
        }
      }
    }
    if (question.files.length || history.some((m) => m.role === 'user' && m.files.length)) {
      throw new HttpError(400, '本地第一阶段暂不支持附件会话')
    }
    // appendBranch 在节点副本上补齐 parent/selectedChild。
    // 后续流式更新必须使用树内权威节点，避免旧对象覆盖关系元数据。
    const linkedReply = session.messages.find((m) => m.id === reply.id)
    if (!linkedReply || linkedReply.role !== 'assistant') {
      throw new HttpError(500, '生成消息状态异常')
    }
    reply = linkedReply
    session.updatedAt = now
    await saveSession(q, session)
    const runId = randomUUID()
    await q.query(
      "INSERT INTO generation_run(id,user_id,conversation_id,message_id,idempotency_key,operation,status,auth_session_id) VALUES($1,$2,$3,$4,$5,$6,'running',$7)",
      [
        runId,
        userId,
        conversationId,
        reply.id,
        input.idempotencyKey,
        input.operation,
        authSessionId ?? null,
      ]
    )
    await q.query('INSERT INTO usage_record(generation_id) VALUES($1)', [runId])
    const body: CreateMessageRequest & { max_tokens: number } = {
      model: 'deepseek-flash',
      max_tokens: config.maxTokens,
      system: '该助手为DeepSeek，由深度求索公司创造。',
      messages: toRequestMessages(history, question, prefix, reply.thinking, reply.latestReminder),
      thinking: { type: reply.thinking ? 'enabled' : 'disabled' },
      tools: [
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
        ...(reply.search
          ? [{ type: 'deepseek_web_search' as const, name: 'deepseek_web_search' as const }]
          : []),
      ],
      safety_check: { level: 'high' },
      title: { enabled: !session.title },
    }
    return { session, reply, runId, body, userId, authSessionId }
  })
}
/** 事务外消费上游事件，通过短检查点事务保存部分结果，结束时原子结算。 */
export async function execute(
  prepared: Awaited<ReturnType<typeof prepare>>,
  signal: AbortSignal,
  emit: (event: string, data: unknown) => Promise<void>
) {
  const { runId } = prepared
  let session = prepared.session
  let reply: AssistantMessage = { ...prepared.reply, usage: undefined }
  // 续写复用回答节点，但本次任务的用量从空值开始，不继承前次账本。
  let attemptUsage: Record<string, unknown> | null = null
  let sawFinalUsage = false
  const controller = new AbortController()
  active.set(runId, controller)
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, 240000)
  let sessionExpired = false
  let seenStop = false
  let errorMessage: string | undefined
  const indexes = new Map<number, number>()
  let lastSnapshot = 0
  let lastPersist = 0
  let pollBusy = false
  const current = () => ({
    ...session,
    updatedAt: Date.now(),
    messages: session.messages.map((m) => (m.id === reply.id ? reply : m)),
  })
  // 锁定会话后只更新仍在运行的任务，避免覆盖已完成或已回收的状态。
  const checkpoint = async () => {
    await inTransaction(async (q) => {
      await q.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [session.id])
      const r = await q.query(
        "UPDATE generation_run SET heartbeat_at=NOW() WHERE id=$1 AND status='running' RETURNING id",
        [runId]
      )
      if (!r.rowCount) {
        controller.abort()
        return
      }
      await q.query('UPDATE message SET payload=$2 WHERE id=$1', [reply.id, JSON.stringify(reply)])
    })
  }
  // 心跳表明进程仍存活，不代表模型有输出进展。
  const heartbeat = setInterval(() => {
    void pool
      .query("UPDATE generation_run SET heartbeat_at=NOW() WHERE id=$1 AND status='running'", [
        runId,
      ])
      .catch(abort)
  }, 10000)
  // 跨实例取消通过数据库轮询传播，防止只中止浏览器却持续消耗模型资源。
  const poll = setInterval(() => {
    if (pollBusy) {
      return
    }
    pollBusy = true
    void pool
      .query(
        `SELECT r.cancel_requested,r.status,CASE WHEN r.auth_session_id IS NULL THEN true ELSE EXISTS(SELECT 1 FROM session s WHERE s.id=r.auth_session_id AND s.user_id=r.user_id AND s.expires_at>NOW()) END AS session_live FROM generation_run r WHERE r.id=$1`,
        [runId]
      )
      .then((r) => {
        if (r.rows[0]?.session_live === false) {
          sessionExpired = true
          abort()
        }
        if (r.rows[0]?.cancel_requested || r.rows[0]?.status !== 'running') {
          abort()
        }
      })
      .catch(abort)
      .finally(() => {
        pollBusy = false
      })
  }, 1500)
  try {
    if (
      prepared.authSessionId &&
      !(await sessionIsLive(pool, prepared.userId, prepared.authSessionId))
    ) {
      sessionExpired = true
      abort()
    }
    controller.signal.throwIfAborted()
    await emit('snapshot', { session, runId })
    const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.deepseekKey,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...prepared.body, stream: true }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`模型请求失败（HTTP ${response.status}）`)
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('模型未返回有效事件流')
    }
    for await (const frame of readServerSentEvents(response.body, controller.signal)) {
      let data: unknown
      try {
        data = JSON.parse(frame.data)
      } catch {
        continue
      }
      if (
        frame.event === 'error' ||
        (typeof data === 'object' && data !== null && 'error' in data)
      ) {
        throw new Error('模型生成过程中返回错误')
      }
      const event = readMessageEvent(data)
      if (!event) {
        continue
      }
      if (event.type === 'message_delta' && event.usage) {
        sawFinalUsage = true
      }
      attemptUsage = updateAttemptUsage(attemptUsage, event)
      reply = applyEvent(reply, event, Date.now(), indexes)
      if (event.type === 'message_delta' && event.delta.title && !session.title) {
        session = { ...session, title: event.delta.title }
      }
      if (event.type === 'message_stop') {
        seenStop = true
        break
      }
      // UI 快照与持久化分别限频；等待发送处理背压，避免每个 token 都写库。
      if (Date.now() - lastSnapshot > 80) {
        await emit('snapshot', { session: current(), runId })
        lastSnapshot = Date.now()
      }
      if (Date.now() - lastPersist > 1000) {
        await checkpoint()
        lastPersist = Date.now()
      }
    }
    // 连接自然关闭不等于成功，只有供应商结束事件可以确认完整响应。
    if (!seenStop && !controller.signal.aborted) {
      throw new Error('模型连接提前中断，请重试')
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      errorMessage = error instanceof Error ? error.message : '生成失败'
    }
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    clearInterval(heartbeat)
    signal.removeEventListener('abort', abort)
    active.delete(runId)
    if (timedOut && !seenStop) {
      errorMessage = '生成超过本地开发的 240 秒上限，已保存部分内容'
    }
    if (sessionExpired && !seenStop) {
      errorMessage = '登录已失效，请重新登录'
    }
    // 区分正常结束、超时和主动停止；所有路径都保留已得到的部分内容。
    const status = seenStop
      ? 'done'
      : timedOut || sessionExpired
        ? 'error'
        : controller.signal.aborted
          ? 'stopped'
          : 'error'
    reply = settleReply(
      reply,
      status,
      Date.now(),
      errorMessage ? { kind: 'stream', message: errorMessage } : undefined
    )
    session = current()
    // 任务终态、用量和回答在同一事务落库；失败则一起回滚，不误记完成。
    const usage = normalizeUsage(attemptUsage, seenStop && sawFinalUsage)
    try {
      await inTransaction(async (q) => {
        await q.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [session.id])
        const r = await q.query(
          "UPDATE generation_run SET status=$2,usage=$3,error=$4,finished_at=NOW(),heartbeat_at=NOW() WHERE id=$1 AND status='running' RETURNING id",
          [runId, status, JSON.stringify(attemptUsage), errorMessage ?? null]
        )
        if (r.rowCount) {
          await q.query(
            `UPDATE usage_record SET input_tokens=$2,cached_input_tokens=$3,output_tokens=$4,
            raw_usage=$5,completeness=$6,updated_at=NOW() WHERE generation_id=$1`,
            [
              runId,
              usage.input,
              usage.cached,
              usage.output,
              JSON.stringify(usage.raw),
              usage.completeness,
            ]
          )
          await q.query('UPDATE message SET payload=$2 WHERE id=$1', [
            reply.id,
            JSON.stringify(reply),
          ])
          await q.query(
            "UPDATE conversation SET title=CASE WHEN title='' THEN $2 ELSE title END,updated_at=NOW(),version=version+1 WHERE id=$1",
            [session.id, session.title]
          )
        }
      })
      await emit(errorMessage ? 'error' : 'done', {
        session,
        runId,
        ...(errorMessage ? { message: errorMessage } : {}),
        ...(sessionExpired ? { code: 'SESSION_EXPIRED' } : {}),
      }).catch(() => {})
    } catch {
      await emit('error', { message: '数据库保存失败，请刷新检查已保存内容', runId }).catch(
        () => {}
      )
    }
  }
}

import {
  sessionEpoch,
  isCurrentSession,
  assertCurrentSession,
  invalidateSession,
  onSessionInvalidated,
} from '../auth/sessionBoundary.js'
import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import { useSettings } from '../settings.js'
import { readServerSentEvents } from '../api/sse.js'
import { getVisibleMessages } from './branches.js'
import { clearAllDrafts, clearSentDraft, getDraft } from './drafts.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

type ChatState = {
  nextCursor: string | null
  loadingMore: boolean
  listError: boolean
  ready: boolean
  initError: boolean
  importingHistory: boolean
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  activeId: string | null
  streaming: Record<string, AbortController>
}
export const useChatStore = create<ChatState>(() => ({
  nextCursor: null,
  loadingMore: false,
  listError: false,
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))
const { getState: get, setState: set } = useChatStore
const runs = new Map<string, string>()
let creating = false
onSessionInvalidated(() => {
  Object.values(get().streaming).forEach((controller) => controller.abort())
  runs.clear()
  creating = false
  clearAllDrafts()
  set({
    nextCursor: null,
    loadingMore: false,
    listError: false,
    ready: false,
    initError: false,
    importingHistory: false,
    sessions: [],
    sessionCache: {},
    sessionLoadErrors: {},
    sessionSaveErrors: {},
    activeId: null,
    streaming: {},
  })
})
const messageOf = (e: unknown) => (e instanceof Error ? e.message : '请求失败，请重试')
const notify = (e: unknown) => {
  if (!(e instanceof DOMException && e.name === 'AbortError')) {
    showToast(messageOf(e))
  }
}
class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}
const revisionOf = (id: string) => {
  const revision =
    get().sessionCache[id]?.revision ?? get().sessions.find((item) => item.id === id)?.revision
  if (revision === undefined) {
    throw new Error('会话版本尚未加载，请刷新后重试')
  }
  return revision
}
async function handleMutationError(id: string, error: unknown, epoch: number) {
  if (!isCurrentSession(epoch)) {
    return
  }
  if (error instanceof RequestError && error.code === 'REVISION_CONFLICT') {
    await load(id)
    if (isCurrentSession(epoch)) {
      notify(new Error('会话已在其他窗口更新，已刷新最新内容，请检查后重新操作'))
    }
  } else {
    notify(error)
  }
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const epoch = sessionEpoch()
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  assertCurrentSession(epoch)
  if (response.status === 401) {
    invalidateSession()
    throw new DOMException('登录已失效', 'AbortError')
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new RequestError(
      error?.error?.message ?? error?.message ?? `请求失败 (${response.status})`,
      error?.error?.code
    )
  }
  const result = response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  assertCurrentSession(epoch)
  return result
}
function put(session: Session) {
  const current = get().sessionCache[session.id]
  // 同一身份的并发请求也可能乱序，禁止较旧版本覆盖最新分支。
  if (
    current?.revision !== undefined &&
    session.revision !== undefined &&
    session.revision < current.revision
  ) {
    return
  }
  set((s) => ({
    sessionCache: { ...s.sessionCache, [session.id]: session },
    sessions: [...s.sessions.filter((x) => x.id !== session.id), toSessionSummary(session)].sort(
      (a, b) => b.updatedAt - a.updatedAt
    ),
  }))
}
type SessionPage = { items: SessionSummary[]; nextCursor: string | null }
let listRequest = 0
const mergeSummaries = (current: SessionSummary[], incoming: SessionSummary[]) => {
  const merged = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    const previous = merged.get(item.id)
    if (!previous || item.updatedAt >= previous.updatedAt) {
      merged.set(item.id, item)
    }
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
}
export async function initChat() {
  const epoch = sessionEpoch()
  const request = ++listRequest
  set({ initError: false, loadingMore: true, listError: false })
  try {
    const page = await api<SessionPage>('/conversations?limit=50')
    assertCurrentSession(epoch)
    if (request !== listRequest) {
      return
    }
    set({ sessions: mergeSummaries([], page.items), nextCursor: page.nextCursor, ready: true })
  } catch {
    if (isCurrentSession(epoch) && request === listRequest) {
      set({ initError: true })
    }
  } finally {
    if (isCurrentSession(epoch) && request === listRequest) {
      set({ loadingMore: false })
    }
  }
}
export async function loadMoreSessions() {
  const state = get()
  if (!state.ready || state.loadingMore || !state.nextCursor) {
    return
  }
  const epoch = sessionEpoch()
  const request = ++listRequest
  const cursor = state.nextCursor
  set({ loadingMore: true, listError: false })
  try {
    const page = await api<SessionPage>(
      `/conversations?limit=50&cursor=${encodeURIComponent(cursor)}`
    )
    assertCurrentSession(epoch)
    if (request !== listRequest) {
      return
    }
    set((state) => ({
      sessions: mergeSummaries(state.sessions, page.items),
      nextCursor: page.nextCursor,
    }))
  } catch {
    if (isCurrentSession(epoch) && request === listRequest) {
      set({ listError: true })
    }
  } finally {
    if (isCurrentSession(epoch) && request === listRequest) {
      set({ loadingMore: false })
    }
  }
}
async function load(id: string) {
  const epoch = sessionEpoch()
  try {
    const session = await api<Session>(`/conversations/${id}?view=branch`)
    assertCurrentSession(epoch)
    put(session)
    set((s) => ({ sessionLoadErrors: { ...s.sessionLoadErrors, [id]: false } }))
  } catch {
    if (isCurrentSession(epoch)) {
      set((s) => ({ sessionLoadErrors: { ...s.sessionLoadErrors, [id]: true } }))
    }
  }
}
const earlierLoading = new Set<string>()
export async function loadEarlierMessages(id: string) {
  const epoch = sessionEpoch()
  const original = get().sessionCache[id]
  if (
    !original?.hasEarlier ||
    !original.beforeId ||
    earlierLoading.has(id) ||
    get().streaming[id]
  ) {
    return
  }
  earlierLoading.add(id)
  try {
    const page = await api<Session>(
      `/conversations/${id}?view=branch&beforeId=${encodeURIComponent(original.beforeId)}`
    )
    assertCurrentSession(epoch)
    const current = get().sessionCache[id]
    if (current !== original) {
      return
    }
    if (page.revision !== original.revision) {
      await load(id)
      notify(new Error('会话已更新，已刷新最新版本'))
      return
    }
    const messages = [
      ...page.messages,
      ...original.messages.filter((m) => !page.messages.some((p) => p.id === m.id)),
    ]
    put({ ...original, messages, hasEarlier: page.hasEarlier, beforeId: page.beforeId })
  } catch (error) {
    if (isCurrentSession(epoch)) {
      notify(error)
      throw error
    }
  } finally {
    earlierLoading.delete(id)
  }
}
export const retrySaveSessions = () => {
  void initChat()
  const id = get().activeId
  if (id) {
    void load(id)
  }
}
export const newChat = () => set({ activeId: null })
export const selectSession = (id: string) => {
  set({ activeId: id })
  void load(id)
}
export const renameSession = (id: string, title: string) => {
  const epoch = sessionEpoch()
  void api<Session>(`/conversations/${id}?view=branch`, {
    method: 'PATCH',
    body: JSON.stringify({ title, expectedRevision: revisionOf(id) }),
  })
    .then((session) => {
      assertCurrentSession(epoch)
      put(session)
    })
    .catch((error) => void handleMutationError(id, error, epoch))
}
export async function removeSession(id: string) {
  const epoch = sessionEpoch()
  if (get().streaming[id]) {
    notify(new Error('请先停止生成'))
    return false
  }
  try {
    await api(`/conversations/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: revisionOf(id) }),
    })
    assertCurrentSession(epoch)
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(s.sessionCache).filter(([key]) => key !== id)
      ),
      activeId: s.activeId === id ? null : s.activeId,
    }))
    return true
  } catch (e) {
    await handleMutationError(id, e, epoch)
    return false
  }
}
export const selectMessageVersion = (id: string, messageId: string) => {
  const epoch = sessionEpoch()
  if (get().streaming[id]) {
    return
  }
  void api<Session>(`/conversations/${id}?view=branch`, {
    method: 'PATCH',
    body: JSON.stringify({ selectedMessageId: messageId, expectedRevision: revisionOf(id) }),
  })
    .then((session) => {
      assertCurrentSession(epoch)
      put(session)
    })
    .catch((error) => void handleMutationError(id, error, epoch))
}
export function stopReply(id: string) {
  const runId = runs.get(id)
  if (runId) {
    void api(`/generations/${runId}/cancel`, { method: 'POST' }).catch(notify)
  }
  get().streaming[id]?.abort()
}
export const bindChatPersistence = () => {
  const stop = () => Object.values(get().streaming).forEach((c) => c.abort())
  window.addEventListener('pagehide', stop)
  return () => window.removeEventListener('pagehide', stop)
}
export async function replaceHistory(_write: () => Promise<void>): Promise<number> {
  void _write
  throw new Error('云端模式暂不支持旧数据导入；原本地数据保持不变')
}

type GenerationInput = {
  operation: 'send' | 'edit' | 'regenerate' | 'continue'
  content?: string
  messageId?: string
  parentId?: string | null
}
async function generate(id: string, input: GenerationInput) {
  const epoch = sessionEpoch()
  if (get().streaming[id]) {
    return
  }
  const controller = new AbortController()
  set((s) => ({ streaming: { ...s.streaming, [id]: controller } }))
  let terminal = false
  try {
    const { thinking, search } = useSettings.getState()
    const response = await fetch(`/api/conversations/${id}/generations?view=branch`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...input,
        expectedRevision: revisionOf(id),
        thinking,
        search,
        idempotencyKey: crypto.randomUUID(),
      }),
      signal: controller.signal,
    })
    assertCurrentSession(epoch)
    if (response.status === 401) {
      invalidateSession()
      throw new DOMException('登录已失效', 'AbortError')
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null)
      throw new RequestError(
        error?.error?.message ?? error?.message ?? `生成失败 (${response.status})`,
        error?.error?.code
      )
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('服务未返回 SSE 数据流')
    }
    for await (const frame of readServerSentEvents(response.body, controller.signal)) {
      assertCurrentSession(epoch)
      const data = JSON.parse(frame.data) as {
        session?: Session
        runId?: string
        message?: string
        code?: string
      }
      if (data.runId) {
        runs.set(id, data.runId)
      }
      if (data.session) {
        put(data.session)
      }
      if (frame.event === 'error') {
        if (data.code === 'SESSION_EXPIRED') {
          invalidateSession()
          throw new DOMException('登录已失效', 'AbortError')
        }
        throw new Error(data.message ?? '生成失败')
      }
      if (frame.event === 'done') {
        terminal = true
        break
      }
    }
    if (!terminal) {
      throw new Error('连接提前结束，正在重新读取已保存的内容')
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      await handleMutationError(id, e, epoch)
    }
  } finally {
    if (isCurrentSession(epoch)) {
      runs.delete(id)
      set((s) => ({
        streaming: Object.fromEntries(Object.entries(s.streaming).filter(([key]) => key !== id)),
      }))
      // The backend owns persistence. Reload after cancellation rather than overwriting it with UI state.
      await load(id)
      if (controller.signal.aborted) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const pending = get().sessionCache[id]?.messages.some(
            (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
          )
          if (!pending) {
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (!isCurrentSession(epoch)) {
            break
          }
          await load(id)
        }
      }
    }
  }
}
export function sendMessage(id: string | null) {
  if (!get().ready || creating || (id && get().streaming[id])) {
    return false
  }
  const draft = getDraft(id)
  const content = draft.text.trim()
  if (!content) {
    return false
  }
  if (draft.attachments.length) {
    notify(new Error('本地后端首版暂不支持附件'))
    return false
  }
  const epoch = sessionEpoch()
  creating = true
  void (async () => {
    try {
      let target = id
      if (!target) {
        const session = await api<Session>('/conversations', { method: 'POST', body: '{}' })
        assertCurrentSession(epoch)
        put(session)
        target = session.id
        set({ activeId: target })
      }
      const parentId = getVisibleMessages(get().sessionCache[target]).at(-1)?.id ?? null
      clearSentDraft(id)
      await generate(target, { operation: 'send', content, parentId })
    } catch (e) {
      notify(e)
    } finally {
      if (isCurrentSession(epoch)) {
        creating = false
      }
    }
  })()
  return true
}
export const regenerateReply = (id: string, messageId?: string) => {
  const session = get().sessionCache[id]
  if (!session) {
    return
  }
  const target = messageId ?? getVisibleMessages(session).at(-1)?.id
  if (target) {
    void generate(id, { operation: 'regenerate', messageId: target })
  }
}
export function editMessage(id: string, messageId: string, content: string) {
  if (!content.trim() || get().streaming[id]) {
    return false
  }
  void generate(id, { operation: 'edit', messageId, content })
  return true
}
export const continueReply = (id: string, messageId: string) => {
  void generate(id, { operation: 'continue', messageId })
}
export const retryUpload = (_id: string, _messageId: string) => {
  void _id
  void _messageId
  notify(new Error('附件暂未开放'))
}

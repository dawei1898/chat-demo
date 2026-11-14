import type { Session } from '../../src/services/chat/types.js'
import test from 'node:test'
import assert from 'node:assert/strict'
Object.defineProperty(globalThis, '__API_ORIGIN__', { value: '', configurable: true })
Object.defineProperty(globalThis, 'window', {
  value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
  configurable: true,
})
const { initChat, loadMoreSessions, useChatStore, renameSession } =
  await import('../../src/services/chat/store.js')
const { invalidateSession } = await import('../../src/services/auth/sessionBoundary.js')
const { buildMessageVersions, getVisibleMessages } =
  await import('../../src/services/chat/branches.js')
const item = (i: number) => ({
  id: String(i),
  title: String(i),
  createdAt: i,
  updatedAt: i,
  revision: 1,
})
test('250条会话完整分页，重复点击合并请求，跨页去重，失败可重试', async () => {
  invalidateSession()
  let calls = 0
  let fail = true
  globalThis.fetch = async (input) => {
    calls++
    await new Promise((r) => setTimeout(r, 5))
    const cursor = Number(new URL(String(input), 'http://test').searchParams.get('cursor') ?? 0)
    if (cursor === 50 && fail) {
      fail = false
      return new Response('', { status: 500 })
    }
    const end = Math.min(cursor + 50, 250)
    return Response.json({
      items: Array.from({ length: end - cursor }, (_, i) => item(cursor + i)),
      nextCursor: end < 250 ? String(end) : null,
    })
  }
  await initChat()
  assert.equal(useChatStore.getState().sessions.length, 50)
  await Promise.all([loadMoreSessions(), loadMoreSessions()])
  assert.equal(calls, 2)
  assert.equal(useChatStore.getState().listError, true)
  await loadMoreSessions()
  assert.equal(useChatStore.getState().sessions.length, 100)
  while (useChatStore.getState().nextCursor) {
    await loadMoreSessions()
  }
  assert.equal(useChatStore.getState().sessions.length, 250)
  const count = calls
  await loadMoreSessions()
  assert.equal(calls, count)
  globalThis.fetch = async () => Response.json({ items: [item(249), item(250)], nextCursor: null })
  useChatStore.setState({ nextCursor: 'overlap' })
  await loadMoreSessions()
  assert.equal(useChatStore.getState().sessions.length, 251)
})
test('版本冲突刷新，不自动重复写入', async () => {
  invalidateSession()
  const session = { ...item(1), messages: [], revision: 2 }
  useChatStore.setState({ sessions: [item(1)] })
  const methods: string[] = []
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method ?? 'GET')
    return init?.method === 'PATCH'
      ? Response.json({ error: { code: 'REVISION_CONFLICT' } }, { status: 409 })
      : Response.json(session)
  }
  renameSession('1', 'changed')
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(methods, ['PATCH', 'GET'])
  assert.equal(useChatStore.getState().sessionCache['1'].revision, 2)
})
test('轻量treeIndex导航保留未加载兄弟版本，当前正文不制造占位', () => {
  const session: Session = {
    ...item(1),
    rootMessageId: 'u',
    messages: [
      {
        id: 'u',
        role: 'user',
        content: 'hi',
        files: [],
        createdAt: 1,
        parentId: null,
        selectedChildId: 'a2',
      },
      {
        id: 'a2',
        role: 'assistant',
        model: null,
        prefix: true,
        status: 'done',
        blocks: [],
        createdAt: 2,
        parentId: 'u',
      },
    ],
    treeIndex: [
      { id: 'u', role: 'user', createdAt: 1, parentId: null },
      { id: 'a1', role: 'assistant', createdAt: 2, parentId: 'u' },
      { id: 'a2', role: 'assistant', createdAt: 3, parentId: 'u' },
    ],
  }
  assert.deepEqual(buildMessageVersions(session, new Map()).get('a2'), {
    ids: ['a1', 'a2'],
    index: 1,
  })
  assert.deepEqual(
    getVisibleMessages(session).map((m) => m.id),
    ['u', 'a2']
  )
})
test('历史窗口合并去重，生成或版本变化时拒绝迟到旧窗口', async () => {
  const { loadEarlierMessages } = await import('../../src/services/chat/store.js')
  invalidateSession()
  const message = (id: string) => ({
    id,
    role: 'user' as const,
    content: id,
    files: [],
    createdAt: Number(id),
  })
  const current = {
    ...item(1),
    messages: [message('50'), message('51')],
    hasEarlier: true,
    beforeId: '50',
    treeIndex: [],
  }
  useChatStore.setState({ sessionCache: { '1': current } })
  globalThis.fetch = async () =>
    Response.json({
      ...current,
      messages: [message('49'), message('50')],
      hasEarlier: false,
      beforeId: null,
    })
  await loadEarlierMessages('1')
  assert.deepEqual(
    useChatStore.getState().sessionCache['1'].messages.map((m) => m.id),
    ['49', '50', '51']
  )
  useChatStore.setState({ sessionCache: { '1': current } })
  let finish!: (r: Response) => void
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const pending = loadEarlierMessages('1')
  useChatStore.setState({ sessionCache: { '1': { ...current, revision: 9 } } })
  finish(Response.json({ ...current, messages: [message('1')] }))
  await pending
  assert.equal(useChatStore.getState().sessionCache['1'].revision, 9)
  assert.deepEqual(
    useChatStore.getState().sessionCache['1'].messages.map((m) => m.id),
    ['50', '51']
  )
})
test('同身份旧详情响应不能覆盖较新revision', async () => {
  const { selectSession } = await import('../../src/services/chat/store.js')
  invalidateSession()
  let finish!: (r: Response) => void
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      finish = resolve
    })
  selectSession('1')
  useChatStore.setState({
    sessionCache: { '1': { ...item(1), revision: 9, title: 'new', messages: [] } },
  })
  finish(Response.json({ ...item(1), revision: 2, title: 'old', messages: [] }))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(useChatStore.getState().sessionCache['1'].title, 'new')
})

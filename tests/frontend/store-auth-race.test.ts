import test from 'node:test'
import assert from 'node:assert/strict'
// 仅模拟浏览器环境，不读取真实本地存储和凭据。
Object.defineProperty(globalThis, '__API_ORIGIN__', { value: '', configurable: true })

Object.defineProperty(globalThis, 'window', {
  value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
  configurable: true,
})
const { initChat, selectSession, useChatStore, regenerateReply } =
  await import('../../src/services/chat/store.js')
const { setDraftText, getDraft } = await import('../../src/services/chat/drafts.js')
const { invalidateSession } = await import('../../src/services/auth/sessionBoundary.js')
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const sample = {
  id: 'test',
  revision: 1,
  title: 'private',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
}

test('迟到列表和详情响应不能回填已退出用户的数据', async () => {
  for (const operation of ['init', 'load']) {
    invalidateSession()
    let finish!: (response: Response) => void
    globalThis.fetch = async () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = operation === 'init' ? initChat() : (selectSession('test'), Promise.resolve())
    invalidateSession()
    finish(Response.json(operation === 'init' ? [sample] : sample))
    await pending
    await tick()
    assert.deepEqual(useChatStore.getState().sessions, [])
    assert.deepEqual(useChatStore.getState().sessionCache, {})
  }
})
test('401 会清空所有草稿和缓存', async () => {
  setDraftText(null, 'private draft')
  useChatStore.setState({ sessionCache: { test: sample }, sessions: [sample] })
  globalThis.fetch = async () =>
    Response.json({ error: { message: 'unauthorized' } }, { status: 401 })
  await initChat()
  assert.equal(getDraft(null).text, '')
  assert.deepEqual(useChatStore.getState().sessionCache, {})
})
test('迟到 SSE 帧不能复活退出用户会话', async () => {
  invalidateSession()
  useChatStore.setState({ sessionCache: { test: sample }, sessions: [sample] })
  let output!: ReadableStreamDefaultController<Uint8Array>
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          output = controller
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  regenerateReply('test', 'message')
  await tick()
  invalidateSession()
  try {
    output.enqueue(
      new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({ session: sample })}\n\n`)
    )
    output.close()
  } catch {
    // 退出已取消流时，写入关闭的测试流被拒绝是预期行为。
  }
  await tick()
  assert.deepEqual(useChatStore.getState().sessionCache, {})
  assert.deepEqual(useChatStore.getState().streaming, {})
})

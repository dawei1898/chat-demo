import test from 'node:test'
import assert from 'node:assert/strict'
Object.defineProperty(globalThis, '__API_ORIGIN__', { value: '', configurable: true })
Object.defineProperty(globalThis, 'window', {
  value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
  configurable: true,
})
const { useChatStore, regenerateReply } = await import('../../src/services/chat/store.js')
const { useToast } = await import('../../src/components/base/toastState.js')
const { invalidateSession } = await import('../../src/services/auth/sessionBoundary.js')
const sample = { id: 'test', title: 'test', revision: 1, createdAt: 1, updatedAt: 1, messages: [] }
const sleep = () => new Promise((r) => setTimeout(r, 20))
test('缺少done、损坏JSON与保存失败均不能显示成功；终态重新读取数据库', async () => {
  for (const frames of [
    'event: snapshot\ndata: ' + JSON.stringify({ session: sample }) + '\n\n',
    'event: done\ndata: {bad}\n\n',
    'event: error\ndata: {"code":"SAVE_FAILED","message":"保存失败"}\n\n',
  ]) {
    invalidateSession()
    useToast.setState({ message: null })
    useChatStore.setState({ sessionCache: { test: sample }, sessions: [sample] })
    let gets = 0
    globalThis.fetch = async (_url, init) =>
      init?.method === 'POST'
        ? new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
        : (gets++, Response.json({ ...sample, revision: 2 }))
    regenerateReply('test', 'a')
    await sleep()
    assert.equal(gets, 1)
    assert.equal(useChatStore.getState().sessionCache.test.revision, 2)
    assert.ok(useToast.getState().message)
    assert.deepEqual(useChatStore.getState().streaming, {})
  }
})
test('未知非JSON心跳不破坏done处理', async () => {
  invalidateSession()
  useToast.setState({ message: null })
  useChatStore.setState({ sessionCache: { test: sample }, sessions: [sample] })
  globalThis.fetch = async (_url, init) =>
    init?.method === 'POST'
      ? new Response(
          'event: ping\ndata: keepalive\n\nevent: future\ndata: not-json\n\nevent: done\ndata: {}\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      : Response.json(sample)
  regenerateReply('test', 'a')
  await sleep()
  assert.equal(useToast.getState().message, null)
})
test('幂等replay JSON仅刷新现存任务，不发起第二次生成', async () => {
  invalidateSession()
  useChatStore.setState({ sessionCache: { test: sample }, sessions: [sample] })
  let posts = 0
  let gets = 0
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++
      return Response.json({
        replay: true,
        runId: 'existing',
        status: 'running',
        conversationId: 'test',
      })
    }
    gets++
    return Response.json({ ...sample, revision: 2 })
  }
  regenerateReply('test', 'a')
  await sleep()
  assert.equal(posts, 1)
  assert.equal(gets, 1)
  assert.equal(useChatStore.getState().sessionCache.test.revision, 2)
})

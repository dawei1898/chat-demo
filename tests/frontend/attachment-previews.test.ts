import test from 'node:test'
import assert from 'node:assert/strict'
Object.defineProperty(globalThis, '__API_ORIGIN__', { value: '', configurable: true })
Object.defineProperty(globalThis, 'window', {
  value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
  configurable: true,
})
const {
  retainAttachmentPreview,
  releaseConversationPreviews,
  clearAttachmentPreviews,
  useAttachmentPreviews,
  touchAttachmentPreview,
  MAX_PREVIEW_COUNT,
  MAX_PREVIEW_BYTES,
} = await import('../../src/services/attachmentPreviews.js')
const { invalidateSession } = await import('../../src/services/auth/sessionBoundary.js')
const { addDraftFiles, getDraft } = await import('../../src/services/chat/drafts.js')
const { useChatStore, sendMessage } = await import('../../src/services/chat/store.js')
const revoked: string[] = []
let counter = 0
URL.createObjectURL = () => `blob:mock-${++counter}`
URL.revokeObjectURL = (url) => revoked.push(url)
const image = () => new File(['png-mock'], 'photo.png', { type: 'image/png' })
const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

test('服务端接受发送后消息预览独立于草稿URL；前置失败保留草稿但不生成消息缓存', async () => {
  for (const rejected of [false, true]) {
    invalidateSession()
    const session = {
      id: 'c',
      revision: 1,
      title: 'test',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    }
    const attachment = {
      id: 'attachment',
      attachmentId: 'attachment',
      serverId: null,
      name: 'photo.png',
      size: 8,
      isImage: true,
      mimeType: 'image/png',
      status: 'ready',
    }
    globalThis.fetch = async (url) => {
      if (url === '/api/attachments') {
        return Response.json(attachment)
      }
      if (String(url).includes('/generations')) {
        if (rejected) {
          return Response.json({ error: { code: 'CONTEXT_BUDGET_EXCEEDED' } }, { status: 413 })
        }
        const accepted = {
          ...session,
          revision: 2,
          messages: [
            {
              id: 'new',
              role: 'user',
              content: '',
              parentId: null,
              files: [attachment],
              createdAt: 2,
            },
          ],
        }
        return new Response(
          `event: snapshot\ndata: ${JSON.stringify({ session: accepted })}\n\nevent: done\ndata: {}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
      return Response.json(session)
    }
    useChatStore.setState({ ready: true, sessionCache: { c: session }, sessions: [session] })
    addDraftFiles('c', [image()], '')
    await tick()
    const draftUrl = getDraft('c').attachments[0].previewUrl
    assert.equal(sendMessage('c'), true)
    await tick()
    const preview = useAttachmentPreviews.getState().entries.attachment
    if (rejected) {
      assert.equal(preview, undefined)
      assert.equal(getDraft('c').attachments[0].previewUrl, draftUrl)
      assert.ok(!revoked.includes(draftUrl ?? ''))
    } else {
      assert.ok(preview?.url)
      assert.notEqual(preview.url, draftUrl)
      assert.ok(revoked.includes(draftUrl ?? ''))
      assert.ok(!revoked.includes(preview.url))
      assert.equal(getDraft('c').attachments.length, 0)
    }
  }
})

test('退出和pagehide释放全部URL；新账号或刷新无缓存，界面可降级元数据', () => {
  clearAttachmentPreviews()
  assert.deepEqual(useAttachmentPreviews.getState().entries, {})
  retainAttachmentPreview('a', 'c', image())
  const url = useAttachmentPreviews.getState().entries.a.url
  invalidateSession()
  assert.ok(revoked.includes(url))
  assert.deepEqual(useAttachmentPreviews.getState().entries, {})
  retainAttachmentPreview('b', 'c', image())
  window.dispatchEvent(new Event('pagehide'))
  assert.deepEqual(useAttachmentPreviews.getState().entries, {})
})

test('LRU按数量/字节有界回收；删除会话保留其他会话引用', () => {
  clearAttachmentPreviews()
  for (let i = 0; i < MAX_PREVIEW_COUNT; i++) {
    retainAttachmentPreview(String(i), 'c', image())
  }
  touchAttachmentPreview('0')
  const evicted = useAttachmentPreviews.getState().entries['1'].url
  retainAttachmentPreview('extra', 'c', image())
  assert.equal(Object.keys(useAttachmentPreviews.getState().entries).length, MAX_PREVIEW_COUNT)
  assert.ok(useAttachmentPreviews.getState().entries['0'])
  assert.equal(useAttachmentPreviews.getState().entries['1'], undefined)
  assert.ok(revoked.includes(evicted))
  clearAttachmentPreviews()
  const large = new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' })
  for (let i = 0; i < 6; i++) {
    retainAttachmentPreview(String(i), 'c', large)
  }
  const total = Object.values(useAttachmentPreviews.getState().entries).reduce(
    (sum, item) => sum + item.size,
    0
  )
  assert.ok(total <= MAX_PREVIEW_BYTES)
  retainAttachmentPreview('shared', 'c', image())
  retainAttachmentPreview('shared', 'other', image())
  const shared = useAttachmentPreviews.getState().entries.shared.url
  releaseConversationPreviews('c')
  assert.deepEqual(Object.keys(useAttachmentPreviews.getState().entries), ['shared'])
  assert.ok(!revoked.includes(shared))
  releaseConversationPreviews('other')
  assert.ok(revoked.includes(shared))
  assert.deepEqual(useAttachmentPreviews.getState().entries, {})
})

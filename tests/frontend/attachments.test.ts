import test from 'node:test'
import assert from 'node:assert/strict'
Object.defineProperty(globalThis, '__API_ORIGIN__', { value: '', configurable: true })
Object.defineProperty(globalThis, 'window', {
  value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
  configurable: true,
})
const { invalidateSession } = await import('../../src/services/auth/sessionBoundary.js')
const { uploadAttachment, useUploads, validateFiles, cancelUpload, ACCEPTED_EXTS } =
  await import('../../src/services/attachments.js')
const { uploadBusinessAttachment } = await import('../../src/services/api/attachments.js')
const { addDraftFiles, getDraft, prepareDraftMessage, clearAllDrafts, removeDraftAttachment } =
  await import('../../src/services/chat/drafts.js')
const { useChatStore, sendMessage } = await import('../../src/services/chat/store.js')
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const id = '11111111-1111-4111-8111-111111111111'
const metadata = {
  id,
  attachmentId: id,
  serverId: null,
  name: 'test.txt',
  mimeType: 'text/plain',
  size: 3,
  isImage: false,
  status: 'ready',
}
const file = () => new File(['abc'], 'test.txt', { type: 'text/plain' })

test('业务小白名单、8MiB与10个限制；不重新开放旧格式', () => {
  assert.ok(ACCEPTED_EXTS.includes('pdf'))
  for (const ext of ['docx', 'epub', 'svg', 'html', 'yaml']) {
    assert.equal(validateFiles([new File(['x'], `x.${ext}`)], 0)?.key, 'uploadUnsupportedFormat')
  }
  assert.equal(validateFiles([file()], 10)?.key, 'uploadMaxFiles')
  assert.equal(
    validateFiles([new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'x.txt')], 0)?.key,
    'uploadMaxMBSize'
  )
})

test('上传只走同源认证与业务幂等key，不传模型Key；ready后仅生成attachmentId引用', async () => {
  invalidateSession()
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/attachments')
    assert.equal(options?.credentials, 'same-origin')
    assert.equal(options?.headers, undefined)
    const form = options?.body as FormData
    assert.equal(form.get('uploadKey'), id)
    assert.deepEqual([...form.keys()], ['file', 'uploadKey'])
    return Response.json(metadata)
  }
  const result = await uploadAttachment('不得发送', id, file(), 'test.txt', false)
  assert.equal(result, id)
  const prepared = prepareDraftMessage(
    { text: '', attachments: [{ id, file: file(), isImage: false, previewUrl: null }] },
    useUploads.getState().tasks
  )
  assert.equal(prepared?.files[0].attachmentId, id)
  assert.equal(prepared?.files[0].serverId, null)
  assert.ok(!('blob' in (prepared?.files[0] ?? {})))
})

test('迟到上传及旧401不能污染新身份；当前401清空草稿；移除取消不复活任务', async () => {
  invalidateSession()
  let deliver!: (response: Response) => void
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      deliver = resolve
    })
  const pending = uploadAttachment('', id, file(), 'test.txt', false)
  invalidateSession()
  deliver(Response.json(metadata))
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(useUploads.getState().tasks, {})
  const cancelled = uploadAttachment('', id, file(), 'test.txt', false)
  cancelUpload(id)
  deliver(Response.json(metadata))
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.deepEqual(useUploads.getState().tasks, {})
  const stale = uploadBusinessAttachment(file(), id, new AbortController().signal)
  invalidateSession()
  const { sessionEpoch } = await import('../../src/services/auth/sessionBoundary.js')
  const current = sessionEpoch()
  deliver(new Response(null, { status: 401 }))
  await assert.rejects(stale, { name: 'AbortError' })
  assert.equal(sessionEpoch(), current)
  globalThis.fetch = async () => new Response(null, { status: 401 })
  addDraftFiles(null, [file()], '')
  await tick()
  assert.equal(getDraft(null).attachments.length, 0)
})

test('未知上传不自动或手动重试；草稿图片预览释放', async () => {
  invalidateSession()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ error: { code: 'ATTACHMENT_UPLOAD_UNKNOWN' } }, { status: 409 })
  }
  await assert.rejects(uploadAttachment('', id, file(), 'test.txt', false))
  assert.equal(calls, 1)
  assert.deepEqual(useUploads.getState().tasks[id].status, 'error')
  const task = useUploads.getState().tasks[id]
  assert.ok(task.status === 'error' && !task.retryable)
  const revoked: string[] = []
  const oldCreate = URL.createObjectURL
  const oldRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => 'blob:test-preview'
  URL.revokeObjectURL = (url) => revoked.push(url)
  globalThis.fetch = async () => Response.json(metadata)
  try {
    addDraftFiles(null, [new File(['x'], 'x.png', { type: 'image/png' })], '')
    await tick()
    const attachment = getDraft(null).attachments[0]
    assert.equal(attachment.previewUrl, 'blob:test-preview')
    removeDraftAttachment(null, attachment.id)
    assert.deepEqual(revoked, ['blob:test-preview'])
  } finally {
    URL.createObjectURL = oldCreate
    URL.revokeObjectURL = oldRevoke
    clearAllDrafts()
  }
})

test('纯附件发送只提交业务ID，不发送原件、供应商ID或浏览器Key', async () => {
  invalidateSession()
  let generation: Record<string, unknown> | undefined
  const session = {
    id: 'conversation',
    revision: 1,
    title: 'test',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  }
  globalThis.fetch = async (url, options) => {
    if (url === '/api/attachments') {
      return Response.json(metadata)
    }
    if (String(url).includes('/generations')) {
      generation = JSON.parse(options?.body as string)
      return new Response('event: done\ndata: {}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return Response.json(session)
  }
  useChatStore.setState({
    ready: true,
    sessionCache: { conversation: session },
    sessions: [session],
  })
  addDraftFiles('conversation', [file()], '')
  await tick()
  assert.equal(sendMessage('conversation'), true)
  await tick()
  assert.deepEqual(generation?.attachmentIds, [id])
  assert.equal(generation?.content, '')
  for (const key of ['files', 'serverId', 'apiKey', 'blob']) {
    assert.ok(!Object.hasOwn(generation ?? {}, key))
  }
})

test('生成前HTTP409/413拒绝或断网，保留已上传附件与文字，无第二次上传', async () => {
  const { setDraftText } = await import('../../src/services/chat/drafts.js')
  for (const status of [409, 413, 0]) {
    invalidateSession()
    let uploads = 0
    const session = {
      id: 'conversation',
      revision: 1,
      title: 'test',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    }
    globalThis.fetch = async (url) => {
      if (url === '/api/attachments') {
        uploads++
        return Response.json(metadata)
      }
      if (String(url).includes('/generations')) {
        if (!status) {
          throw new TypeError('network disconnected')
        }
        return Response.json(
          { error: { code: status === 409 ? 'REVISION_CONFLICT' : 'CONTEXT_BUDGET_EXCEEDED' } },
          { status }
        )
      }
      return Response.json(session)
    }
    useChatStore.setState({
      ready: true,
      sessionCache: { conversation: session },
      sessions: [session],
    })
    addDraftFiles('conversation', [file()], '')
    setDraftText('conversation', '不能丢失的说明')
    await tick()
    const original = getDraft('conversation')
    assert.equal(sendMessage('conversation'), true)
    await tick()
    assert.equal(getDraft('conversation'), original)
    assert.equal(
      prepareDraftMessage(original, useUploads.getState().tasks)?.files[0].attachmentId,
      id
    )
    assert.equal(uploads, 1)
  }
})

test('仅含本次新用户消息的snapshot释放草稿，等待期间的新编辑不会被清空', async () => {
  const { setDraftText } = await import('../../src/services/chat/drafts.js')
  for (const editDuringWait of [false, true]) {
    invalidateSession()
    let deliver!: (response: Response) => void
    const session = {
      id: 'conversation',
      revision: 1,
      title: 'test',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    }
    globalThis.fetch = async (url) => {
      if (url === '/api/attachments') {
        return Response.json(metadata)
      }
      if (String(url).includes('/generations')) {
        return new Promise((resolve) => {
          deliver = resolve
        })
      }
      return Response.json(session)
    }
    useChatStore.setState({
      ready: true,
      sessionCache: { conversation: session },
      sessions: [session],
    })
    addDraftFiles('conversation', [file()], '')
    setDraftText('conversation', '原消息')
    await tick()
    assert.equal(sendMessage('conversation'), true)
    await tick()
    assert.equal(getDraft('conversation').text, '原消息')
    if (editDuringWait) {
      setDraftText('conversation', '新编辑不能被清掉')
    }
    const accepted = {
      ...session,
      revision: 2,
      messages: [
        {
          id: 'new-user',
          role: 'user',
          content: '原消息',
          parentId: null,
          createdAt: 2,
          files: [metadata],
        },
      ],
    }
    deliver(
      new Response(
        `event: snapshot\ndata: ${JSON.stringify({ session: accepted })}\n\nevent: done\ndata: {}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      )
    )
    await tick()
    assert.equal(getDraft('conversation').text, editDuringWait ? '新编辑不能被清掉' : '')
    assert.equal(getDraft('conversation').attachments.length, editDuringWait ? 1 : 0)
  }
})

test('新建会话生成被拒绝，草稿搬到当前会话仍可见而不是遗留新对话槽', async () => {
  invalidateSession()
  const { setDraftText } = await import('../../src/services/chat/drafts.js')
  const session = {
    id: 'created',
    revision: 1,
    title: 'test',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  }
  globalThis.fetch = async (url) => {
    if (url === '/api/attachments') {
      return Response.json(metadata)
    }
    if (String(url).includes('/generations')) {
      return Response.json({ error: { code: 'CONTEXT_BUDGET_EXCEEDED' } }, { status: 413 })
    }
    return Response.json(session)
  }
  useChatStore.setState({ ready: true })
  addDraftFiles(null, [file()], '')
  setDraftText(null, '新对话附件说明')
  await tick()
  const original = getDraft(null)
  assert.equal(sendMessage(null), true)
  await tick()
  assert.equal(useChatStore.getState().activeId, 'created')
  assert.equal(getDraft('created'), original)
  assert.equal(getDraft(null).attachments.length, 0)
})

test('未知上传显式核对仅查原任务，不重传；就绪后恢复草稿引用', async () => {
  invalidateSession()
  const { reconcileAttachment } = await import('../../src/services/attachments.js')
  const calls: string[] = []
  globalThis.fetch = async (url, options) => {
    calls.push(`${options?.method} ${url}`)
    assert.equal(options?.body, undefined)
    assert.equal(options?.credentials, 'same-origin')
    return Response.json({ ...metadata, status: calls.length === 1 ? 'unknown' : 'ready' })
  }
  assert.equal(await reconcileAttachment(id), id)
  assert.deepEqual(calls, [
    `GET /api/attachments/by-upload-key/${id}`,
    `POST /api/attachments/${id}/reconcile`,
  ])
  assert.deepEqual(useUploads.getState().tasks[id], { status: 'done', attachmentId: id })
})

test('核对失败不会重传；注销后的迟到核对不回填任务', async () => {
  invalidateSession()
  const { reconcileAttachment } = await import('../../src/services/attachments.js')
  let count = 0
  globalThis.fetch = async () => {
    count++
    return Response.json({ error: { code: 'ATTACHMENT_RECONCILE_MANUAL' } }, { status: 409 })
  }
  await assert.rejects(reconcileAttachment(id))
  assert.equal(count, 1)
  const task = useUploads.getState().tasks[id]
  assert.ok(task.status === 'error' && !task.retryable)
  let deliver!: (response: Response) => void
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      deliver = resolve
    })
  const pending = reconcileAttachment(id)
  invalidateSession()
  deliver(Response.json(metadata))
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(useUploads.getState().tasks, {})
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { hydrateAttachmentMessages } from '../src/attachments.js'
import type { UserMessage } from '../../src/services/chat/types.js'
import type { Queryable } from '../src/store.js'

function fixture(count: number, isImage = false, size = 10) {
  const message: UserMessage = {
    id: 'question',
    role: 'user',
    content: '',
    createdAt: 0,
    files: Array.from({ length: count }, () => ({
      id: 'business-id',
      attachmentId: 'business-id',
      serverId: null,
      name: 'fixture',
      size,
      mimeType: isImage ? 'image/png' : 'text/plain',
      isImage,
    })),
  }
  const q = {
    query: async () => ({
      rows: [
        {
          id: 'business-id',
          user_id: 'owner',
          name: 'fixture',
          size_bytes: size,
          mime_type: isImage ? 'image/png' : 'text/plain',
          is_image: isImage,
          status: 'ready',
          provider_file_id: 'file-private',
          deleted_at: null,
        },
      ],
    }),
  } as unknown as Queryable
  return { message, q }
}
test('文档预算按历史中实际引用次数计数，不能通过复用同一ID绕过20份上限', async () => {
  const { message, q } = fixture(20)
  const original = JSON.stringify(message)
  const [request] = await hydrateAttachmentMessages(q, 'owner', [message])
  assert.equal(request.files.length, 20)
  assert.equal(request.files[0].serverId, 'file-private')
  assert.equal(JSON.stringify(message), original)
  await assert.rejects(
    () =>
      hydrateAttachmentMessages(q, 'owner', [
        message,
        { ...message, id: 'next', files: message.files.slice(0, 1) },
      ]),
    { status: 413, code: 'ATTACHMENT_CONTEXT_LIMIT' }
  )
})
test('图片数量与累计字节预算独立约束', async () => {
  const valid = fixture(64, true)
  await hydrateAttachmentMessages(valid.q, 'owner', [valid.message])
  const tooMany = fixture(65, true)
  await assert.rejects(() => hydrateAttachmentMessages(tooMany.q, 'owner', [tooMany.message]), {
    status: 413,
  })
  const tooLarge = fixture(17, true, 8 * 1024 * 1024)
  await assert.rejects(() => hydrateAttachmentMessages(tooLarge.q, 'owner', [tooLarge.message]), {
    status: 413,
  })
})

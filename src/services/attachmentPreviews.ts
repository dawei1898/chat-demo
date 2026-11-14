import { create } from 'zustand'
import { onSessionInvalidated } from './auth/sessionBoundary.js'

export const MAX_PREVIEW_COUNT = 20
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024
type Preview = { url: string; size: number; conversations: Set<string>; touched: number }
/** 仅当前页面的新上传图片；不持久化，不读取旧数据库，也不向后端索取原件。 */
export const useAttachmentPreviews = create<{ entries: Record<string, Preview> }>(() => ({
  entries: {},
}))
let sequence = 0

export function retainAttachmentPreview(attachmentId: string, conversationId: string, blob: Blob) {
  if (!blob.type.startsWith('image/') || blob.size > MAX_PREVIEW_BYTES) {
    return
  }
  let entries = { ...useAttachmentPreviews.getState().entries }
  const existing = entries[attachmentId]
  if (existing) {
    entries[attachmentId] = {
      ...existing,
      conversations: new Set([...existing.conversations, conversationId]),
      touched: ++sequence,
    }
  } else {
    entries[attachmentId] = {
      url: URL.createObjectURL(blob),
      size: blob.size,
      conversations: new Set([conversationId]),
      touched: ++sequence,
    }
  }
  let bytes = Object.values(entries).reduce((total, item) => total + item.size, 0)
  // 有界LRU，回收后界面自动降级为元数据，不谎称原件永久可用。
  for (const [id, item] of Object.entries(entries).sort((a, b) => a[1].touched - b[1].touched)) {
    if (Object.keys(entries).length <= MAX_PREVIEW_COUNT && bytes <= MAX_PREVIEW_BYTES) {
      break
    }
    URL.revokeObjectURL(item.url)
    bytes -= item.size
    entries = Object.fromEntries(Object.entries(entries).filter(([key]) => key !== id))
  }
  useAttachmentPreviews.setState({ entries })
}

export function touchAttachmentPreview(id: string) {
  const item = useAttachmentPreviews.getState().entries[id]
  if (item) {
    item.touched = ++sequence
  }
}

/** 删除会话只移除该会话的预览引用，不删除供应商文件。 */
export function releaseConversationPreviews(conversationId: string) {
  let entries = { ...useAttachmentPreviews.getState().entries }
  for (const [id, item] of Object.entries(entries)) {
    if (!item.conversations.has(conversationId)) {
      continue
    }
    const conversations = new Set(item.conversations)
    conversations.delete(conversationId)
    if (!conversations.size) {
      URL.revokeObjectURL(item.url)
      entries = Object.fromEntries(Object.entries(entries).filter(([key]) => key !== id))
    } else {
      entries[id] = { ...item, conversations }
    }
  }
  useAttachmentPreviews.setState({ entries })
}

export function clearAttachmentPreviews() {
  for (const item of Object.values(useAttachmentPreviews.getState().entries)) {
    URL.revokeObjectURL(item.url)
  }
  useAttachmentPreviews.setState({ entries: {} })
}
onSessionInvalidated(clearAttachmentPreviews)
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', clearAttachmentPreviews)
}

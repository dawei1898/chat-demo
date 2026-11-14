import { ApiError } from './client.js'
import { sessionEpoch, assertCurrentSession, invalidateSession } from '../auth/sessionBoundary.js'

export type AttachmentMetadata = {
  id: string
  name: string
  size: number
  mimeType: string
  isImage: boolean
  status: 'ready' | 'pending' | 'failed' | 'unknown' | 'deleted'
  serverId: null
}

export class AttachmentError extends ApiError {
  constructor(
    message: string,
    status?: number,
    readonly code?: string
  ) {
    super(status ? 'http' : 'network', message, status)
  }
}

/** 原件只送同源业务后端；uploadKey复用本次任务ID，重试不生成新供应商文件。 */
export async function uploadBusinessAttachment(file: File, uploadKey: string, signal: AbortSignal) {
  const epoch = sessionEpoch()
  const body = new FormData()
  body.set('file', file)
  body.set('uploadKey', uploadKey)
  const response = await fetch('/api/attachments', {
    method: 'POST',
    credentials: 'same-origin',
    body,
    signal,
  })
  assertCurrentSession(epoch)
  signal.throwIfAborted()
  if (response.status === 401) {
    invalidateSession()
    throw new DOMException('登录已失效', 'AbortError')
  }
  const result = await response.json().catch(() => null)
  assertCurrentSession(epoch)
  signal.throwIfAborted()
  if (!response.ok) {
    // 仅显示本地分类，不把供应商响应或敏感错误详情直接暴露给页面。
    const message =
      response.status === 413
        ? '文件超过8 MiB限制'
        : response.status === 415
          ? '此文件格式暂不支持'
          : response.status === 403 || response.status === 404
            ? '无权访问此附件或附件已失效'
            : response.status === 409
              ? '上传结果无法确认或任务冲突，请勿重复上传，请联系管理员核对'
              : response.status === 429
                ? '上传过于频繁，请稍后重试'
                : '上传未成功，请稍后重试核对'
    throw new AttachmentError(message, response.status, result?.error?.code)
  }
  if (!result || typeof result.id !== 'string' || result.status !== 'ready') {
    throw new AttachmentError('附件尚未就绪，请稍后重试核对', 409)
  }
  return result as AttachmentMetadata
}

/** 核对只发送当前任务标识，不再次上传原件，也不接受浏览器提供供应商ID。 */
export async function reconcileBusinessAttachment(uploadKey: string, signal: AbortSignal) {
  const epoch = sessionEpoch()
  async function request(url: string, method: string) {
    const response = await fetch(url, { method, credentials: 'same-origin', signal })
    assertCurrentSession(epoch)
    signal.throwIfAborted()
    if (response.status === 401) {
      invalidateSession()
      throw new DOMException('登录已失效', 'AbortError')
    }
    const result = await response.json().catch(() => null)
    assertCurrentSession(epoch)
    signal.throwIfAborted()
    if (!response.ok) {
      const message =
        response.status === 404
          ? '未找到本次上传记录，请联系管理员核对；不会重新上传'
          : response.status === 429
            ? '核对过于频繁，请稍后再试'
            : result?.error?.code === 'ATTACHMENT_UPLOAD_PENDING'
              ? '附件仍在上传，请稍后核对'
              : '暂时无法确认附件，请联系管理员核对；不会重新上传'
      throw new AttachmentError(message, response.status, result?.error?.code)
    }
    if (!result || typeof result.id !== 'string') {
      throw new AttachmentError('核对结果无效，请联系管理员', 502)
    }
    return result as AttachmentMetadata
  }
  const existing = await request(
    `/api/attachments/by-upload-key/${encodeURIComponent(uploadKey)}`,
    'GET'
  )
  const result =
    existing.status === 'ready'
      ? existing
      : await request(`/api/attachments/${encodeURIComponent(existing.id)}/reconcile`, 'POST')
  if (result.status !== 'ready') {
    throw new AttachmentError('附件尚未就绪，请稍后核对', 409)
  }
  return result
}

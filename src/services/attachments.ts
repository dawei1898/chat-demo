import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import {
  uploadBusinessAttachment,
  reconcileBusinessAttachment,
  AttachmentError,
} from './api/attachments.js'
import {
  sessionEpoch,
  isCurrentSession,
  assertCurrentSession,
  onSessionInvalidated,
} from './auth/sessionBoundary.js'
import { classifyApiError, getUploadErrorInfo } from './api/errors.js'
import type { FilePurpose } from './api/types.js'

/** 当前业务后端的小白名单；文件真实格式与UTF-8编码仍由后端核验 */
export const ACCEPTED_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'txt',
  'md',
  'csv',
  'json',
  'log',
  'js',
  'ts',
  'py',
  'css',
  'java',
  'go',
  'rs',
]
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 本应用单文件大小上限，比供应商上限更严格 */
export const MAX_SIZE_MB = 8
/** 文本附件使用相同的业务体积上限 */
export const MAX_USER_DATA_SIZE_MB = 8
export const MAX_COUNT = 10
/** 同时上传的文件数 */
const MAX_CONCURRENT = 2

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要服务端做版面解析的文档；其余非图片文件（纯文本、代码、表格、电子书）无需解析 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

/** 上传时的 purpose：图片不传，PDF 与 Word、PPT 做版面解析，其余按 user_data 上传 */
export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件允许的最大体积（MB），按上传时的 purpose 区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : MAX_SIZE_MB

/** 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加 */
export const validateFiles = (files: File[], currentCount: number): TranslationMessage | null => {
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

/**
 * 上传失败在附件上显示的文案：与设计稿状态对应的用具体原因，其余统一「上传失败」。
 * 服务端原文多为英文且较长，不直接展示。
 */
export const describeUploadError = (error: unknown): TranslationMessage => {
  if (classifyApiError(error) === 'serverBusy') {
    return { key: 'uploadServerBusy' }
  }
  if (getUploadErrorInfo(error)?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  return { key: 'uploadFileStatusFailed' }
}

type NoticeListener = (notice: LinkedMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 订阅需要额外提示的上传失败（配额达到上限），由界面层转成 toast */
export const onUploadNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 删除已上传文件的接口文档 */
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/api/delete-file'

/** 文件数或存储空间达到上限：附件上只放得下「上传失败」，原因另用 toast 说明并引导删除旧文件 */
export const describeUploadQuota = (error: unknown): LinkedMessage | undefined => {
  const info = getUploadErrorInfo(error)
  const link = { key: 'uploadDeleteFiles', href: DELETE_FILE_DOCS_URL } as const
  if (info?.code === 'fileCountLimit') {
    return { type: 'error', key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' }, link }
  }
  if (info?.code === 'storageLimit') {
    return { type: 'error', key: 'uploadStorageLimit', params: { limit: info.limit ?? '' }, link }
  }
  return undefined
}

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0

const next = () => {
  while (running < MAX_CONCURRENT) {
    const job = queue.shift()
    if (!job) {
      return
    }
    running++
    void job().finally(() => {
      running--
      next()
    })
  }
}

/** 排队上传，最多同时上传 MAX_CONCURRENT 个；排队期间中止的任务不会发出请求 */
const enqueueUpload = (
  uploadKey: string,
  file: Blob,
  name: string,
  isImage: boolean,
  signal: AbortSignal
) =>
  new Promise<string>((resolve, reject) => {
    queue.push(async () => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      try {
        const body = new File([file], name, {
          type: file.type || MIME_BY_EXT[getFileExt(name)] || '',
        })
        void isImage
        resolve((await uploadBusinessAttachment(body, uploadKey, signal)).id)
      } catch (error) {
        reject(error)
      }
    })
    next()
  })

/** 上传任务只保存在当前身份内存；完成后仅持有业务附件ID，不保存供应商ID。 */
export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; attachmentId: string }
  | { status: 'error'; error: TranslationMessage | string; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>()

/** 开始（或复用进行中的）上传，返回业务attachmentId；失败时任务记为 error 并抛出原错误 */
export const uploadAttachment = (
  _apiKey: string,
  id: string,
  blob: Blob,
  name: string,
  isImage: boolean
): Promise<string> => {
  const current = pending.get(id)
  if (current) {
    return current.promise
  }
  const epoch = sessionEpoch()
  const controller = new AbortController()
  setTask(id, { status: 'uploading' })
  const promise = enqueueUpload(id, blob, name, isImage, controller.signal)
    .then((attachmentId) => {
      assertCurrentSession(epoch)
      controller.signal.throwIfAborted()
      setTask(id, { status: 'done', attachmentId })
      return attachmentId
    })
    .catch((error: unknown) => {
      if (!isCurrentSession(epoch) || pending.get(id)?.controller !== controller) {
        throw error
      }
      if (controller.signal.aborted) {
        setTask(id, null)
      } else {
        setTask(id, {
          status: 'error',
          error:
            error instanceof AttachmentError
              ? error.message
              : '连接中断，上传结果未知；请勿重新上传，请联系管理员核对',
          // 仅明确限流拒绝允许用户手动用原key重试，其他不确定结果不重传。
          retryable: error instanceof AttachmentError && error.status === 429,
        })
        const notice = describeUploadQuota(error)
        if (notice) {
          for (const listener of noticeListeners) {
            listener(notice)
          }
        }
      }
      throw error
    })
    .finally(() => {
      if (pending.get(id)?.controller === controller) {
        pending.delete(id)
      }
    })
  pending.set(id, { promise, controller })
  return promise
}

/** 人工点击核对复用本次任务，网络错误不会退回原件上传路径。 */
export const reconcileAttachment = (id: string): Promise<string> => {
  const current = pending.get(id)
  if (current) { return current.promise }
  const epoch = sessionEpoch()
  const controller = new AbortController()
  setTask(id, { status: 'uploading' })
  const promise = reconcileBusinessAttachment(id, controller.signal)
    .then((result) => {
      assertCurrentSession(epoch)
      controller.signal.throwIfAborted()
      setTask(id, { status: 'done', attachmentId: result.id })
      return result.id
    })
    .catch((error: unknown) => {
      if (
        isCurrentSession(epoch) &&
        pending.get(id)?.controller === controller &&
        !controller.signal.aborted
      ) {
        setTask(id, {
          status: 'error',
          retryable: false,
          error:
            error instanceof AttachmentError
              ? error.message
              : '核对连接中断，请稍后再核对；不会重新上传',
        })
      }
      throw error
    })
    .finally(() => {
      if (pending.get(id)?.controller === controller) { pending.delete(id) }
    })
  pending.set(id, { promise, controller })
  return promise
}

export const cancelUpload = (id: string) => {
  pending.get(id)?.controller.abort()
  pending.delete(id)
  setTask(id, null)
}

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  log: 'text/plain',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/plain',
  css: 'text/css',
  java: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
}

/** 取文件的 MIME：优先用浏览器给出的类型，缺失时按扩展名推断 */
export const resolveMimeType = (file: File) => file.type || MIME_BY_EXT[getFileExt(file.name)] || ''

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

// 身份切换立即终止上传并清理内存；迟到结果不能重新填入新账号任务。
onSessionInvalidated(() => {
  for (const task of pending.values()) {
    task.controller.abort()
  }
  pending.clear()
  useUploads.setState({ tasks: {} })
})

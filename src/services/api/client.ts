import { translate, type TranslationMessage } from '../../i18n/index.js'
import type { ApiErrorBody, FileObject, FilePurpose } from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

/** Legacy call sites fail closed: model credentials and calls now belong to the backend. */
export const verifyApiKey = async (_apiKey: string, _signal?: AbortSignal): Promise<void> => {
  void _apiKey
  void _signal
  throw new ApiError('http', 'API Key 仅由后端配置', 501)
}
export const uploadFile = async (
  _apiKey: string,
  _file: File,
  _purpose: FilePurpose | null,
  _signal?: AbortSignal
): Promise<FileObject> => {
  void _apiKey
  void _file
  void _purpose
  void _signal
  throw new ApiError('http', '本地后端首版暂不支持附件上传', 501)
}
export const deleteFile = async (_apiKey: string, _fileId: string): Promise<void> => {
  void _apiKey
  void _fileId
  throw new ApiError('http', '本地后端首版暂不支持附件管理', 501)
}

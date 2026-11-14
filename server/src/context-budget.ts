/** 请求体预算不是模型 token 计数；按完整 JSON 的 UTF-8 字节保守限制传输体积。 */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 256 * 1024

export class ContextBudgetExceededError extends Error {
  constructor() {
    // 不包含正文、工具参数或序列化后的请求，避免通过错误响应泄漏上下文。
    super('当前会话上下文过大，请开启新会话或选择更短的分支')
    this.name = 'ContextBudgetExceededError'
  }
}

/**
 * 在最终模型请求组装完后调用，system、tools、历史和续写 prefix 一并计入。
 * 返回实际 JSON 字节数供内部度量；绝不截断消息或修改请求。
 * 序列化失败与非法预算是调用方错误，不伪装成体积超限。
 */
export function assertContextBudget(
  request: unknown,
  maxBytes = DEFAULT_CONTEXT_BUDGET_BYTES
): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('上下文预算必须为正安全整数')
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(request)
  } catch {
    throw new TypeError('模型请求必须可序列化为 JSON')
  }
  if (serialized === undefined) {
    throw new TypeError('模型请求必须可序列化为 JSON')
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > maxBytes) {
    throw new ContextBudgetExceededError()
  }
  return bytes
}

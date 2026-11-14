/** 仅后端可配置的预算；测试可给 execute 传入更短预算，不接受浏览器覆盖。 */
export const generationBudgets = {
  totalMs: 240_000,
  connectMs: 30_000,
  idleMs: 60_000,
  clientWriteMs: 10_000,
  maxResponseBytes: 4 * 1024 * 1024,
  heartbeatMs: 10_000,
  pollMs: 1_500,
}
export type GenerationBudgets = typeof generationBudgets

const messages = {
  UPSTREAM_AUTH: '模型服务认证失败，请检查后端配置',
  UPSTREAM_RATE_LIMIT: '模型服务请求过于频繁，请稍后重试',
  UPSTREAM_UNAVAILABLE: '模型服务暂时不可用，请稍后重试',
  STREAM_INTERRUPTED: '模型连接提前中断，已保存可用部分内容',
  TOTAL_TIMEOUT: '生成超过时间上限，已保存可用部分内容',
  CONNECT_TIMEOUT: '连接模型服务超时，请稍后重试',
  IDLE_TIMEOUT: '模型长时间没有返回数据，已停止生成',
  CLIENT_SLOW: '客户端接收过慢，已停止生成并保存可用部分内容',
  RESPONSE_TOO_LARGE: '模型返回内容超过安全上限，已停止生成',
  DATABASE_UNAVAILABLE: '数据库暂时不可用，生成已停止，请刷新检查保存结果',
  LEASE_LOST: '生成已被其他请求结束或回收，请刷新查看保存结果',
  SAVE_FAILED: '最终保存失败，请刷新检查最近检查点，不能视为完成',
  SESSION_EXPIRED: '登录已失效，请重新登录',
} as const
export type GenerationFailureCode = keyof typeof messages
export class GenerationFailure extends Error {
  constructor(public code: GenerationFailureCode) {
    super(messages[code])
  }
}

/** 同时等待原操作、截止时间和取消；不因慢消费者令 finally 永久无法进入。 */
export async function bounded<T>(
  operation: Promise<T>,
  ms: number,
  code: GenerationFailureCode,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GenerationFailure(code)), ms)
        abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        if (signal?.aborted) {
          abort()
        } else {
          signal?.addEventListener('abort', abort, { once: true })
        }
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
    if (abort) {
      signal?.removeEventListener('abort', abort)
    }
  }
}

/** 逐块拉取并限制完整响应字节，未知事件/超长未结束行也无法无限占用内存。 */
export function boundedResponse(
  body: ReadableStream<Uint8Array>,
  limits: GenerationBudgets,
  signal: AbortSignal
) {
  const reader = body.getReader()
  let bytes = 0
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await bounded(reader.read(), limits.idleMs, 'IDLE_TIMEOUT', signal)
          if (result.done) {
            controller.close()
            return
          }
          bytes += result.value.byteLength
          if (bytes > limits.maxResponseBytes) {
            throw new GenerationFailure('RESPONSE_TOO_LARGE')
          }
          controller.enqueue(result.value)
        } catch (error) {
          void reader.cancel().catch(() => {})
          controller.error(error)
        }
      },
      cancel() {
        return reader.cancel()
      },
    },
    { highWaterMark: 0 }
  )
}

import type { MessageStreamEvent } from '../../src/services/api/types.js'

/** 上游用量是累计值：后续字段覆盖前值，不能把 start 与 delta 相加。 */
export function updateAttemptUsage(previous: Record<string, unknown> | null, event: MessageStreamEvent) {
  const next = event.type === 'message_start' ? event.message.usage
    : event.type === 'message_delta' ? event.usage : undefined
  return next ? { ...previous, ...next } : previous
}
/** 未知或无效计数保留 null；只有明确结束且计数齐全才标记完整。 */
export function normalizeUsage(raw: Record<string, unknown> | null, stoppedNormally: boolean) {
  const count = (key: string) => {
    const value = raw?.[key]
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  const input = count('input_tokens')
  const output = count('output_tokens')
  return { raw, input, output, cached: count('cache_read_input_tokens'),
    completeness: raw === null ? 'unknown' : stoppedNormally && input !== null && output !== null ? 'complete' : 'partial' }
}

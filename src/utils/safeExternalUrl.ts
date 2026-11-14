/** 模型和搜索结果均不可信：只允许显式 HTTP(S)，拒绝控制字符及嵌入凭据。 */
export function safeExternalUrl(value: string | null | undefined): string | undefined {
  if (
    !value ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    !/^https?:\/\//i.test(value)
  ) {
    return undefined
  }
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

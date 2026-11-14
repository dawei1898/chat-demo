// 认证边界只保存在内存，不读取旧版浏览器凭据或聊天数据库。
let epoch = 0
const listeners = new Set<() => void>()
export const sessionEpoch = () => epoch
export function invalidateSession() {
  epoch += 1
  listeners.forEach((listener) => listener())
  window.dispatchEvent(new Event('chat-auth-invalidated'))
}
export function onSessionInvalidated(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const isCurrentSession = (value: number) => epoch === value
export function assertCurrentSession(value: number) {
  if (!isCurrentSession(value)) {
    throw new DOMException('登录状态已改变', 'AbortError')
  }
}

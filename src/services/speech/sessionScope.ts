import { isCurrentSession, onSessionInvalidated, sessionEpoch } from '../auth/sessionBoundary.js'

/** 每次语音操作绑定当前身份；退出、离页和组件卸载都使迟到结果失效。 */
export const createSpeechScope = (onCancel: () => void) => {
  const epoch = sessionEpoch()
  let active = true
  const cancel = (notify = true) => {
    if (!active) {
      return
    }
    active = false
    unsubscribe()
    window.removeEventListener('pagehide', onPageHide)
    if (notify) {
      onCancel()
    }
  }
  const onPageHide = () => cancel()
  const unsubscribe = onSessionInvalidated(cancel)
  window.addEventListener('pagehide', onPageHide)
  return { cancel, isCurrent: () => active && isCurrentSession(epoch) }
}

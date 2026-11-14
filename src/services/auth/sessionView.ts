// 网络错误和请求中间态不等于退出：保留上次确认的身份，防止误清草稿。
export function resolveConfirmedIdentity(
  previous: string | null,
  next: string | null,
  pending: boolean,
  failed: boolean
) {
  return pending || failed ? previous : next
}

// 只有成功确认无用户时显示登录表单；不确定时继续遮挡私有内容。
export function authGateView(state: {
  pending: boolean
  unavailable: boolean
  locked: boolean
  userId: string | null
  identity: string | null
}): 'checking' | 'unavailable' | 'authenticated' | 'login' {
  if (state.unavailable) {
    return 'unavailable'
  }
  if (state.pending || state.locked || state.userId !== state.identity) {
    return 'checking'
  }
  return state.userId ? 'authenticated' : 'login'
}

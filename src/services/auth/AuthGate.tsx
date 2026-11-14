import { invalidateSession } from './sessionBoundary.js'
import { resolveConfirmedIdentity, authGateView } from './sessionView.js'
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({ basePath: '/api/auth' })

export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession()
  const unauthorized = error?.status === 401
  const [locked, setLocked] = useState(false)
  const [verificationFailed, setVerificationFailed] = useState(false)
  const [identity, setIdentity] = useState<string | null>(null)
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const channel = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    const lock = () => {
      setLocked(true)
    }
    const recheck = () => {
      invalidateSession()
      // 重新载入会清空所有组件内部状态；登录 Cookie 由服务端再次确认。
      window.location.reload()
    }
    window.addEventListener('chat-auth-invalidated', lock)
    channel.current = new BroadcastChannel('deepseek-chat-auth')
    channel.current.onmessage = recheck
    let active = true
    let currentCheck: AbortController | null = null
    let checking = false
    const verify = async (mask: boolean) => {
      if (!active || checking || document.visibilityState !== 'visible') {
        return
      }
      checking = true
      const controller = new AbortController()
      currentCheck = controller
      const timeout = window.setTimeout(() => controller.abort(), 8000)
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('认证检查超时或已取消', 'AbortError')),
          { once: true }
        )
      })
      if (mask) {
        setLocked(true)
      }
      try {
        const response = await Promise.race([
          fetch('/api/auth/get-session', {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          }),
          aborted,
        ])
        if (!response.ok && response.status !== 401) {
          throw new Error('认证检查失败')
        }
        const session =
          response.status === 401 ? null : await Promise.race([response.json(), aborted])
        if (!active || controller.signal.aborted) {
          return
        }
        if ((session?.user?.id ?? null) !== currentIdentity.current || !session?.user) {
          invalidateSession()
          await Promise.race([refetch(), aborted])
        } else if (error) {
          await Promise.race([refetch(), aborted])
        }
        if (active && !controller.signal.aborted) {
          setVerificationFailed(false)
          setLocked(false)
        }
      } catch {
        if (active) {
          // 网络故障不能证明登录失效：遮挡私有页面，但保留身份和草稿等待重试。
          setVerificationFailed(true)
          setLocked(true)
        }
      } finally {
        window.clearTimeout(timeout)
        currentCheck = null
        checking = false
      }
    }
    // 定时只核验身份，不清理正常草稿或中断流；失效时才跨越认证边界。
    const timer = window.setInterval(() => {
      void verify(false)
    }, 20000)
    // 文件选择器关闭也会触发 focus：后台核验，不能先卸载上传组件或弹出登录表单。
    // 真正的失效/换号仍清理会话；服务错误仍遮挡私有页面，业务请求始终由后端鉴权。
    const resume = () => {
      void verify(false)
    }
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    const offline = () => {
      setVerificationFailed(true)
      setLocked(true)
    }
    window.addEventListener('offline', offline)
    return () => {
      active = false
      currentCheck?.abort()
      window.removeEventListener('chat-auth-invalidated', lock)
      window.removeEventListener('focus', resume)
      window.removeEventListener('online', resume)
      window.removeEventListener('offline', offline)
      window.clearInterval(timer)
      channel.current?.close()
    }
  }, [refetch, error])
  // 只有成功的认证响应才能确认退出或换号；刷新中和服务错误都不是未登录。
  const confirmedId = resolveConfirmedIdentity(
    identity,
    data?.user.id ?? null,
    isPending,
    Boolean(error) && !unauthorized
  )
  useEffect(() => {
    if (identity !== confirmedId) {
      invalidateSession()
      setIdentity(confirmedId)
      setLocked(false)
    }
  }, [confirmedId, identity])
  const [canRegister, setCanRegister] = useState(false)
  useEffect(() => {
    let active = true
    void fetch('/api/auth-policy', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((value) => {
        if (active) {
          setCanRegister(value?.registrationEnabled === true)
        }
      })
      .catch(() => {
        if (active) {
          setCanRegister(false)
        }
      })
    return () => {
      active = false
    }
  }, [])
  const [register, setRegister] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) {
      return
    }
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setFailure('')
    try {
      const email = String(form.get('email')).trim()
      const password = String(form.get('password'))
      if (register && !canRegister) {
        setFailure('当前环境不开放注册')
        return
      }
      const result = register
        ? await authClient.signUp.email({ email, password, name: String(form.get('name')).trim() })
        : await authClient.signIn.email({ email, password })
      if (result.error) {
        setFailure(
          register ? '注册未成功，请检查输入或使用已有账号登录' : '登录失败，请检查邮箱和密码'
        )
      } else if (register) {
        setRegister(false)
        setFailure('注册请求已处理，请使用账号密码登录')
      } else {
        invalidateSession()
        channel.current?.postMessage('changed')
        window.location.reload()
      }
    } catch {
      setFailure('无法连接认证服务，请确认本地后端已启动。')
    } finally {
      setBusy(false)
    }
  }
  const view = authGateView({
    pending: isPending,
    unavailable: (Boolean(error) && !unauthorized) || verificationFailed,
    locked,
    userId: data?.user.id ?? null,
    identity,
  })
  // 验证中或暂时断网时不能显示密码表单，避免让用户误以为需要重新登录。
  if (view === 'checking' || view === 'unavailable') {
    return (
      <main style={{ maxWidth: 420, margin: '10vh auto', padding: 28 }}>
        <h1>DeepSeek Chat</h1>
        <p role="status">
          {view === 'checking'
            ? '正在确认登录状态…'
            : '暂时无法确认登录状态，可能是网络波动或后端正在重启。'}
        </p>
        <p>无需重新输入密码；连接恢复后会自动重试，草稿仍保留在本页内存中。</p>
        <button disabled={busy} onClick={() => window.dispatchEvent(new Event('focus'))}>
          重试连接
        </button>
      </main>
    )
  }
  if (view === 'authenticated' && data?.user) {
    return (
      <>
        <div
          style={{
            position: 'fixed',
            right: 16,
            top: 8,
            zIndex: 1000,
            display: 'flex',
            gap: 12,
            fontSize: 12,
          }}
        >
          <span>{data.user.email}</span>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              invalidateSession()
              channel.current?.postMessage('changed')
              try {
                const result = await authClient.signOut()
                if (result.error) {
                  setFailure(result.error.message ?? '退出失败')
                } else {
                  channel.current?.postMessage('changed')
                  window.location.reload()
                }
              } catch {
                setFailure('退出失败，请重试')
              } finally {
                setBusy(false)
              }
            }}
          >
            退出登录
          </button>
          {failure && <span role="alert">{failure}</span>}
        </div>
        {children}
      </>
    )
  }
  return (
    <main style={{ maxWidth: 420, margin: '10vh auto', padding: 28 }}>
      <h1>DeepSeek Chat</h1>
      <p>
        登录后使用云端会话。模型密钥仅由后端管理。邮箱仅作登录标识，未验证所有权；不提供密码找回或第三方登录。
      </p>
      <form onSubmit={(event) => void submit(event)} style={{ display: 'grid', gap: 16 }}>
        {register && (
          <label>
            昵称
            <input
              name="name"
              required
              maxLength={80}
              autoComplete="name"
              style={{ display: 'block', width: '100%' }}
            />
          </label>
        )}
        <label>
          邮箱
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            style={{ display: 'block', width: '100%' }}
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            required
            minLength={10}
            maxLength={128}
            autoComplete={register ? 'new-password' : 'current-password'}
            style={{ display: 'block', width: '100%' }}
          />
        </label>
        {failure && <p role="alert">{failure}</p>}
        <button disabled={busy} type="submit">
          {busy ? '处理中…' : register ? '注册' : '登录'}
        </button>
        <button
          disabled={busy || !canRegister}
          type="button"
          onClick={() => {
            setRegister(!register)
            setFailure('')
          }}
        >
          {register ? '已有账号，去登录' : '没有账号，去注册'}
        </button>
      </form>
    </main>
  )
}

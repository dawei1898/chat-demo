import { useState, type ReactNode, type FormEvent } from 'react'
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({ basePath: '/api/auth' })

export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession()
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
      const result = register
        ? await authClient.signUp.email({ email, password, name: String(form.get('name')).trim() })
        : await authClient.signIn.email({ email, password })
      if (result.error) {
        setFailure(result.error.message ?? '认证失败，请重试')
      } else {
        window.location.reload()
      }
    } catch {
      setFailure('无法连接认证服务，请确认本地后端已启动。')
    } finally {
      setBusy(false)
    }
  }
  if (isPending) {
    return <main style={{ padding: 40 }}>正在检查登录状态…</main>
  }
  if (data?.user) {
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
              try {
                const result = await authClient.signOut()
                if (result.error) {
                  setFailure(result.error.message ?? '退出失败')
                } else {
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
      <p>登录后使用云端会话。模型密钥仅由后端管理。</p>
      {error && (
        <p role="alert">
          认证服务暂不可用。<button onClick={() => void refetch()}>重试</button>
        </p>
      )}
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
          disabled={busy}
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

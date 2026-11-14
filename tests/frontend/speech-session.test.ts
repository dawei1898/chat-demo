import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
Object.defineProperty(globalThis, '__API_ORIGIN__', { value: '', configurable: true })
Object.defineProperty(globalThis, 'window', {
  value: Object.assign(new EventTarget(), { isSecureContext: true, setTimeout, clearTimeout }),
  configurable: true,
})
const { invalidateSession } = await import('../../src/services/auth/sessionBoundary.js')
const { createSpeechScope } = await import('../../src/services/speech/sessionScope.js')
const { useVoiceInput } = await import('../../src/components/chatInput/useVoiceInput.js')
const { toggleReadAloud, useReadAloud } = await import('../../src/services/speech/readAloud.js')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
let closed = 0
let played = 0
let stopped = 0
let processor: { onaudioprocess?: (event: unknown) => void } = {}
// 测试仅使用内存音频节点，不调用真实麦克风或扬声器。
class FakeAudioContext {
  currentTime = 0
  state = 'running'
  destination = {}
  close() {
    closed++
    return Promise.resolve()
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }
  createAnalyser() {
    return { connect() {}, disconnect() {} }
  }
  createScriptProcessor() {
    processor = { connect() {}, disconnect() {} } as typeof processor
    return processor
  }
  createBuffer() {
    return { copyToChannel() {}, duration: 1 }
  }
  createBufferSource() {
    return {
      connect() {},
      start() {
        played++
      },
    }
  }
}
Object.defineProperty(globalThis, 'AudioContext', { value: FakeAudioContext, configurable: true })
const fakeStream = {
  getTracks: () => [
    {
      stop() {
        stopped++
      },
    },
  ],
}
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => fakeStream } },
  configurable: true,
})

// 轻量 hook 调度器只执行本 hook 状态与卸载回调；不伪装浏览器端到端验收。
function mountVoice(onText: (text: string) => void) {
  const cells: unknown[] = []
  const cleanups: (() => void)[] = []
  let index = 0
  let first = true
  const internal = (
    React as unknown as {
      __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
        ReactCurrentDispatcher: { current: unknown }
      }
    }
  ).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const render = () => {
    index = 0
    const previous = internal.ReactCurrentDispatcher.current
    internal.ReactCurrentDispatcher.current = {
      useState(value: unknown) {
        const i = index++
        if (first) {
          cells[i] = value
        }
        return [
          cells[i],
          (next: unknown) => {
            cells[i] = next
          },
        ]
      },
      useRef(value: unknown) {
        const i = index++
        if (first) {
          cells[i] = { current: value }
        }
        return cells[i]
      },
      useCallback(fn: unknown) {
        return fn
      },
      useEffect(fn: () => unknown) {
        if (first) {
          const cleanup = fn()
          if (typeof cleanup === 'function') {
            cleanups.push(cleanup as () => void)
          }
        }
      },
    }
    try {
      return useVoiceInput(onText)
    } finally {
      first = false
      internal.ReactCurrentDispatcher.current = previous
    }
  }
  return { render, unmount: () => cleanups.forEach((cleanup) => cleanup()) }
}

test('语音scope退出/离页立即取消一次；卸载静默释放不回调组件', () => {
  let cancelled = 0
  const a = createSpeechScope(() => cancelled++)
  invalidateSession()
  assert.equal(a.isCurrent(), false)
  a.cancel()
  assert.equal(cancelled, 1)
  const b = createSpeechScope(() => cancelled++)
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(b.isCurrent(), false)
  const c = createSpeechScope(() => cancelled++)
  c.cancel(false)
  invalidateSession()
  assert.equal(cancelled, 2)
})

test('录音退出立即释放，迟到麦克风授权也释放；未上传旧音频', async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return Response.json({ text: '不应填入' })
  }
  const mounted = mountVoice(() => assert.fail('不应填入文本'))
  await mounted.render().toggle()
  const before = stopped
  invalidateSession()
  assert.ok(stopped > before)
  mounted.unmount()
  let release!: (stream: typeof fakeStream) => void
  navigator.mediaDevices.getUserMedia = () =>
    new Promise((resolve) => {
      release = resolve as typeof release
    })
  const pending = mountVoice(() => assert.fail('不应填入文本'))
  const start = pending.render().toggle()
  pending.unmount()
  const previous = stopped
  release(fakeStream)
  await start
  assert.ok(stopped > previous)
  assert.equal(requests, 0)
  navigator.mediaDevices.getUserMedia = async () => fakeStream as unknown as MediaStream
})

test('ASR迟到响应在退出/离页/卸载后不得写入新账号草稿', async () => {
  for (const action of ['logout', 'pagehide', 'unmount']) {
    let deliver!: (response: Response) => void
    let signal: AbortSignal | undefined
    globalThis.fetch = async (_url, options) => {
      signal = options?.signal as AbortSignal
      return new Promise((resolve) => {
        deliver = resolve
      })
    }
    const texts: string[] = []
    const mounted = mountVoice((text) => texts.push(text))
    await mounted.render().toggle()
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } })
    const finish = mounted.render().toggle()
    await tick()
    if (action === 'logout') {
      invalidateSession()
    } else if (action === 'pagehide') {
      window.dispatchEvent(new Event('pagehide'))
    } else {
      mounted.unmount()
    }
    assert.equal(signal?.aborted, true)
    deliver(Response.json({ text: '旧账号的转写' }))
    await finish
    assert.deepEqual(texts, [])
    mounted.unmount()
  }
})

test('TTS等待响应或读流时退出/离页立即中止，不播放迟到PCM', async () => {
  for (const duringRead of [false, true]) {
    let deliver!: (response: Response) => void
    let signal: AbortSignal | undefined
    let output!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller
      },
    })
    globalThis.fetch = async (_url, options) => {
      signal = options?.signal as AbortSignal
      return new Promise((resolve) => {
        deliver = resolve
      })
    }
    toggleReadAloud('test', 'text', () => assert.fail('失效操作不能显示迟到错误'))
    if (duringRead) {
      deliver(new Response(stream, { headers: { 'content-type': 'audio/pcm' } }))
      await tick()
    }
    const previous = closed
    if (duringRead) {
      window.dispatchEvent(new Event('pagehide'))
    } else {
      invalidateSession()
    }
    assert.equal(signal?.aborted, true)
    assert.ok(closed > previous)
    assert.equal(useReadAloud.getState().status, 'idle')
    if (!duringRead) {
      output.enqueue(new Uint8Array([0, 0]))
      deliver(new Response(stream, { headers: { 'content-type': 'audio/pcm' } }))
    }
    await tick()
    assert.equal(played, 0)
  }
})

test('新身份可正常转写，旧代次取消不影响下一次操作', async () => {
  invalidateSession()
  globalThis.fetch = async () => Response.json({ text: '当前账号的转写' })
  const texts: string[] = []
  const mounted = mountVoice((text) => texts.push(text))
  await mounted.render().toggle()
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } })
  await mounted.render().toggle()
  assert.deepEqual(texts, ['当前账号的转写'])
  assert.equal(mounted.render().status, 'idle')
  mounted.unmount()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { speechRoutes, validateWav, validateTts, isSupportedPcmContentType } from '../src/speech.js'
import { config } from '../src/config.js'

function wav(seconds = 1) {
  const bytes = new Uint8Array(44 + seconds * 16000 * 2)
  const view = new DataView(bytes.buffer)
  const tag = (offset: number, value: string) =>
    [...value].forEach((char, i) => {
      bytes[offset + i] = char.charCodeAt(0)
    })
  tag(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, bytes.length - 44, true)
  return bytes
}
test('WAV严格验证格式、时长与RIFF长度', () => {
  validateWav(wav())
  validateWav(wav(120))
  assert.throws(() => validateWav(wav(121)))
  const invalid = wav()
  invalid[34] = 8
  assert.throws(() => validateWav(invalid))
  assert.throws(() => validateWav(wav().slice(0, -1)))
  assert.throws(() => validateWav(new Uint8Array(44)))
})
test('TTS声线白名单、计费字符与额外字段限制', () => {
  assert.equal(validateTts({ text: '中'.repeat(5000), voice: 'stella' }).format, 'pcm')
  assert.throws(() => validateTts({ text: '中'.repeat(5001), voice: 'stella' }))
  assert.throws(() => validateTts({ text: 'ok', voice: 'unknown' }))
  assert.throws(() => validateTts({ text: 'ok', voice: 'tide', url: 'https://evil.invalid' }))
})
test('授权代理模拟上游：ASR、PCM、取消、脱敏与输入失败不调用上游', async () => {
  // 不读取实际密钥；替换配置为公开测试占位，结束后删除占位。
  const descriptor = Object.getOwnPropertyDescriptor(config, 'deepseekKey')
  Object.defineProperty(config, 'deepseekKey', {
    value: 'mock-speech-key',
    writable: true,
    configurable: true,
  })
  const original = globalThis.fetch
  const app = new Hono<{ Variables: { userId: string; sessionId: string } }>()
  app.use('*', async (c, next) => {
    c.set('userId', 'speech-test')
    c.set('sessionId', 'test-session')
    await next()
  })
  app.route('/api/speech', speechRoutes)
  let calls = 0
  let canceled = false
  let mode = 'asr'
  globalThis.fetch = async (url, init) => {
    calls++
    assert.ok(String(url).startsWith('https://api.deepseek.com/v1/tools/'))
    assert.ok(init?.signal)
    if (mode === 'failure') {
      return new Response('private upstream error', { status: 401 })
    }
    if (mode === 'asr') {
      return Response.json({ text: '你好', request_id: 'private-id' })
    }
    if (mode === 'json') {
      return Response.json({ error: 'private' })
    }
    if (mode === 'pending') {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0, 0]))
          },
          cancel() {
            canceled = true
          },
        }),
        { headers: { 'Content-Type': 'application/octet-stream' } }
      )
    }
    if (mode === 'cancel') {
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([0, 0]))
          },
          cancel() {
            canceled = true
          },
        }),
        { headers: { 'Content-Type': 'application/octet-stream' } }
      )
    }
    return new Response(new Uint8Array([0, 0, 1, 0]), {
      headers: {
        'Content-Type':
          mode === 'audio-pcm'
            ? 'audio/pcm; rate=24000; encoding=signed-integer; bits=16; channels=1'
            : 'application/octet-stream',
      },
    })
  }
  const tts = () =>
    app.request('/api/speech/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好', voice: 'tide' }),
    })
  try {
    const bad = await app.request('/api/speech/tts', {
      method: 'POST',
      body: JSON.stringify({ text: 'x', voice: 'wrong' }),
    })
    assert.equal(bad.status, 400)
    assert.equal(calls, 0)
    const form = new FormData()
    form.set('file', new Blob([wav()], { type: 'audio/wav' }), 'recording.wav')
    const asr = await app.request('/api/speech/asr', { method: 'POST', body: form })
    assert.deepEqual(await asr.json(), { text: '你好' })
    mode = 'pcm'
    const pcm = await tts()
    assert.equal(pcm.status, 200)
    assert.equal((await pcm.arrayBuffer()).byteLength, 4)
    mode = 'audio-pcm'
    const actualMime = await tts()
    assert.equal(actualMime.status, 200)
    assert.equal((await actualMime.arrayBuffer()).byteLength, 4)
    mode = 'failure'
    const error = await tts()
    assert.equal(error.status, 502)
    assert.ok(!(await error.text()).includes('private'))
    mode = 'json'
    const invalidPcm = await tts()
    assert.equal(invalidPcm.status, 502)
    mode = 'cancel'
    const streaming = await tts()
    await streaming.body?.cancel()
    assert.equal(canceled, true)
    mode = 'pending'
    canceled = false
    const controller = new AbortController()
    const pending = await app.request('/api/speech/tts', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好', voice: 'tide' }),
    })
    const reader = pending.body?.getReader()
    assert.ok(reader)
    assert.equal((await reader.read()).value?.byteLength, 2)
    const waiting = reader.read()
    controller.abort()
    await assert.rejects(waiting, /语音流传输失败/)
    assert.equal(canceled, true)
  } finally {
    globalThis.fetch = original
    if (descriptor) {
      Object.defineProperty(config, 'deepseekKey', descriptor)
    }
  }
})

test('真实app入口拒绝无会话、异源和超限请求，绝不调用上游', async () => {
  const { app } = await import('../src/app.js')
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error('unexpected upstream')
  }
  try {
    const request = (path: string, origin: string, body: string) =>
      app.request(path, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body,
      })
    assert.equal(
      (
        await request(
          '/api/speech/tts',
          config.origin,
          JSON.stringify({ text: '你好', voice: 'tide' })
        )
      ).status,
      401
    )
    assert.equal((await request('/api/speech/tts', 'https://untrusted.invalid', '{}')).status, 403)
    assert.equal(
      (await request('/api/speech/asr', config.origin, 'x'.repeat(8 * 1024 * 1024 + 16 * 1024 + 1)))
        .status,
      413
    )
    assert.equal(
      (await request('/api/speech/tts', config.origin, 'x'.repeat(128 * 1024 + 1))).status,
      413
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('接受实际audio/pcm并校验音频参数，拒绝JSON或不兼容音频', () => {
  assert.equal(
    isSupportedPcmContentType(
      'audio/pcm; rate=24000; encoding=signed-integer; bits=16; channels=1'
    ),
    true
  )
  assert.equal(isSupportedPcmContentType('application/octet-stream'), true)
  assert.equal(isSupportedPcmContentType('audio/pcm; rate="24000"'), true)
  for (const value of [
    null,
    'application/json',
    'audio/mpeg',
    'audio/L16',
    'audio/pcm; rate=48000',
    'audio/pcm; bits=32',
    'audio/pcm; channels=2',
    'audio/pcm; encoding=float',
    'audio/pcm; rate=24000; rate=24000',
  ]) {
    assert.equal(isSupportedPcmContentType(value), false)
  }
})

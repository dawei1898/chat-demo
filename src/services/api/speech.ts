import { sessionEpoch, assertCurrentSession, invalidateSession } from '../auth/sessionBoundary.js'
import { ApiError } from './client.js'
export type TtsVoice = 'stella' | 'tide'
export const TTS_SAMPLE_RATE = 24000
// 保留调用签名兼容现有录音/朗读组件，客户端密钥参数不读取、不发送。
async function request(path: string, body: BodyInit, signal?: AbortSignal, json = false) {
  const epoch = sessionEpoch()
  const response = await fetch(`/api/speech/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    body,
    signal,
    headers: json ? { 'Content-Type': 'application/json' } : undefined,
  })
  assertCurrentSession(epoch)
  if (response.status === 401) {
    invalidateSession()
    throw new DOMException('登录已失效', 'AbortError')
  }
  if (!response.ok) {
    throw new ApiError(
      'http',
      response.status === 401 ? '请先登录后使用语音。' : '语音请求失败，请稍后重试。',
      response.status
    )
  }
  return response
}
export const transcribe = async (
  _apiKey: string,
  audio: Blob,
  signal?: AbortSignal
): Promise<string> => {
  const body = new FormData()
  body.set('file', audio, 'recording.wav')
  const result = (await (await request('asr', body, signal)).json()) as { text: string }
  return result.text
}
export const synthesize = async (
  _apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  const response = await request('tts', JSON.stringify({ text, voice }), signal, true)
  if (!response.body) {
    throw new ApiError('http', '语音流为空。', 502)
  }
  return response.body
}

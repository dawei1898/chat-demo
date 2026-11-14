import { ApiError } from './client.js'
export type TtsVoice = 'stella' | 'tide'
export const TTS_SAMPLE_RATE = 24000
export const transcribe = async (_apiKey: string, _audio: Blob, _signal?: AbortSignal): Promise<string> => {
  void [_apiKey, _audio, _signal]
  throw new ApiError('http', '本地后端版本暂未开放语音识别。', 501)
}
export const synthesize = async (_apiKey: string, _text: string, _voice: TtsVoice, _signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
  void [_apiKey, _text, _voice, _signal]
  throw new ApiError('http', '本地后端版本暂未开放语音合成。', 501)
}

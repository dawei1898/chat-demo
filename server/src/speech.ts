import {Hono} from 'hono'
import {config} from './config.js'
import {pool} from './db/client.js'
import {sessionIsLive} from './auth-security.js'

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024

/** 接受供应商实际 PCM 媒体类型；显式音频参数必须与本地播放器契约一致。 */
export function isSupportedPcmContentType(header: string | null): boolean {
    if (!header) {
        return false
    }
    const [mime, ...parameters] = header
        .toLowerCase()
        .split(';')
        .map((part) => part.trim())
    if (!['audio/pcm', 'application/octet-stream'].includes(mime)) {
        return false
    }
    const expected: Record<string, string> = {
        rate: '24000',
        encoding: 'signed-integer',
        bits: '16',
        channels: '1',
    }
    const seen = new Set<string>()
    for (const parameter of parameters) {
        const match = parameter.match(/^([a-z]+)=(?:"([^"\r\n]*)"|([^"\s]+))$/)
        if (!match || seen.has(match[1]) || expected[match[1]] !== (match[2] ?? match[3])) {
            return false
        }
        seen.add(match[1])
    }
    return true
}

// 首版只接收可自行验证时长的 PCM16 WAV，不猜测 Opus 容器信息。
export function validateWav(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const fail = () => {
        throw new Error('INVALID_WAV')
    }
    if (
        bytes.length < 44 ||
        bytes.length > MAX_AUDIO_BYTES ||
        tag(0) !== 'RIFF' ||
        tag(8) !== 'WAVE' ||
        view.getUint32(4, true) + 8 !== bytes.length
    ) {
        fail()
    }
    let offset = 12
    let rate = 0
    let align = 0
    let dataBytes = 0
    let formats = 0
    let chunks = 0
    while (offset + 8 <= bytes.length) {
        const name = tag(offset)
        const size = view.getUint32(offset + 4, true)
        const start = offset + 8
        if (start + size > bytes.length) {
            fail()
        }
        if (name === 'fmt ') {
            if (++formats !== 1 || size !== 16 || view.getUint16(start, true) !== 1) {
                fail()
            }
            const channels = view.getUint16(start + 2, true)
            rate = view.getUint32(start + 4, true)
            align = view.getUint16(start + 12, true)
            if (
                ![1, 2].includes(channels) ||
                ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(rate) ||
                view.getUint16(start + 14, true) !== 16 ||
                align !== channels * 2 ||
                view.getUint32(start + 8, true) !== rate * align
            ) {
                fail()
            }
        } else if (name === 'data') {
            if (++chunks !== 1) {
                fail()
            }
            dataBytes = size
        }
        offset = start + size + (size % 2)
    }
    if (
        offset !== bytes.length ||
        formats !== 1 ||
        chunks !== 1 ||
        !dataBytes ||
        dataBytes % align ||
        dataBytes / (rate * align) > 120
    ) {
        fail()
    }
}

export function validateTts(body: unknown): {
    text: string
    voice_id: 'stella' | 'tide'
    format: 'pcm'
    filter_markdown: true
} {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('INVALID_TTS')
    }
    const value = body as Record<string, unknown>
    if (
        Object.keys(value).some((key) => !['text', 'voice'].includes(key)) ||
        typeof value.text !== 'string' ||
        !value.text.trim() ||
        !['stella', 'tide'].includes(String(value.voice))
    ) {
        throw new Error('INVALID_TTS')
    }
    // 汉字按双字符计费；其他 Unicode 码点按一字符计算。
    const count = [...value.text].reduce(
        (sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1),
        0
    )
    if (count > 10000 || Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) {
        throw new Error('INVALID_TTS')
    }
    return {
        text: value.text,
        voice_id: value.voice as 'stella' | 'tide',
        format: 'pcm',
        filter_markdown: true,
    }
}

const users = new Map<string, { start: number; count: number; active: number }>()

function acquire(userId: string): (() => void) | null {
    const now = Date.now()
    for (const [key, entry] of users) {
        if (!entry.active && now - entry.start > 60000) {
            users.delete(key)
        }
    }
    const entry = users.get(userId) ?? {start: now, count: 0, active: 0}
    if (now - entry.start > 60000) {
        entry.start = now
        entry.count = 0
    }
    if (entry.active >= 2 || entry.count >= 10 || (!users.has(userId) && users.size >= 10000)) {
        return null
    }
    entry.count++
    entry.active++
    users.set(userId, entry)
    return () => {
        entry.active--
    }
}

function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SPEECH_TIMEOUT')), ms)
        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (error) => {
                clearTimeout(timer)
                reject(error)
            }
        )
    })
}

export const speechRoutes = new Hono<{ Variables: { userId: string; sessionId: string } }>()
for (const kind of ['asr', 'tts'] as const) {
    speechRoutes.post(`/${kind}`, async (c) => {
        let body: FormData | string
        try {
            if (kind === 'asr') {
                const form = await c.req.formData()
                const file = form.get('file')
                if (
                    !(file instanceof File) ||
                    [...form.keys()].length !== 1 ||
                    file.size > MAX_AUDIO_BYTES ||
                    !['audio/wav', 'audio/wave', 'audio/x-wav'].includes(file.type)
                ) {
                    throw new Error('INVALID_WAV')
                }
                validateWav(new Uint8Array(await file.arrayBuffer()))
                body = new FormData()
                body.set('file', file, 'recording.wav')
            } else {
                body = JSON.stringify(validateTts(await c.req.json()))
            }
        } catch {
            return c.json(
                {error: {code: 'INVALID_SPEECH_INPUT', message: '语音输入格式、大小或时长不符合限制'}},
                400
            )
        }
        if (!config.deepseekKey) {
            return c.json({error: {code: 'SPEECH_NOT_CONFIGURED', message: '语音服务尚未配置'}}, 503)
        }
        const release = acquire(c.get('userId'))
        if (!release) {
            return c.json(
                {error: {code: 'RATE_LIMITED', message: '语音请求过于频繁，请稍后再试'}},
                429
            )
        }
        const controller = new AbortController()
        const abort = () => controller.abort()
        const totalTimer = setTimeout(abort, 120000)
        let pollTimer: ReturnType<typeof setTimeout> | undefined
        c.req.raw.signal.addEventListener('abort', abort, {once: true})
        if (c.req.raw.signal.aborted) {
            abort()
        }
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let closed = false
        const cleanup = () => {
            if (closed) {
                return
            }
            closed = true
            clearTimeout(totalTimer)
            clearTimeout(pollTimer)
            c.req.raw.signal.removeEventListener('abort', abort)
            controller.signal.removeEventListener('abort', cleanup)
            controller.abort()
            void reader?.cancel().catch(() => {
            })
            release()
        }
        controller.signal.addEventListener('abort', cleanup, {once: true})
        const poll = async () => {
            try {
                if (!(await deadline(sessionIsLive(pool, c.get('userId'), c.get('sessionId')), 5000))) {
                    abort()
                }
            } catch {
                abort()
            }
            if (!closed) {
                pollTimer = setTimeout(() => {
                    void poll()
                }, 2000)
            }
        }
        pollTimer = setTimeout(() => {
            void poll()
        }, 2000)
        try {
            if (controller.signal.aborted) {
                throw new Error('ABORTED')
            }
            const upstream = await deadline(
                fetch(`https://api.deepseek.com/v1/tools/${kind}`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${config.deepseekKey}`,
                        ...(kind === 'tts' ? {'Content-Type': 'application/json'} : {}),
                    },
                    body,
                    signal: controller.signal,
                }),
                30000
            )
            if (!upstream.ok || !upstream.body) {
                void upstream.body?.cancel().catch(() => {
                })
                const status = upstream.status === 429 ? 429 : 502
                cleanup()
                return c.json(
                    {error: {code: 'SPEECH_UPSTREAM_FAILED', message: '语音服务暂不可用，请稍后重试'}},
                    status
                )
            }
            if (controller.signal.aborted) {
                void upstream.body.cancel().catch(() => {
                })
                throw new Error('ABORTED')
            }
            if (kind === 'tts' && !isSupportedPcmContentType(upstream.headers.get('Content-Type'))) {
                void upstream.body.cancel().catch(() => {
                })
                throw new Error('INVALID_PCM_TYPE')
            }
            reader = upstream.body.getReader()
            let received = 0
            const started = Date.now()
            const read = async () => {
                if (controller.signal.aborted || Date.now() - started >= 120000) {
                    throw new Error('ABORTED')
                }
                if (!reader) {
                    throw new Error('NO_READER')
                }
                const item = await deadline(reader.read(), Math.min(15000, 120000 - (Date.now() - started)))
                if (controller.signal.aborted) {
                    throw new Error('ABORTED')
                }
                if (item.value) {
                    received += item.value.byteLength
                }
                if (received > (kind === 'asr' ? 256 * 1024 : 24_000 * 2 * 120)) {
                    throw new Error('RESPONSE_TOO_LARGE')
                }
                return item
            }
            if (kind === 'asr') {
                const chunks: Uint8Array[] = []
                for (; ;) {
                    const item = await read()
                    if (item.done) {
                        break
                    }
                    chunks.push(item.value)
                }
                const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: unknown }
                if (typeof result.text !== 'string') {
                    throw new Error('INVALID_RESPONSE')
                }
                cleanup()
                return c.json({text: result.text})
            }
            // 原始 PCM 不落盘；传输失败直接断流，不能把错误 JSON 混入音频。
            const stream = new ReadableStream<Uint8Array>({
                async pull(output) {
                    try {
                        const item = await read()
                        if (item.done) {
                            if (received % 2 || !received) {
                                throw new Error('INVALID_PCM')
                            }
                            cleanup()
                            output.close()
                        } else {
                            output.enqueue(item.value)
                        }
                    } catch {
                        cleanup()
                        output.error(new Error('语音流传输失败'))
                    }
                },
                cancel() {
                    cleanup()
                },
            })
            return new Response(stream, {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                },
            })
        } catch {
            cleanup()
            return c.json(
                {error: {code: 'SPEECH_UPSTREAM_FAILED', message: '语音服务暂不可用，请稍后重试'}},
                502
            )
        }
    })
}

/** 仅验证安全上传边界，不在本机解压、渲染或执行附件。 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export class AttachmentValidationError extends Error {
    constructor(
        public code: string,
        message: string,
        public status: 400 | 413 = 400
    ) {
        super(message)
    }
}

const invalid = (): never => {
    throw new AttachmentValidationError('INVALID_ATTACHMENT', '附件类型、格式或尺寸不符合限制')
}
const texts = new Map([
    ['txt', 'text/plain'],
    ['md', 'text/markdown'],
    ['csv', 'text/csv'],
    ['json', 'application/json'],
    ['log', 'text/plain'],
    ['js', 'text/javascript'],
    ['ts', 'text/plain'],
    ['py', 'text/plain'],
    ['css', 'text/css'],
    ['java', 'text/plain'],
    ['go', 'text/plain'],
    ['rs', 'text/plain'],
])

export function validateAttachment(
    file: { name: string; type: string; size: number },
    bytes: Uint8Array
): { mimeType: string; isImage: boolean; purpose: 'rich_layout_recognition' | 'user_data' | null } {
    if (file.size > MAX_ATTACHMENT_BYTES || bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentValidationError('ATTACHMENT_TOO_LARGE', '附件不能超过 8 MiB', 413)
    }
    if (
        !bytes.length ||
        file.size !== bytes.length ||
        Buffer.byteLength(file.name) > 255 ||
        [...file.name].some(
            (char) =>
                char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\'
        )
    ) {
        invalid()
    }
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const mime = file.type.toLowerCase().split(';')[0]?.trim() ?? ''
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const dimensions = (w: number, h: number) => {
        if (!w || !h || w > 4096 || h > 4096) {
            invalid()
        }
    }
    let expected = ''
    if (ext === 'png') {
        expected = 'image/png'
        if (data.length < 45 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
            invalid()
        }
        let at = 8
        let chunks = 0
        let image = false
        let end = false
        while (at + 12 <= data.length) {
            const size = data.readUInt32BE(at)
            const kind = data.toString('latin1', at + 4, at + 8)
            if (size > data.length - at - 12 || end) {
                invalid()
            }
            if (!chunks++) {
                if (kind !== 'IHDR' || size !== 13) {
                    invalid()
                }
                dimensions(data.readUInt32BE(at + 8), data.readUInt32BE(at + 12))
            } else if (kind === 'IHDR') {
                invalid()
            }
            if (kind === 'IDAT' && size) {
                image = true
            }
            if (kind === 'IEND') {
                if (size) {
                    invalid()
                }
                end = true
            }
            at += size + 12
        }
        if (at !== data.length || !image || !end) {
            invalid()
        }
    } else if (ext === 'jpg' || ext === 'jpeg') {
        expected = 'image/jpeg'
        if (
            data.length < 12 ||
            data.readUInt16BE(0) !== 0xffd8 ||
            data.readUInt16BE(data.length - 2) !== 0xffd9
        ) {
            invalid()
        }
        let at = 2
        let frame = false
        let scan = false
        while (at < data.length - 2) {
            if (data[at++] !== 255) {
                invalid()
            }
            while (data[at] === 255) {
                at++
            }
            const marker = data[at++]
            if (
                marker === undefined ||
                marker === 0 ||
                marker === 0xd8 ||
                marker === 0xd9 ||
                (marker >= 0xd0 && marker <= 0xd7)
            ) {
                invalid()
            }
            if (at + 2 > data.length) {
                invalid()
            }
            const size = data.readUInt16BE(at)
            if (size < 2 || at + size > data.length - 2) {
                invalid()
            }
            if ([0xc0, 0xc1, 0xc2].includes(marker)) {
                if (size < 8 || frame) {
                    invalid()
                }
                dimensions(data.readUInt16BE(at + 5), data.readUInt16BE(at + 3))
                frame = true
            }
            if (marker === 0xda) {
                scan = true
                break
            }
            at += size
        }
        if (!frame || !scan) {
            invalid()
        }
    } else if (ext === 'gif') {
        expected = 'image/gif'
        if (data.length < 14 || !['GIF87a', 'GIF89a'].includes(data.toString('latin1', 0, 6))) {
            invalid()
        }
        dimensions(data.readUInt16LE(6), data.readUInt16LE(8))
        let at = 13 + (data[10] & 128 ? 3 * 2 ** ((data[10] & 7) + 1) : 0)
        let images = 0
        let end = false
        const subblocks = () => {
            for (; ;) {
                if (at >= data.length) {
                    invalid()
                }
                const size = data[at++]
                if (!size) {
                    break
                }
                at += size
                if (at > data.length) {
                    invalid()
                }
            }
        }
        while (at < data.length) {
            const tag = data[at++]
            if (tag === 0x3b) {
                end = true
                break
            }
            if (tag === 0x21) {
                if (at >= data.length) {
                    invalid()
                }
                at++
                subblocks()
            } else if (tag === 0x2c) {
                if (at + 9 > data.length) {
                    invalid()
                }
                dimensions(data.readUInt16LE(at + 4), data.readUInt16LE(at + 6))
                const packed = data[at + 8]
                at += 9
                if (packed & 128) {
                    at += 3 * 2 ** ((packed & 7) + 1)
                }
                if (at >= data.length || data[at] < 2 || data[at] > 8) {
                    invalid()
                }
                at++
                subblocks()
                images++
            } else {
                invalid()
            }
        }
        if (!end || at !== data.length || !images) {
            invalid()
        }
    } else if (ext === 'webp') {
        expected = 'image/webp'
        if (
            data.length < 30 ||
            data.toString('latin1', 0, 4) !== 'RIFF' ||
            data.toString('latin1', 8, 12) !== 'WEBP' ||
            data.readUInt32LE(4) + 8 !== data.length
        ) {
            invalid()
        }
        let at = 12
        let image = false
        while (at + 8 <= data.length) {
            const kind = data.toString('latin1', at, at + 4)
            const size = data.readUInt32LE(at + 4)
            const start = at + 8
            if (size > data.length - start) {
                invalid()
            }
            if (kind === 'VP8X') {
                if (size !== 10 || data[start] & 2) {
                    invalid()
                } // 首版拒绝动画 WebP。
                dimensions(data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1)
            } else if (kind === 'VP8 ') {
                if (size < 10 || data.subarray(start + 3, start + 6).toString('hex') !== '9d012a') {
                    invalid()
                }
                dimensions(data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff)
                image = true
            } else if (kind === 'VP8L') {
                if (size < 5 || data[start] !== 0x2f) {
                    invalid()
                }
                const bits = data.readUInt32LE(start + 1)
                dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
                image = true
            } else if (kind === 'ANIM' || kind === 'ANMF') {
                invalid()
            }
            at = start + size + (size % 2)
        }
        if (!image || at !== data.length) {
            invalid()
        }
    } else if (ext === 'pdf') {
        if (
            mime !== 'application/pdf' ||
            !/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(data.subarray(0, 12).toString('latin1')) ||
            !/%%EOF\s*$/.test(data.subarray(-1024).toString('latin1'))
        ) {
            invalid()
        }
        return {mimeType: 'application/pdf', isImage: false, purpose: 'rich_layout_recognition'}
    } else {
        const canonical = texts.get(ext)
        if (!canonical) {
            return invalid()
        }
        if (
            !canonical ||
            ![canonical, 'text/plain', ...(ext === 'js' ? ['application/javascript'] : [])].includes(mime)
        ) {
            invalid()
        }
        let text: string
        try {
            text = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
        } catch {
            return invalid()
        }
        if (
            [...text].some((char) => {
                const code = char.charCodeAt(0)
                return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159)
            }) ||
            !text.trim()
        ) {
            invalid()
        }
        if (ext === 'json') {
            try {
                JSON.parse(text)
            } catch {
                return invalid()
            }
        }
        return {mimeType: canonical, isImage: false, purpose: 'user_data'}
    }
    if (mime !== expected) {
        invalid()
    }
    return {mimeType: expected, isImage: true, purpose: null}
}

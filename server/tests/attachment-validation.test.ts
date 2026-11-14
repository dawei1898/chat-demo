import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAttachment, MAX_ATTACHMENT_BYTES } from '../src/attachment-validation.js'
const check = (name: string, type: string, data: Uint8Array) =>
  validateAttachment({ name, type, size: data.length }, data)
const text = (s: string) => new TextEncoder().encode(s)
test('文本UTF8、MIME和白名单严格验证', () => {
  assert.equal(check('笔记.md', 'text/markdown', text('你好')).purpose, 'user_data')
  assert.equal(check('data.json', 'application/json', text('{"a":1}')).isImage, false)
  for (const [name, mime, bytes] of [
    ['x.txt', 'text/plain', new Uint8Array([0xff])],
    ['x.txt', 'text/plain', text('hello\u0000world')],
    ['x.txt', 'image/png', text('hello')],
    ['x.html', 'text/html', text('<script>x</script>')],
    ['x.svg', 'image/svg+xml', text('<svg/>')],
    ['x.docx', 'application/octet-stream', text('PK')],
    ['x.json', 'application/json', text('{broken')],
  ] as [string, string, Uint8Array][]) {
    assert.throws(() => check(name, mime, bytes))
  }
})
test('PDF仅允许签名及结束标记一致，purpose不能由客户端控制', () => {
  assert.equal(
    check('a.pdf', 'application/pdf', text('%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n')).purpose,
    'rich_layout_recognition'
  )
  assert.throws(() => check('a.pdf', 'application/pdf', text('not a PDF\n%%EOF')))
  assert.throws(() => check('a.pdf', 'text/plain', text('%PDF-1.7\n%%EOF')))
  assert.throws(() => check('a.pdf', 'application/pdf', text('%PDF-1.7\nno end')))
})
test('尺寸、文件名、字节数与大小上限拒绝伪装', () => {
  assert.throws(() => check('../x.txt', 'text/plain', text('ok')))
  assert.throws(() => check('x.txt', 'text/plain', new Uint8Array(MAX_ATTACHMENT_BYTES + 1)))
  assert.throws(() =>
    validateAttachment({ name: 'x.txt', type: 'text/plain', size: 1 }, text('xx'))
  )
  assert.throws(() => check('x.png', 'image/png', text('fake')))
})
test('实际1像素PNG/GIF与基本结构校验', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64'
  )
  assert.equal(check('x.png', 'image/png', png).isImage, true)
  const large = Buffer.from(png)
  large.writeUInt32BE(4097, 16)
  assert.throws(() => check('x.png', 'image/png', large))
  assert.throws(() => check('x.png', 'image/jpeg', png))
  assert.throws(() => check('x.png', 'image/png', png.subarray(0, -1)))
  const gif = Buffer.from(
    '47494638396101000100800000000000ffffff2c00000000010001000002024401003b',
    'hex'
  )
  assert.equal(check('x.gif', 'image/gif', gif).isImage, true)
  assert.throws(() => check('x.gif', 'image/gif', gif.subarray(0, -1)))
})

test('JPEG/WebP基础尺寸与容器长度检查，不等于完整解码', () => {
  const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex')
  assert.equal(check('x.jpg', 'image/jpeg', jpeg).isImage, true)
  const bad = Buffer.from(jpeg)
  bad.writeUInt16BE(4097, 7)
  assert.throws(() => check('x.jpg', 'image/jpeg', bad))
  assert.throws(() => check('x.jpg', 'image/jpeg', jpeg.subarray(0, -2)))
  const webp = Buffer.alloc(30)
  webp.write('RIFF', 0)
  webp.writeUInt32LE(22, 4)
  webp.write('WEBP', 8)
  webp.write('VP8 ', 12)
  webp.writeUInt32LE(10, 16)
  webp.set([0x9d, 1, 0x2a], 23)
  webp.writeUInt16LE(1, 26)
  webp.writeUInt16LE(1, 28)
  assert.equal(check('x.webp', 'image/webp', webp).isImage, true)
  const oversized = Buffer.from(webp)
  oversized.writeUInt16LE(4097, 26)
  assert.throws(() => check('x.webp', 'image/webp', oversized))
  assert.throws(() => check('x.webp', 'image/webp', webp.subarray(0, -1)))
})

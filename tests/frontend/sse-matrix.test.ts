import test from 'node:test'
import assert from 'node:assert/strict'
import { readServerSentEvents, ServerSentEventDecoder } from '../../src/services/api/sse.js'
import { readMessageEvent } from '../../src/services/api/parseEvent.js'
import { applyEvent, settleReply, canContinueReply } from '../../src/services/chat/reply.js'
import type { AssistantMessage } from '../../src/services/chat/types.js'
async function parse(text: string, size: number) {
  const bytes = new TextEncoder().encode(text)
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) {
        c.enqueue(bytes.slice(i, i + size))
      }
      c.close()
    },
  })
  const out = []
  for await (const event of readServerSentEvents(input)) {
    out.push(event)
  }
  return out
}
test('UTF8/BOM/CRLF每字节拆分与多行data组合一致', async () => {
  const text =
    '\ufeff: keep-alive\r\nid: abc\r\nevent: snapshot\r\ndata: 中文🙂\r\ndata: 第二行\r\n\r\n'
  for (let size = 1; size < 32; size++) {
    assert.deepEqual(await parse(text, size), [
      { event: 'snapshot', data: '中文🙂\n第二行', lastEventId: 'abc' },
    ])
  }
})
test('CR/LF、空data、无data事件、未知字段、非法id和不完整末尾', async () => {
  assert.deepEqual(
    await parse('id: a\r\rdata:\r\rid: bad\0id\nfoo: x\nevent: custom\ndata: ok\n\ndata: lost', 1),
    [
      { event: 'message', data: '', lastEventId: 'a' },
      { event: 'custom', data: 'ok', lastEventId: 'a' },
    ]
  )
  const d = new ServerSentEventDecoder()
  assert.deepEqual(d.push('data: x\r\r'), [])
  assert.equal(d.end()[0].data, 'x')
})
test('已中止信号立即拒绝；读取中止取消底层流', async () => {
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    async () => {
      for await (const event of readServerSentEvents(new ReadableStream(), aborted.signal)) {
        assert.fail(`已中止信号不应产生事件: ${event.event}`)
      }
    },
    { name: 'AbortError' }
  )
  let cancelled = false
  const controller = new AbortController()
  const input = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const iterator = readServerSentEvents(input, controller.signal)
  const pending = iterator.next()
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
})
test('未知协议事件忽略；签名分片累积、refusal清理、工具限制续写', () => {
  assert.equal(readMessageEvent({ type: 'future_event', payload: 'x' }), null)
  let reply: AssistantMessage = {
    id: 'a',
    role: 'assistant',
    createdAt: 1,
    model: 'deepseek-flash',
    prefix: true,
    status: 'pending',
    blocks: [],
  }
  const indexes = new Map<number, number>()
  const event = (value: unknown) => {
    const parsed = readMessageEvent(value)
    assert.ok(parsed)
    reply = applyEvent(reply, parsed, 10, indexes)
  }
  event({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '思考' },
  })
  for (const signature of ['one', 'two']) {
    event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } })
  }
  assert.equal((reply.blocks[0] as { signature: string }).signature, 'onetwo')
  event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '回答' } })
  event({
    type: 'content_block_start',
    index: 2,
    content_block: {
      type: 'server_tool_use',
      id: 't',
      name: 'deepseek_read_url',
      kind: 'read_link',
      input: { action: 'read_link', url: 'https://example.com' },
    },
  })
  assert.equal(canContinueReply({ ...reply, status: 'stopped' }), false)
  reply = { ...reply, stopReason: 'refusal' }
  const settled = settleReply(reply, 'done', 20)
  assert.deepEqual(
    settled.blocks.map((b) => b.type),
    ['server_tool_use']
  )
  assert.equal(canContinueReply(settled), false)
})
test('无换行巨行与多行巨事件受预算限制，正常快照可配置放宽', () => {
  const line = new ServerSentEventDecoder({ maxLineChars: 16, maxEventChars: 32 })
  assert.throws(() => line.push('data: ' + 'x'.repeat(17)), /单行/)
  const event = new ServerSentEventDecoder({ maxLineChars: 32, maxEventChars: 16 })
  assert.throws(() => event.push('data: 123456789\ndata: 123456789\n\n'), /事件/)
  const large = new ServerSentEventDecoder({ maxLineChars: 300000, maxEventChars: 300000 })
  assert.equal(large.push('data: ' + 'x'.repeat(220000) + '\n\n')[0].data.length, 220000)
})

import type { AssistantMessage, UserMessage } from '../../../src/services/chat/types.js'
import type {
  MessageStreamEvent,
  ServerToolUseBlock,
  WebFetchToolResultBlock,
} from '../../../src/services/api/types.js'
// Synthetic fixtures only: no real conversations, credentials or model calls.
export const question: UserMessage = {
  id: 'q',
  role: 'user',
  content: 'hello',
  files: [],
  createdAt: 1,
}
export const empty: AssistantMessage = {
  id: 'a',
  role: 'assistant',
  createdAt: 2,
  model: 'deepseek-flash',
  prefix: true,
  status: 'pending',
  blocks: [],
}
export const textEvents: MessageStreamEvent[] = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hello' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
  { type: 'content_block_stop', index: 0 },
]
export const thinkingEvents: MessageStreamEvent[] = [
  {
    type: 'content_block_start',
    index: 3,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  },
  { type: 'content_block_delta', index: 3, delta: { type: 'thinking_delta', thinking: 'reason' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'signature_delta', signature: 'sig-' } },
  {
    type: 'content_block_delta',
    index: 3,
    delta: { type: 'signature_delta', signature: 'fixture' },
  },
  { type: 'content_block_stop', index: 3 },
]
export const tool: ServerToolUseBlock = {
  type: 'server_tool_use',
  id: 'tool',
  name: 'deepseek_read_url',
  input: { action: 'read_link', url: 'https://example.com/' },
  caller: { type: 'direct' },
  kind: 'read_link',
}
export const result: WebFetchToolResultBlock = {
  type: 'web_fetch_tool_result',
  tool_use_id: 'tool',
  kind: 'read_link',
  signature: 'fixture-page-signature',
  content: {
    type: 'web_fetch_result',
    url: 'https://example.com/',
    published_at: null,
    content: {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: '' },
      title: 'Example',
    },
  },
}
export const expectedText = [{ type: 'text', text: 'Hello world', citations: [] }]
export const expectedThinking = [
  { type: 'thinking', thinking: 'reason', signature: 'sig-fixture', startedAt: 10, endedAt: 14 },
]

import test from 'node:test'
import assert from 'node:assert/strict'
import { safeExternalUrl } from '../../src/utils/safeExternalUrl.js'
test('外链只允许HTTP(S)，拒绝脚本/数据/凭据/混淆协议', () => {
  for (const input of [
    'javascript:alert(1)',
    'JavaScript://x',
    'data:text/html,<script>x</script>',
    'file:///tmp/a',
    'mailto:x@x.com',
    '//evil.test',
    'https://a:b@evil.test',
    'https:\n//evil.test',
    '\thttps://evil.test',
    'blob:https://x/x',
    'https://evil.test/\u0000',
  ]) {
    assert.equal(safeExternalUrl(input), undefined, input)
  }
  assert.equal(safeExternalUrl('HTTPS://example.com/path?q=1'), 'https://example.com/path?q=1')
  assert.equal(safeExternalUrl('http://example.com'), 'http://example.com/')
})

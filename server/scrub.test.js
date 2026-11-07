import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrubOutboundHtml } from './lib/sanitize.js'

test('nested script markup is neutralised', () => {
  const out = scrubOutboundHtml('<scr<script>ipt>alert(1)</scr</script>ipt>')
  assert.ok(!/<script/i.test(out), out)
})

test('img onerror variants lose the handler', () => {
  for (const h of ['<img src=x onerror=alert(1)>', '<img src="x"/onerror="alert(1)">', '<IMG SRC=x ONERROR=alert(1)>', '<img src=x\nonerror=alert(1)>']) {
    assert.ok(!/onerror/i.test(scrubOutboundHtml(h)), h)
  }
})

test('javascript: href with leading whitespace loses href', () => {
  const out = scrubOutboundHtml('<a href="  javascript:alert(1)">x</a>')
  assert.ok(!/href/i.test(out), out)
  assert.ok(!/javascript/i.test(out), out)
})

test('svg onload is removed', () => {
  const out = scrubOutboundHtml('<svg onload=alert(1)>')
  assert.ok(!/svg|onload/i.test(out), out)
})

test('plain markup is unchanged; links get rel', () => {
  assert.equal(scrubOutboundHtml('<p>hi</p>'), '<p>hi</p>')
  assert.match(scrubOutboundHtml('<a href="https://x.example/">x</a>'), /rel="noopener noreferrer"/)
})

test('non-string input passes through', () => {
  assert.equal(scrubOutboundHtml(''), '')
  assert.equal(scrubOutboundHtml(undefined), undefined)
})

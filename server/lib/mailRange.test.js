import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageRange } from './mailRange.js'

test('messageRange: empty mailbox (exists=0) is flagged empty so callers skip FETCH', () => {
  // The regression behind "Offline — showing cached messages" on an empty INBOX:
  // old code produced start=1, end=0 → an inverted "1:0" range the IMAP server
  // rejects with "Command failed". An empty mailbox must be short-circuited.
  const r = messageRange(0, 50, 0)
  assert.equal(r.empty, true)
})

test('messageRange: fewer messages than the limit returns the full folder', () => {
  const r = messageRange(10, 50, 0)
  assert.equal(r.empty, false)
  assert.equal(r.start, 1)
  assert.equal(r.end, 10)
})

test('messageRange: more messages than the limit returns the newest `limit`', () => {
  const r = messageRange(120, 50, 0)
  assert.equal(r.empty, false)
  // start = max(1, 120 - (50 + 0)) = 70 → "70:120"
  assert.equal(r.start, 70)
  assert.equal(r.end, 120)
})

test('messageRange: offset shifts the window back further', () => {
  const r = messageRange(120, 50, 30)
  assert.equal(r.empty, false)
  // start = max(1, 120 - (50 + 30)) = 40 → "40:120"
  assert.equal(r.start, 40)
  assert.equal(r.end, 120)
})

test('messageRange: single message folder is still fetched', () => {
  const r = messageRange(1, 50, 0)
  assert.equal(r.empty, false)
  assert.equal(r.start, 1)
  assert.equal(r.end, 1)
})

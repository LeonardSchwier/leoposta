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
  // Exactly 50: "71:120" (it used to be 70:120, one more than asked for).
  assert.equal(r.start, 71)
  assert.equal(r.end, 120)
})

test('messageRange: offset skips the newest messages already shown (load more)', () => {
  // It used to return 40:120 here: page 2 repeated all of page 1.
  const r = messageRange(120, 50, 30)
  assert.equal(r.empty, false)
  assert.equal(r.start, 41)
  assert.equal(r.end, 90)
})

test('messageRange: consecutive pages cover the folder once, without gaps or repeats', () => {
  const seen = []
  for (let offset = 0; ; offset += 50) {
    const r = messageRange(120, 50, offset)
    if (r.empty) break
    for (let i = r.end; i >= r.start; i--) seen.push(i)
  }
  assert.deepEqual(seen, Array.from({ length: 120 }, (_, i) => 120 - i))
})

test('messageRange: an offset past the oldest message is empty', () => {
  assert.equal(messageRange(120, 50, 120).empty, true)
  assert.equal(messageRange(120, 50, 200).empty, true)
})

test('messageRange: single message folder is still fetched', () => {
  const r = messageRange(1, 50, 0)
  assert.equal(r.empty, false)
  assert.equal(r.start, 1)
  assert.equal(r.end, 1)
})

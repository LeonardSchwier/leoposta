import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  safeRegexTest, resetSafeRegexForTests,
  MAX_PATTERN_LENGTH, MAX_INPUT_LENGTH, SLOW_MEMO_TTL_MS, WINDOW_MS
} from './safeRegex.js'

beforeEach(() => resetSafeRegexForTests())

// `(a+)+$` needs about 2^n steps on n 'a's followed by anything else. A distinct
// suffix makes each text a different message.
const evil = (suffix = '!') => 'a'.repeat(30) + suffix

test('safeRegexTest: matches case-insensitively, like the old inline RegExp(value, "i")', () => {
  assert.equal(safeRegexTest('invoice\\s+\\d+', 'Your INVOICE   42 is ready'), true)
  assert.equal(safeRegexTest('^receipt', 'Order receipt'), false)
})

test('safeRegexTest: an invalid or over-long pattern is a no-match, never a throw', () => {
  assert.equal(safeRegexTest('(', 'anything'), false)
  assert.equal(safeRegexTest('a'.repeat(MAX_PATTERN_LENGTH + 1), 'a'.repeat(MAX_PATTERN_LENGTH + 1)), false)
  assert.equal(safeRegexTest(undefined, 'x'), false)
  assert.equal(safeRegexTest(42, '42'), false)
})

test('safeRegexTest: tolerates a missing text', () => {
  assert.equal(safeRegexTest('^$', undefined), true)
  assert.equal(safeRegexTest('x', null), false)
})

test('safeRegexTest: a catastrophic pattern is cut off instead of blocking the event loop', (t) => {
  t.mock.method(console, 'warn', () => {})
  const started = Date.now()
  assert.equal(safeRegexTest('(a+)+$', evil()), false)
  // About 10 to 65 s on the old inline RegExp, doubling with every extra character.
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
})

test('safeRegexTest: a message that ran out of budget is skipped on repeat, other mail is not', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  assert.equal(safeRegexTest('(a+)+$', evil()), false)
  assert.equal(warn.mock.callCount(), 1)
  const started = Date.now()
  for (let i = 0; i < 50; i += 1) assert.equal(safeRegexTest('(a+)+$', evil()), false)
  assert.ok(Date.now() - started < 200, `50 repeats took ${Date.now() - started} ms`)
  assert.equal(warn.mock.callCount(), 1)
  // The same rule still works on ordinary mail: one crafted message must not
  // switch it off for everyone.
  assert.equal(safeRegexTest('(a+)+$', 'aaa'), true)
  assert.equal(safeRegexTest('(a+)+$', 'aaa!'), false)
})

test('safeRegexTest: the skip lapses after a few minutes', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  let now = 1_000_000
  resetSafeRegexForTests({ now: () => now })
  safeRegexTest('(a+)+$', evil())
  assert.equal(warn.mock.callCount(), 1)
  now += SLOW_MEMO_TTL_MS - 1
  safeRegexTest('(a+)+$', evil())
  assert.equal(warn.mock.callCount(), 1)
  now += 2
  safeRegexTest('(a+)+$', evil())
  assert.equal(warn.mock.callCount(), 2)
})

test('safeRegexTest: many slow-but-not-fatal matches share one CPU budget per window', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  let now = 5_000_000
  resetSafeRegexForTests({ now: () => now })
  // 40 different catastrophic messages: each would burn its whole 25 ms budget.
  const started = Date.now()
  for (let i = 0; i < 40; i += 1) assert.equal(safeRegexTest('(a+)+$', evil(String.fromCharCode(33 + i))), false)
  const took = Date.now() - started
  // Unbounded this is 40 x 25 ms = 1000 ms; the 250 ms window cap stops it near a quarter.
  assert.ok(took < 700, `took ${took} ms`)
  assert.ok(warn.mock.calls.some((c) => /skipping the rest of that window/.test(String(c.arguments[0]))))
  // The cap only lasts for its window: the next one starts fresh.
  now += WINDOW_MS
  assert.equal(safeRegexTest('invoice', 'an invoice'), true)
})

test('safeRegexTest: only the first MAX_INPUT_LENGTH characters are searched', () => {
  const filler = 'x'.repeat(MAX_INPUT_LENGTH)
  assert.equal(safeRegexTest('needle', filler + 'needle'), false)
  assert.equal(safeRegexTest('needle', 'needle' + filler), true)
})

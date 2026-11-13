import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageDate, normalizeFlags } from './address.js'

test('messageDate prefers the envelope date, then internalDate', () => {
  const env = new Date('2026-11-01T09:00:00Z')
  const internal = new Date('2026-11-02T10:00:00Z')
  assert.equal(messageDate({ envelope: { date: env }, internalDate: internal }), '2026-11-01T09:00:00.000Z')
  assert.equal(messageDate({ internalDate: internal }), '2026-11-02T10:00:00.000Z')
})

// ImapFlow's FetchMessageObject.flags is a Set<string> (lib/tools.js:
// `map.flags = new Set(...)`). Object.keys(new Set([...])) is [], so every
// message used to come out unread and unstarred whatever the server said.
test('normalizeFlags reads the Set that ImapFlow returns', () => {
  assert.deepEqual(normalizeFlags(new Set(['\\Seen', '\\Flagged', '$Work'])), ['\\Seen', '\\Flagged', '$Work'])
  assert.deepEqual(normalizeFlags(new Set()), [])
})

test('normalizeFlags still accepts an array and a flag-name object, and survives nothing', () => {
  assert.deepEqual(normalizeFlags(['\\Seen']), ['\\Seen'])
  assert.deepEqual(normalizeFlags({ '\\Seen': true, '\\Flagged': false }), ['\\Seen'])
  for (const none of [undefined, null, '', 0]) assert.deepEqual(normalizeFlags(none), [])
})

test('normalizeFlags returns a copy, so callers cannot change the Set through it', () => {
  const flags = new Set(['\\Seen'])
  normalizeFlags(flags).push('\\Flagged')
  assert.deepEqual([...flags], ['\\Seen'])
})

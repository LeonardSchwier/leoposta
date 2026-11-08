import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageDate } from './address.js'

test('messageDate prefers the envelope date, then internalDate', () => {
  const env = new Date('2026-11-01T09:00:00Z')
  const internal = new Date('2026-11-02T10:00:00Z')
  assert.equal(messageDate({ envelope: { date: env }, internalDate: internal }), '2026-11-01T09:00:00.000Z')
  assert.equal(messageDate({ internalDate: internal }), '2026-11-02T10:00:00.000Z')
})

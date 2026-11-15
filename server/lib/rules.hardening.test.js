import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchRule } from './rules.js'

const msg = { subject: 'Hello', fromAddress: 'a@example.com', from: 'A', to: ['b@example.com'], cc: [], body: 'text', folder: 'INBOX' }

test('matchRule: a catastrophic regex condition does not block and does not match', () => {
  const evil = { ...msg, subject: 'a'.repeat(30) + '!' }
  const started = Date.now()
  const rule = { conditions: [{ field: 'subject', operator: 'regex', value: '(a+)+$' }] }
  assert.equal(matchRule(evil, rule), false)
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
})

test('matchRule: a malformed rule matches nothing instead of throwing', () => {
  assert.equal(matchRule(msg, null), false)
  assert.equal(matchRule(msg, undefined), false)
  assert.equal(matchRule(msg, 'rule'), false)
  assert.equal(matchRule(msg, { conditions: [null] }), false)
  assert.equal(matchRule(msg, { conditions: ['x'] }), false)
  assert.equal(matchRule(msg, { conditions: 'abc' }), false)
})

test('matchRule: a non-string value is compared as text, not a TypeError', () => {
  assert.equal(matchRule({ ...msg, subject: 'Invoice 5' }, { conditions: [{ field: 'subject', operator: 'contains', value: 5 }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'contains', value: null }] }), true)
})

test('matchRule: an empty condition list still matches everything (documented in describeRule)', () => {
  assert.equal(matchRule(msg, { conditions: [] }), true)
  assert.equal(matchRule(msg, {}), true)
})

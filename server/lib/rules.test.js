import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchRule, applyRules } from './rules.js'

const msg = {
  id: '1',
  from: 'Alice',
  fromAddress: 'alice@example.com',
  to: ['me@example.com'],
  cc: [],
  subject: 'Urgent: Q3 Report',
  body: 'Please review the attached report',
  bodyHtml: '<p>Please review the attached report</p>',
  flags: [],
  folder: 'INBOX',
  labels: []
}

// --- matchRule ---

test('matchRule: contains from', () => {
  const rule = { conditions: [{ field: 'from', operator: 'contains', value: 'alice' }] }
  assert.equal(matchRule(msg, rule), true)
})

test('matchRule: contains from (case-insensitive)', () => {
  const rule = { conditions: [{ field: 'from', operator: 'contains', value: 'ALICE' }] }
  assert.equal(matchRule(msg, rule), true)
})

test('matchRule: contains from (no match)', () => {
  const rule = { conditions: [{ field: 'from', operator: 'contains', value: 'bob' }] }
  assert.equal(matchRule(msg, rule), false)
})

test('matchRule: equals subject (case-insensitive)', () => {
  const rule = { conditions: [{ field: 'subject', operator: 'equals', value: 'URGENT: Q3 REPORT' }] }
  assert.equal(matchRule(msg, rule), true)
})

test('matchRule: starts_with', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'starts_with', value: 'urgent' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'starts_with', value: 'q3' }] }), false)
})

test('matchRule: ends_with', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'ends_with', value: 'report' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'ends_with', value: 'urgent' }] }), false)
})

test('matchRule: regex', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'regex', value: '^Urgent.*Report$' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'regex', value: '^zzz$' }] }), false)
})

test('matchRule: invalid regex does not match', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'regex', value: '[broken' }] }), false)
})

test('matchRule: to field', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'to', operator: 'contains', value: 'me@example.com' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'to', operator: 'contains', value: 'other@example.com' }] }), false)
})

test('matchRule: body field', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'body', operator: 'contains', value: 'attached' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'body', operator: 'contains', value: 'not in body' }] }), false)
})

test('matchRule: multiple conditions (AND)', () => {
  const rule = { conditions: [
    { field: 'from', operator: 'contains', value: 'alice' },
    { field: 'subject', operator: 'contains', value: 'report' }
  ]}
  assert.equal(matchRule(msg, rule), true)
  const bad = { conditions: [
    { field: 'from', operator: 'contains', value: 'alice' },
    { field: 'subject', operator: 'contains', value: 'nonexistent' }
  ]}
  assert.equal(matchRule(msg, bad), false)
})

// --- applyRules ---

test('applyRules: no rules returns messages unchanged', () => {
  const out = applyRules([msg], [])
  assert.equal(out.length, 1)
  assert.equal(out[0].flags.length, 0)
})

test('applyRules: flag action', () => {
  const rules = [{ enabled: true, conditions: [{ field: 'from', operator: 'equals', value: 'alice@example.com' }], action: { type: 'flag' } }]
  const [out] = applyRules([{ ...msg }], rules)
  assert.ok(out.flags.includes('starred'), `flags: ${out.flags.join(',')}`)
})

test('applyRules: flag does not duplicate starred', () => {
  const m = { ...msg, flags: ['starred'] }
  const rules = [{ enabled: true, conditions: [], action: { type: 'flag' } }]
  const [out] = applyRules([m], rules)
  const count = out.flags.filter(f => f === 'starred').length
  assert.equal(count, 1)
})

test('applyRules: move action sets folder', () => {
  const rules = [{ enabled: true, conditions: [{ field: 'subject', operator: 'contains', value: 'urgent' }], action: { type: 'move', value: 'INBOX.Urgent' } }]
  const [out] = applyRules([{ ...msg }], rules)
  assert.equal(out.folder, 'INBOX.Urgent')
})

test('applyRules: label action adds label', () => {
  const rules = [{ enabled: true, conditions: [], action: { type: 'label', value: 'important' } }]
  const [out] = applyRules([{ ...msg }], rules)
  assert.ok(out.labels.includes('important'))
})

test('applyRules: disabled rules are skipped', () => {
  const rules = [{ enabled: false, conditions: [{ field: 'from', operator: 'contains', value: 'alice' }], action: { type: 'flag' } }]
  const [out] = applyRules([{ ...msg }], rules)
  assert.equal(out.flags.length, 0)
})

test('applyRules: only first matching rule applies per message', () => {
  const rules = [
    { enabled: true, conditions: [], action: { type: 'flag' } },
    { enabled: true, conditions: [], action: { type: 'move', value: 'Archive' } }
  ]
  const [out] = applyRules([{ ...msg }], rules)
  assert.ok(out.flags.includes('starred'))
  assert.equal(out.folder, 'INBOX')
})

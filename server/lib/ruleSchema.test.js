import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateRules, MAX_RULES, MAX_CONDITIONS } from './ruleSchema.js'

const good = () => ({
  id: 'r1',
  enabled: true,
  conditions: [{ field: 'from', operator: 'contains', value: 'boss@example.com' }],
  action: { type: 'move', value: 'Work' }
})

test('validateRules: accepts what the Rules tab sends and returns clean copies', () => {
  const input = [good(), { enabled: false, conditions: [], action: { type: 'flag' }, junk: { deep: [1, 2] } }]
  const r = validateRules(input)
  assert.equal(r.ok, true)
  assert.deepEqual(r.rules, [good(), { enabled: false, conditions: [], action: { type: 'flag' } }])
  assert.notEqual(r.rules[0], input[0])
})

test('validateRules: an empty value and a move without a folder stay allowed (the engine ignores them)', () => {
  const r = validateRules([{ enabled: true, conditions: [{ field: 'from', operator: 'contains', value: '' }], action: { type: 'move' } }])
  assert.equal(r.ok, true)
})

test('validateRules: rejects every malformed shape with a message that names the place', () => {
  const cases = [
    [null, /rules must be an array/],
    ['x', /rules must be an array/],
    [[null], /Rule 1/],
    [[[]], /Rule 1/],
    [[{ ...good(), conditions: 'abc' }], /Rule 1.*conditions/],
    [[{ ...good(), conditions: [null] }], /Rule 1, condition 1/],
    [[{ ...good(), conditions: [{ field: 'nope', operator: 'contains', value: 'x' }] }], /Rule 1, condition 1.*field/],
    [[{ ...good(), conditions: [{ field: 'from', operator: 'nope', value: 'x' }] }], /Rule 1, condition 1.*operator/],
    [[{ ...good(), conditions: [{ field: 'from', operator: 'contains', value: 5 }] }], /Rule 1, condition 1.*value/],
    [[{ ...good(), conditions: [{ field: 'from', operator: 'contains', value: 'x'.repeat(501) }] }], /Rule 1, condition 1.*value/],
    [[{ ...good(), conditions: [{ field: 'from', operator: 'regex', value: '(' }] }], /Rule 1, condition 1.*regular expression/],
    [[{ ...good(), conditions: [{ field: 'from', operator: 'regex', value: 'a'.repeat(257) }] }], /Rule 1, condition 1.*regular expression/],
    [[{ ...good(), action: null }], /Rule 1.*action/],
    [[{ ...good(), action: { type: 'delete' } }], /Rule 1.*action/],
    [[{ ...good(), action: { type: 'move', value: 7 } }], /Rule 1.*action/],
    [[good(), { ...good(), conditions: [{ field: 'from', operator: 'contains', value: true }] }], /Rule 2, condition 1.*value/]
  ]
  for (const [input, message] of cases) {
    const r = validateRules(input)
    assert.equal(r.ok, false, JSON.stringify(input))
    assert.match(r.error, message, JSON.stringify(input))
  }
})

test('validateRules: rules saved before this check do not block the whole list', () => {
  const legacy = [
    { id: 5, enabled: 1, conditions: [{ field: 'from', operator: 'contains' }], action: { type: 'flag', value: undefined } },
    { enabled: undefined, conditions: [{ field: 'subject', operator: 'regex', value: null }], action: { type: 'label', value: 'x' } }
  ]
  const r = validateRules(legacy)
  assert.equal(r.ok, true)
  assert.deepEqual(r.rules, [
    { enabled: true, conditions: [{ field: 'from', operator: 'contains', value: '' }], action: { type: 'flag' } },
    { enabled: false, conditions: [{ field: 'subject', operator: 'regex', value: '' }], action: { type: 'label', value: 'x' } }
  ])
})

test('validateRules: bounds the number of rules and conditions', () => {
  assert.equal(validateRules(Array.from({ length: MAX_RULES }, good)).ok, true)
  assert.match(validateRules(Array.from({ length: MAX_RULES + 1 }, good)).error, /at most/)
  const many = { ...good(), conditions: Array.from({ length: MAX_CONDITIONS + 1 }, () => good().conditions[0]) }
  assert.match(validateRules([many]).error, /Rule 1.*at most/)
})

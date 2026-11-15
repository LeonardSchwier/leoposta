// Validation for PUT /api/rules. The Rules tab sends
//   { id?, enabled, conditions: [{ field, operator, value }], action: { type, value? } }
// and the rule engine runs those on every message list. Anything else used to be
// stored as is and could make the next list request throw, so it is refused here
// with a message the Rules tab shows, and the stored copy is rebuilt from the
// known properties only.

import { isValidPattern, MAX_PATTERN_LENGTH } from './safeRegex.js'

export const FIELDS = ['from', 'to', 'cc', 'subject', 'body', 'folder']
export const OPERATORS = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'regex']
export const ACTIONS = ['flag', 'move', 'label']

export const MAX_RULES = 200
export const MAX_CONDITIONS = 20
export const MAX_VALUE_LENGTH = 500
const MAX_ACTION_VALUE_LENGTH = 200
const MAX_ID_LENGTH = 100

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const fail = (error) => ({ ok: false, error })

function validateCondition(c, where) {
  if (!isObject(c)) return fail(`${where} must be an object`)
  if (!FIELDS.includes(c.field)) return fail(`${where}: field must be one of ${FIELDS.join(', ')}`)
  if (!OPERATORS.includes(c.operator)) return fail(`${where}: operator must be one of ${OPERATORS.join(', ')}`)
  // A missing value reads as empty, as the Rules tab shows it.
  const value = c.value === undefined || c.value === null ? '' : c.value
  if (typeof value !== 'string') return fail(`${where}: value must be text`)
  if (c.operator === 'regex') {
    if (!isValidPattern(value)) {
      return fail(`${where}: the regular expression is not valid or is longer than ${MAX_PATTERN_LENGTH} characters`)
    }
  } else if (value.length > MAX_VALUE_LENGTH) {
    return fail(`${where}: value is longer than ${MAX_VALUE_LENGTH} characters`)
  }
  return { ok: true, condition: { field: c.field, operator: c.operator, value } }
}

function validateRule(rule, index) {
  const at = `Rule ${index + 1}`
  if (!isObject(rule)) return fail(`${at} must be an object`)
  // Rules saved before this check may carry an odd id or a missing flag; neither
  // is worth refusing the whole list for, so the id is kept only when it is short
  // text and `enabled` is read as a truth value (the engine does the same).
  const id = typeof rule.id === 'string' && rule.id.length <= MAX_ID_LENGTH ? rule.id : undefined
  if (!Array.isArray(rule.conditions)) return fail(`${at}: conditions must be a list`)
  if (rule.conditions.length > MAX_CONDITIONS) return fail(`${at}: at most ${MAX_CONDITIONS} conditions`)
  const conditions = []
  for (let i = 0; i < rule.conditions.length; i += 1) {
    const r = validateCondition(rule.conditions[i], `${at}, condition ${i + 1}`)
    if (!r.ok) return r
    conditions.push(r.condition)
  }
  const action = rule.action
  if (!isObject(action) || !ACTIONS.includes(action.type)) {
    return fail(`${at}: action.type must be one of ${ACTIONS.join(', ')}`)
  }
  if (action.value !== undefined && (typeof action.value !== 'string' || action.value.length > MAX_ACTION_VALUE_LENGTH)) {
    return fail(`${at}: action.value must be text of at most ${MAX_ACTION_VALUE_LENGTH} characters`)
  }
  const clean = { enabled: Boolean(rule.enabled), conditions, action: { type: action.type } }
  if (action.value !== undefined) clean.action.value = action.value
  return { ok: true, rule: id === undefined ? clean : { id, ...clean } }
}

/** { ok: true, rules } with clean copies, or { ok: false, error } with a message. */
export function validateRules(rules) {
  if (!Array.isArray(rules)) return fail('rules must be an array')
  if (rules.length > MAX_RULES) return fail(`at most ${MAX_RULES} rules`)
  const clean = []
  for (let i = 0; i < rules.length; i += 1) {
    const r = validateRule(rules[i], i)
    if (!r.ok) return r
    clean.push(r.rule)
  }
  return { ok: true, rules: clean }
}

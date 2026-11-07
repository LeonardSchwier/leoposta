export type RuleField = 'from' | 'to' | 'cc' | 'subject' | 'body' | 'folder'
export type RuleOperator =
  | 'contains' | 'not_contains' | 'equals' | 'not_equals'
  | 'starts_with' | 'ends_with' | 'regex'
export type RuleActionType = 'flag' | 'move' | 'label'

export interface RuleCondition {
  field: RuleField
  operator: RuleOperator
  value: string
}

export interface RuleAction {
  type: RuleActionType
  value?: string
}

export interface Rule {
  id?: string
  enabled: boolean
  conditions: RuleCondition[]
  action: RuleAction
}

export const RULE_FIELDS: { value: RuleField; label: string }[] = [
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To' },
  { value: 'cc', label: 'Cc' },
  { value: 'subject', label: 'Subject' },
  { value: 'body', label: 'Body' },
  { value: 'folder', label: 'Folder' }
]

export const RULE_OPERATORS: { value: RuleOperator; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'regex', label: 'matches regex' }
]

export const RULE_ACTIONS: { value: RuleActionType; label: string; needsValue: boolean }[] = [
  { value: 'flag', label: 'Flag message', needsValue: false },
  { value: 'move', label: 'Move to folder', needsValue: true },
  { value: 'label', label: 'Add label', needsValue: true }
]

export function describeRule(rule: Rule): string {
  const conds = rule.conditions.map(c => `${c.field} ${c.operator} "${c.value}"`).join(' AND ') || 'matches all'
  if (rule.action.type === 'flag') return `When ${conds} → flag`
  if (rule.action.type === 'move') return `When ${conds} → move to ${rule.action.value}`
  if (rule.action.type === 'label') return `When ${conds} → label "${rule.action.value}"`
  return `When ${conds}`
}

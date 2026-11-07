const FIELDS = ['from', 'to', 'cc', 'subject', 'body', 'folder']

function getField(msg, field) {
  switch (field) {
    case 'from': return msg.fromAddress || msg.from || ''
    case 'to': return (msg.to || []).join('; ')
    case 'cc': return (msg.cc || []).join('; ')
    case 'subject': return msg.subject || ''
    case 'body': return msg.body || ''
    case 'folder': return msg.folder || ''
    default: return ''
  }
}

export function matchRule(msg, rule) {
  for (const c of rule.conditions || []) {
    const actual = getField(msg, c.field).toLowerCase()
    const value = (c.value || '').toLowerCase()
    switch (c.operator) {
      case 'contains': if (!actual.includes(value)) return false; break
      case 'not_contains': if (actual.includes(value)) return false; break
      case 'equals': if (actual !== value) return false; break
      case 'not_equals': if (actual === value) return false; break
      case 'starts_with': if (!actual.startsWith(value)) return false; break
      case 'ends_with': if (!actual.endsWith(value)) return false; break
      case 'regex':
        try {
          if (!new RegExp(c.value, 'i').test(getField(msg, c.field))) return false
        } catch { return false }
        break
      default: return false
    }
  }
  return true
}

export function applyRules(messages, rules) {
  const enabled = (rules || []).filter(r => r.enabled)
  if (!enabled.length) return messages
  return messages.map(msg => {
    const m = { ...msg, flags: [...(msg.flags || [])], labels: [...(msg.labels || [])] }
    for (const rule of enabled) {
      if (!matchRule(m, rule)) continue
      const action = rule.action || {}
      if (action.type === 'flag') {
        if (!m.flags.includes('starred')) m.flags.push('starred')
      } else if (action.type === 'move' && action.value) {
        m.folder = action.value
      } else if (action.type === 'label' && action.value) {
        if (!m.labels.includes(action.value)) m.labels.push(action.value)
      }
      break
    }
    return m
  })
}

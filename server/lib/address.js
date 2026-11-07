// Pure helpers for IMAP address parsing / flag normalisation / date coercion.
// No side effects, no state — safe to import from anywhere.

export function normalizeFlags(flags) {
  if (Array.isArray(flags)) return flags
  if (flags && typeof flags === 'object') return Object.keys(flags).filter(k => flags[k])
  return []
}

// Parse a single address string → { name, address }
export function parseAddr(str) {
  if (!str) return { name: '', address: '' }
  const m = str.match(/^"([^"]*)"?\s*<([^>]+)>/i)
  if (m) return { name: m[1] || '', address: m[2].trim() }
  const plain = str.match(/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i)
  if (plain) return { name: '', address: str.trim() }
  const noBrk = str.match(/^(.*?)\s+([\w.+-]+@[\w.-]+\.[a-z]{2,})$/i)
  if (noBrk) return { name: noBrk[1].trim(), address: noBrk[2].trim() }
  if (str.includes('@')) return { name: '', address: str.trim() }
  return { name: str.trim(), address: '' }
}

// Parse ImapFlow's `from` field (object with name/address) or string.
export function parseFromAddr(fromField) {
  if (!fromField) return { name: '', address: '' }
  if (typeof fromField === 'string') return parseAddr(fromField)
  if (fromField.address) return { name: fromField.name || '', address: fromField.address }
  if (fromField[0]) return parseFromAddr(fromField[0])
  return { name: '', address: '' }
}

export function toISO(d) {
  if (!d) return new Date().toISOString()
  if (d instanceof Date && !isNaN(d.getTime())) return d.toISOString()
  const t = new Date(d).getTime()
  if (!isNaN(t)) return new Date(t).toISOString()
  return new Date().toISOString()
}

export function extractAddrs(field) {
  if (!field) return []
  if (typeof field === 'string') return [field]
  if (Array.isArray(field)) {
    return field.map(f => {
      if (typeof f === 'string') return f
      if (f.address) return f.address
      return f
    }).filter(Boolean)
  }
  if (field.address) return [field.address]
  return [field]
}

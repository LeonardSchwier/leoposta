// Minimal iCalendar (ICS) + vCard (VCF) helpers shared by Calendar/Contacts views.

export interface CalEvent {
  uid: string
  summary: string
  start: string // raw DTSTART value, e.g. 20261020T100000 / 20260101
  end?: string
  location: string
  description: string
  allDay?: boolean
  href?: string
  ics?: string
  attendees?: string[] // email addresses; emitted as ATTENDEE;CN=... mailto:addr
  rrule?: string // kept when an existing series is edited
}

function foldLine(line: string): string {
  // RFC5545 line folding at 75 octets (approx using chars)
  if (line.length <= 75) return line
  const out: string[] = []
  let cur = line.slice(0, 73)
  out.push(cur)
  let i = 73
  while (i < line.length) {
    out.push(' ' + line.slice(i, i + 72))
    i += 72
  }
  return out.join('\r\n')
}

function escIcs(v: string): string {
  return (v || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

export function eventToICS(ev: Omit<CalEvent, 'uid'>, uid: string): string {
  const start = (ev.start || '').replace(/[-:]/g, '').split('T')[0].split('.')[0]
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//leoposta//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
  ]
  if (start) lines.push(ev.allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${ev.start}`)
  if (ev.end) lines.push(ev.allDay ? `DTEND;VALUE=DATE:${ev.end.replace(/[-:]/g, '')}` : `DTEND:${ev.end}`)
  if (ev.summary) lines.push(`SUMMARY:${escIcs(ev.summary)}`)
  if (ev.location) lines.push(`LOCATION:${escIcs(ev.location)}`)
  if (ev.description) lines.push(`DESCRIPTION:${escIcs(ev.description)}`)
  if (ev.rrule && /^[A-Z0-9=;,:+-]+$/i.test(ev.rrule)) lines.push(`RRULE:${ev.rrule}`)
  if (ev.attendees && ev.attendees.length) {
    for (const rawAddr of ev.attendees) {
      const addr = (rawAddr || '').trim()
      if (!addr) continue
      const mailto = addr.toLowerCase().startsWith('mailto:') ? addr.slice(7) : addr
      const cn = mailto.split('@')[0] || mailto
      const cnEscaped = cn.replace(/;/g, '\\;').replace(/,/g, '\\,')
      lines.push(`ATTENDEE;CN=${cnEscaped};RSVP=TRUE:mailto:${mailto}`)
    }
  }
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.map(foldLine).join('\r\n')
}

export interface ContactInput {
  name?: string
  email?: string
  phone?: string
  org?: string
  notes?: string
  website?: string
  addressComponents?: { street?: string; locality?: string; region?: string; postalCode?: string; country?: string }
  uid?: string
}

export function contactToVCF(name: string, email: string, phone: string, org: string, uid?: string): string {
  return contactToVCFObj({ name, email, phone, org, uid })
}

/** vCard TEXT escaping (RFC 6350 §3.4): backslash, newline, comma, semicolon. */
function escVcf(v: string): string {
  return (v || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

/** Fold at 75 octets without splitting a UTF-8 character. */
function foldOctets(line: string): string {
  const enc = new TextEncoder()
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of line) {
    const b = enc.encode(ch).length
    const limit = out.length ? 74 : 75 // continuation lines start with a space
    if (curBytes + b > limit) { out.push(cur); cur = ''; curBytes = 0 }
    cur += ch
    curBytes += b
  }
  out.push(cur)
  return out.join('\r\n ')
}

/** Property name of an unfolded content line ("item1.EMAIL;TYPE=x:..." -> "EMAIL"). */
function propName(line: string): string {
  const m = /^(?:[A-Za-z0-9-]+\.)?([A-Za-z0-9-]+)[;:]/.exec(line)
  return m ? m[1].toUpperCase() : ''
}

/**
 * Build the vCard for the contact editor. With `base` (the card as stored on
 * the server) every property the editor does not show is kept: further
 * e-mail addresses and phone numbers, photos, birthdays, categories, the
 * vCard version. Only FN/N/ORG/NOTE/URL and the first EMAIL/TEL/ADR are
 * replaced by the edited values.
 */
export function contactToVCFObj(c: ContactInput, base?: string): string {
  const id = c.uid || 'leoposta-' + (globalThis.crypto?.randomUUID?.() ?? Date.now())
  const kept: string[] = []
  let version = '3.0'
  if (base) {
    const seen = new Set<string>()
    const lines = base.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')
    for (const line of lines) {
      const name = propName(line)
      if (!name || name === 'BEGIN' || name === 'END' || name === 'UID' || name === 'REV' || name === 'PRODID') continue
      if (name === 'VERSION') { version = line.slice(line.indexOf(':') + 1).trim() || version; continue }
      if (['FN', 'N', 'ORG', 'NOTE', 'URL'].includes(name)) continue
      if (['EMAIL', 'TEL', 'ADR'].includes(name) && !seen.has(name)) { seen.add(name); continue }
      kept.push(line)
    }
  }
  const name = (c.name || '').trim()
  const words = name.split(/\s+/).filter(Boolean)
  const family = words.length > 1 ? words[words.length - 1] : ''
  const given = words.length > 1 ? words.slice(0, -1).join(' ') : name
  const v4 = version.startsWith('4')
  const lines = ['BEGIN:VCARD', `VERSION:${version}`, `UID:${id}`, `FN:${escVcf(name)}`, `N:${escVcf(family)};${escVcf(given)};;;`]
  if (c.email) lines.push(v4 ? `EMAIL:${c.email.trim()}` : `EMAIL;TYPE=INTERNET:${c.email.trim()}`)
  if (c.phone) lines.push(v4 ? `TEL;TYPE=cell:${c.phone.trim()}` : `TEL;TYPE=CELL:${c.phone.trim()}`)
  if (c.org) lines.push(`ORG:${escVcf(c.org)}`)
  if (c.notes) lines.push(`NOTE:${escVcf(c.notes)}`)
  if (c.website) lines.push(`URL:${c.website.trim()}`)
  const ac = c.addressComponents
  if (ac && (ac.street || ac.locality || ac.region || ac.postalCode || ac.country)) {
    // pobox;extended;street;locality;region;postalCode;country
    const parts = ['', '', ac.street, ac.locality, ac.region, ac.postalCode, ac.country].map(x => escVcf(x || ''))
    lines.push(`ADR;TYPE=HOME:${parts.join(';')}`)
  }
  lines.push(...kept, 'END:VCARD')
  return lines.map(foldOctets).join('\r\n') + '\r\n'
}

// Parse a naive ICS (single VEVENT or many) into raw parts.
export function parseICSBlocks(ics: string): string[] {
  const norm = ics.replace(/\r\n/g, '\n').replace(/\\n/g, '\n')
  const blocks: string[] = []
  let cur: string[] | null = null
  for (const line of norm.split('\n')) {
    if (/^BEGIN:VEVENT/.test(line)) {
      if (cur) blocks.push(cur.join('\n'))
      cur = [line]
    } else if (/^END:VEVENT/.test(line)) {
      if (cur) { cur.push(line); blocks.push(cur.join('\n')); cur = null }
    } else if (cur) cur.push(line)
  }
  return blocks
}

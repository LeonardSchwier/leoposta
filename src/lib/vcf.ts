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

export function eventToICS(ev: CalEvent, uid: string): string {
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
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.map(foldLine).join('\r\n')
}

export function contactToVCF(name: string, email: string, phone: string, org: string, uid?: string): string {
  const id = uid || 'leoposta_' + Date.now()
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${id}`,
    `FN:${(name || '').replace(/,/g, '\\,')}`,
  ]
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${email}`)
  if (phone) lines.push(`TEL;TYPE=CELL:${phone}`)
  if (org) lines.push(`ORG:${org.replace(/;/g, '\\;')}`)
  lines.push('END:VCARD')
  return lines.map(foldLine).join('\r\n')
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

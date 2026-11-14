// Editing an existing event: change only what the editor shows in the event's
// own iCalendar object, so everything else survives — VTIMEZONE and TZID
// wall-clock times, RRULE / EXDATE, overridden occurrences (RECURRENCE-ID),
// alarms, categories, organizer. Rebuilding the object from the editor fields
// (eventToICS) dropped all of that, and editing one occurrence of a series
// moved the whole series to that occurrence's date.

export interface EventEdit {
  summary: string
  location: string
  description: string
  attendees?: string[]
  allDay: boolean
  /** The occurrence that was opened, as the server listed it ("YYYYMMDD" / "...THHMMSSZ"). */
  occurrenceStart: string
  /** New start/end for that occurrence, in the same formats (end exclusive for all-day). */
  start: string
  end: string
}

const DAY = 86_400_000

function escText(v: string): string {
  return (v || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
}

function fold(line: string): string {
  const enc = new TextEncoder()
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const b = enc.encode(ch).length
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0 }
    cur += ch
    bytes += b
  }
  out.push(cur)
  return out.join('\r\n ')
}

function splitProp(line: string): { name: string, params: string, value: string } {
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    else if (ch === ':' && !inQuote) {
      const head = line.slice(0, i)
      const semi = head.indexOf(';')
      return { name: (semi === -1 ? head : head.slice(0, semi)).toUpperCase(), params: semi === -1 ? '' : head.slice(semi), value: line.slice(i + 1) }
    }
  }
  return { name: '', params: '', value: '' }
}

interface TimeVal { kind: 'date' | 'utc' | 'local', ms: number }

/** Value -> ms. 'local' (TZID or floating) is wall-clock time counted as if UTC. */
function parseTime(value: string, params: string): TimeVal | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
  if (!m[4] || /VALUE=DATE(?!-)/i.test(params)) return { kind: 'date', ms }
  return { kind: m[7] ? 'utc' : 'local', ms }
}

function formatTime(t: TimeVal): string {
  const d = new Date(t.ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
  if (t.kind === 'date') return date
  return `${date}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${t.kind === 'utc' ? 'Z' : ''}`
}

/** Absolute ms of a value the server sent (all-day: local midnight). */
function serverValueMs(v: string): number | null {
  const t = parseTime(v, '')
  if (!t) return null
  if (t.kind === 'date') { const d = new Date(t.ms); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime() }
  if (t.kind === 'utc') return t.ms
  const d = new Date(t.ms)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime()
}

/**
 * Apply `edit` to the master VEVENT of `uid` in `ics`. Returns null when the
 * object has no such VEVENT (the caller then builds a fresh one).
 */
export function patchEventICS(ics: string, uid: string, edit: EventEdit): string | null {
  const lines = ics.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  // Locate the master VEVENT (no RECURRENCE-ID) for this UID.
  let begin = -1, end = -1
  for (let i = 0; i < lines.length && end === -1; i++) {
    if (!/^BEGIN:VEVENT$/i.test(lines[i].trim())) continue
    let depth = 0, j = i + 1, isUid = false, isOverride = false
    for (; j < lines.length; j++) {
      const l = lines[j].trim()
      if (/^BEGIN:/i.test(l)) depth++
      else if (/^END:VEVENT$/i.test(l) && depth === 0) break
      else if (/^END:/i.test(l)) depth--
      else if (depth === 0) {
        const p = splitProp(l)
        if (p.name === 'UID' && p.value.trim() === uid) isUid = true
        if (p.name === 'RECURRENCE-ID') isOverride = true
      }
    }
    if (isUid && !isOverride) { begin = i; end = j } else i = j
  }
  if (begin === -1 || end === -1) return null

  const body = lines.slice(begin + 1, end)
  let dtstart: { params: string, t: TimeVal } | null = null
  let dtend: TimeVal | null = null
  let duration = false
  let sequence = 0
  {
    let depth = 0
    for (const l of body) {
      if (/^BEGIN:/i.test(l)) { depth++; continue }
      if (/^END:/i.test(l)) { depth--; continue }
      if (depth) continue
      const p = splitProp(l)
      if (p.name === 'DTSTART') { const t = parseTime(p.value, p.params); if (t) dtstart = { params: p.params, t } }
      if (p.name === 'DTEND') dtend = parseTime(p.value, p.params)
      if (p.name === 'DURATION') duration = true
      if (p.name === 'SEQUENCE') sequence = parseInt(p.value, 10) || 0
    }
  }

  const newStartMs = serverValueMs(edit.start)
  const newEndMs = serverValueMs(edit.end)
  const occMs = serverValueMs(edit.occurrenceStart)
  if (newStartMs === null || newEndMs === null) return null

  // New DTSTART/DTEND lines.
  let timeLines: string[]
  const wasAllDay = dtstart?.t.kind === 'date'
  if (dtstart && occMs !== null && wasAllDay === edit.allDay) {
    // Same kind: shift the series start by how far this occurrence moved,
    // keep the value type and its TZID.
    const delta = newStartMs - occMs
    const dur = newEndMs - newStartMs
    const shift = (t: TimeVal, by: number): TimeVal => ({ kind: t.kind, ms: t.kind === 'date' ? t.ms + Math.round(by / DAY) * DAY : t.ms + by })
    const s = shift(dtstart.t, delta)
    const unchangedEnd = delta === 0 && dtend && (dtend.ms - dtstart.t.ms) === (edit.allDay ? Math.round(dur / DAY) * DAY : dur)
    const e = unchangedEnd && dtend ? dtend : shift(s, dur)
    const params = dtstart.params
    timeLines = [`DTSTART${params}:${formatTime(s)}`]
    if (dtend || duration || dur > 0 || edit.allDay) timeLines.push(`DTEND${params}:${formatTime(e)}`)
  } else {
    // All-day <-> timed: write the editor's values.
    timeLines = edit.allDay
      ? [`DTSTART;VALUE=DATE:${edit.start}`, `DTEND;VALUE=DATE:${edit.end}`]
      : [`DTSTART:${edit.start}`, `DTEND:${edit.end}`]
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const replaced = new Set(['DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'ATTENDEE', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE'])
  const kept: string[] = []
  let depth = 0
  for (const l of body) {
    if (/^BEGIN:/i.test(l)) { depth++; kept.push(l); continue }
    if (/^END:/i.test(l)) { depth--; kept.push(l); continue }
    if (depth === 0 && replaced.has(splitProp(l).name)) continue
    kept.push(l)
  }
  // Attendee lines of the original are kept as written (PARTSTAT, CN) when the address stays.
  const origAttendees = new Map<string, string>()
  for (const l of body) {
    const p = splitProp(l)
    if (p.name === 'ATTENDEE') origAttendees.set(p.value.replace(/^mailto:/i, '').trim().toLowerCase(), l)
  }
  const props = [
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SEQUENCE:${sequence + 1}`,
    ...timeLines,
    edit.summary ? `SUMMARY:${escText(edit.summary)}` : null,
    edit.location ? `LOCATION:${escText(edit.location)}` : null,
    edit.description ? `DESCRIPTION:${escText(edit.description)}` : null,
    ...(edit.attendees || []).map((a) => {
      const addr = a.trim().replace(/^mailto:/i, '')
      return origAttendees.get(addr.toLowerCase()) ?? `ATTENDEE;CN=${escText(addr.split('@')[0])};RSVP=TRUE:mailto:${addr}`
    })
  ].filter((x): x is string => !!x)

  // Insert the edited properties before the first nested component (VALARM).
  const firstNested = kept.findIndex((l) => /^BEGIN:/i.test(l))
  const at = firstNested === -1 ? kept.length : firstNested
  const newBody = [...kept.slice(0, at), ...props, ...kept.slice(at)]
  const out = [...lines.slice(0, begin + 1), ...newBody, ...lines.slice(end)].filter((l) => l.trim() !== '')
  return out.map(fold).join('\r\n') + '\r\n'
}

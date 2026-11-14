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
  /**
   * The repeat rule: undefined keeps the event's RRULE as it is, a string
   * replaces it, null removes it — with its EXDATE/RDATE and the overridden
   * occurrences (RECURRENCE-ID), which only make sense inside a series.
   */
  rrule?: string | null
  /**
   * The browser's zone. A timed event that becomes a series while its start
   * is a UTC instant is rewritten to DTSTART;TZID=<zone> (plus VTIMEZONE), so
   * it repeats at the same local time across DST and BYDAY means local weekdays.
   */
  zone?: string
}

import { buildVTimezone, isKnownZone, utcToWall, wallToIcs } from './tz'

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

function unfold(ics: string): string[] {
  return ics.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')
}

/** Line ranges [begin, end] (BEGIN:VEVENT .. END:VEVENT) of each top-level VEVENT of `uid`. */
function eventBlocks(lines: string[], uid: string): { begin: number, end: number, override: boolean }[] {
  const out: { begin: number, end: number, override: boolean }[] = []
  for (let i = 0; i < lines.length; i++) {
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
    if (isUid && j < lines.length) out.push({ begin: i, end: j, override: isOverride })
    i = j
  }
  return out
}

/** The master VEVENT (no RECURRENCE-ID) of `uid`. */
function findMaster(lines: string[], uid: string): { begin: number, end: number } | null {
  return eventBlocks(lines, uid).find(b => !b.override) ?? null
}

/** Top-level properties of a VEVENT body (nested VALARM skipped). */
function topProps(body: string[]): { name: string, params: string, value: string }[] {
  const out = []
  let depth = 0
  for (const l of body) {
    if (/^BEGIN:/i.test(l)) { depth++; continue }
    if (/^END:/i.test(l)) { depth--; continue }
    if (!depth) out.push(splitProp(l))
  }
  return out
}

function tzidOf(params: string): string | null {
  const m = /;TZID=("?)([^";:]+)\1/i.exec(params)
  return m ? m[2].replace(/^\//, '') : null
}

/**
 * How the master's DTSTART is written: all-day (DATE), UTC, TZID or floating.
 * `zone` is where its dates are read (TZID; UTC -> the browser's zone).
 */
export function masterStartInfo(ics: string, uid: string): { kind: 'date' | 'utc' | 'local', tzid: string | null } | null {
  const lines = unfold(ics)
  const m = findMaster(lines, uid)
  if (!m) return null
  const p = topProps(lines.slice(m.begin + 1, m.end)).find(x => x.name === 'DTSTART')
  const t = p && parseTime(p.value, p.params)
  if (!p || !t) return null
  return { kind: t.kind, tzid: t.kind === 'local' ? tzidOf(p.params) : null }
}

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/**
 * A weekly series whose DTSTART falls on a day its BYDAY does not list is
 * ambiguous (RFC 5545 counts DTSTART as an occurrence, most servers do not).
 * Returns that DTSTART weekday ("MO") then, else null.
 */
export function weeklyStartMismatch(ics: string, uid: string): string | null {
  const lines = unfold(ics)
  const m = findMaster(lines, uid)
  if (!m) return null
  const props = topProps(lines.slice(m.begin + 1, m.end))
  const rrule = props.find(x => x.name === 'RRULE')?.value.toUpperCase() || ''
  const ds = props.find(x => x.name === 'DTSTART')
  if (!/(^|;)FREQ=WEEKLY(;|$)/.test(rrule) || !ds) return null
  const by = /(?:^|;)BYDAY=([^;]+)/.exec(rrule)
  const dm = /^(\d{4})(\d{2})(\d{2})/.exec(ds.value.trim())
  if (!by || !dm) return null
  const wd = WD[new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3])).getUTCDay()]
  return by[1].split(',').some(d => d.trim().replace(/^[+-]?\d+/, '') === wd) ? null : wd
}

/**
 * Apply `edit` to the master VEVENT of `uid` in `ics`. Returns null when the
 * object has no such VEVENT (the caller then builds a fresh one).
 */
export function patchEventICS(ics: string, uid: string, edit: EventEdit): string | null {
  const lines = unfold(ics)
  const found = findMaster(lines, uid)
  if (!found) return null
  const { begin, end } = found

  const body = lines.slice(begin + 1, end)
  let dtstart: { params: string, t: TimeVal } | null = null
  let dtend: TimeVal | null = null
  let duration = false
  let sequence = 0
  let hadRule = false
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
      if (p.name === 'RRULE') hadRule = true
    }
  }

  const newStartMs = serverValueMs(edit.start)
  const newEndMs = serverValueMs(edit.end)
  const occMs = serverValueMs(edit.occurrenceStart)
  if (newStartMs === null || newEndMs === null) return null

  const removeRule = edit.rrule === null
  const willHaveRule = edit.rrule === undefined ? hadRule : !!edit.rrule
  const zone = isKnownZone(edit.zone) ? edit.zone : null
  const wasAllDay = dtstart?.t.kind === 'date'
  // A timed series must repeat in local time: a UTC (or all-day) start that
  // becomes a timed series is written in the browser's zone. An existing
  // series keeps its form (its EXDATEs and overrides are written in it).
  const toZone = !!zone && willHaveRule && !edit.allDay &&
    ((!hadRule && (!dtstart || dtstart.t.kind === 'utc' || wasAllDay)) || (hadRule && wasAllDay))

  // New DTSTART/DTEND lines.
  let timeLines: string[]
  const dur = newEndMs - newStartMs
  if (toZone && zone) {
    timeLines = [`DTSTART;TZID=${zone}:${wallToIcs(utcToWall(newStartMs, zone))}`, `DTEND;TZID=${zone}:${wallToIcs(utcToWall(newEndMs, zone))}`]
  } else if (removeRule && hadRule && dtstart && wasAllDay === edit.allDay) {
    // A series turned into a single event: it is the occurrence the editor
    // shows, at the time the editor shows, in the start's own form.
    const ds = dtstart
    const at = (abs: number, server: string): TimeVal => {
      if (ds.t.kind === 'date') return parseTime(server, '') ?? { kind: 'date', ms: abs }
      if (ds.t.kind === 'utc') return { kind: 'utc', ms: abs }
      const tz = tzidOf(ds.params)
      if (isKnownZone(tz)) { const w = utcToWall(abs, tz); return { kind: 'local', ms: Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) } }
      const d = new Date(abs)
      return { kind: 'local', ms: Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) }
    }
    timeLines = [`DTSTART${ds.params}:${formatTime(at(newStartMs, edit.start))}`]
    if (dtend || duration || dur > 0 || edit.allDay) timeLines.push(`DTEND${ds.params}:${formatTime(at(newEndMs, edit.end))}`)
  } else if (dtstart && occMs !== null && wasAllDay === edit.allDay) {
    // Same kind: shift the series start by how far this occurrence moved,
    // keep the value type and its TZID.
    const delta = newStartMs - occMs
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
  if (edit.rrule !== undefined) replaced.add('RRULE')
  if (removeRule) { replaced.add('EXDATE'); replaced.add('RDATE') }
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
    edit.rrule ? `RRULE:${edit.rrule}` : null,
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
  let out = [...lines.slice(0, begin + 1), ...newBody, ...lines.slice(end)]
  if (removeRule) {
    // Overridden occurrences of a series that no longer exists go with it.
    const drop = eventBlocks(out, uid).filter(b => b.override)
    for (const b of drop.reverse()) out.splice(b.begin, b.end - b.begin + 1)
  }
  if (toZone && zone && !hasVTimezone(out, zone)) {
    const firstEvent = out.findIndex(l => /^BEGIN:VEVENT$/i.test(l.trim()))
    out.splice(firstEvent, 0, ...buildVTimezone(zone, new Date(newStartMs).getUTCFullYear()))
  }
  out = out.filter((l) => l.trim() !== '')
  return out.map(fold).join('\r\n') + '\r\n'
}

function hasVTimezone(lines: string[], tz: string): boolean {
  let inTz = false
  for (const l of lines) {
    const t = l.trim()
    if (/^BEGIN:VTIMEZONE$/i.test(t)) inTz = true
    else if (/^END:VTIMEZONE$/i.test(t)) inTz = false
    else if (inTz) { const p = splitProp(t); if (p.name === 'TZID' && p.value.trim().replace(/^\//, '') === tz) return true }
  }
  return false
}

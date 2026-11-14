// The event editor's "Repeat" control <-> an RFC 5545 RRULE value.
//
// The control expresses: never / daily / weekly on some weekdays / monthly on
// the start's day of month / yearly on the start's date, every N periods,
// ending never / after N occurrences (COUNT) / on a date (UNTIL). A rule it
// cannot express (BYSETPOS, ordinal BYDAY, several BY* parts, ...) parses as
// "custom": the editor shows it read-only and leaves it untouched.

import { utcToWall, wallToUtc, utcToIcs, browserZone, isKnownZone } from './tz'

export type Freq = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
export type RepeatEnd = 'never' | 'count' | 'until'

export interface Repeat {
  freq: Freq
  interval: number
  /** WEEKLY only. */
  byDay: Weekday[]
  end: RepeatEnd
  count: number
  /** "YYYY-MM-DD", the last day an occurrence may start on. */
  until: string
}

export type ParsedRule =
  | { kind: 'none' }
  | { kind: 'simple', repeat: Repeat }
  | { kind: 'custom', rrule: string }

/**
 * How dates of the rule are read and written: all-day (DATE), or the zone of
 * the event's DTSTART (TZID or UTC: an IANA name; UNTIL is then written in
 * UTC) or null for a floating DTSTART (UNTIL floating too, RFC 5545 §3.3.10).
 */
export interface RuleContext { allDay: boolean, zone: string | null }

/** Weekday of a "YYYY-MM-DD" date. */
export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number)
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + months, Math.min(d, 28)))
  return t.toISOString().slice(0, 10)
}

/** The control's state for a non-repeating event starting on `startDate`. */
export function defaultRepeat(startDate: string): Repeat {
  return { freq: 'NONE', interval: 1, byDay: startDate ? [weekdayOf(startDate)] : ['MO'], end: 'never', count: 10, until: startDate ? addMonths(startDate, 3) : '' }
}

const SIMPLE_KEYS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'])

function zoneOf(ctx: RuleContext): string {
  return ctx.zone && isKnownZone(ctx.zone) ? ctx.zone : browserZone()
}

function untilToDate(v: string, ctx: RuleContext): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v)
  if (!m) return null
  if (m[7]) {
    const w = utcToWall(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), zoneOf(ctx))
    return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`
  }
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** Read an RRULE value into the control's state (`startDate`: the event's start, "YYYY-MM-DD"). */
export function parseRRule(rrule: string | null | undefined, startDate: string, ctx: RuleContext): ParsedRule {
  const raw = String(rrule || '').trim().replace(/^RRULE:/i, '')
  if (!raw) return { kind: 'none' }
  const custom: ParsedRule = { kind: 'custom', rrule: raw }
  const parts = new Map<string, string>()
  for (const kv of raw.split(';')) {
    if (!kv) continue
    const eq = kv.indexOf('=')
    if (eq < 1) return custom
    const k = kv.slice(0, eq).trim().toUpperCase()
    if (parts.has(k) || !SIMPLE_KEYS.has(k)) return custom
    parts.set(k, kv.slice(eq + 1).trim().toUpperCase())
  }
  const freq = parts.get('FREQ') as Freq | undefined
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return custom
  const repeat = defaultRepeat(startDate)
  repeat.freq = freq
  if (parts.has('INTERVAL')) {
    const n = Number(parts.get('INTERVAL'))
    if (!Number.isInteger(n) || n < 1) return custom
    repeat.interval = n
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) return custom
  if (parts.has('COUNT')) {
    const n = Number(parts.get('COUNT'))
    if (!Number.isInteger(n) || n < 1) return custom
    repeat.end = 'count'
    repeat.count = n
  }
  if (parts.has('UNTIL')) {
    const d = untilToDate(parts.get('UNTIL')!, ctx)
    if (!d) return custom
    repeat.end = 'until'
    repeat.until = d
  }
  // WKST only changes the meaning of a weekly rule with an interval > 1.
  if (parts.has('WKST') && parts.get('WKST') !== 'MO' && freq === 'WEEKLY' && repeat.interval > 1) return custom
  const [, sm, sd] = (startDate || '0-0-0').split('-').map(Number)
  if (parts.has('BYDAY')) {
    if (freq !== 'WEEKLY') return custom
    const days = parts.get('BYDAY')!.split(',')
    if (!days.every((d): d is Weekday => (WEEKDAYS as string[]).includes(d)) || new Set(days).size !== days.length) return custom
    repeat.byDay = WEEKDAYS.filter(d => days.includes(d))
  }
  if (parts.has('BYMONTHDAY')) {
    if ((freq !== 'MONTHLY' && freq !== 'YEARLY') || Number(parts.get('BYMONTHDAY')) !== sd || !/^\d+$/.test(parts.get('BYMONTHDAY')!)) return custom
  }
  if (parts.has('BYMONTH')) {
    if (freq !== 'YEARLY' || Number(parts.get('BYMONTH')) !== sm || !/^\d+$/.test(parts.get('BYMONTH')!)) return custom
  }
  return { kind: 'simple', repeat }
}

/** The RRULE value for the control's state; null for "Never". */
export function buildRRule(r: Repeat, ctx: RuleContext): string | null {
  if (r.freq === 'NONE') return null
  const parts = [`FREQ=${r.freq}`]
  if (r.interval > 1) parts.push(`INTERVAL=${Math.floor(r.interval)}`)
  if (r.freq === 'WEEKLY' && r.byDay.length) parts.push(`BYDAY=${WEEKDAYS.filter(d => r.byDay.includes(d)).join(',')}`)
  if (r.end === 'count') parts.push(`COUNT=${Math.floor(r.count)}`)
  if (r.end === 'until' && r.until) {
    const [y, mo, d] = r.until.split('-').map(Number)
    const date = r.until.replace(/-/g, '')
    if (ctx.allDay) parts.push(`UNTIL=${date}`)
    else if (ctx.zone === null) parts.push(`UNTIL=${date}T235959`)
    // The end of that day in the event's zone, as UTC (required with TZID / UTC DTSTART).
    else parts.push(`UNTIL=${utcToIcs(wallToUtc({ y, mo, d, h: 23, mi: 59, s: 59 }, zoneOf(ctx)))}`)
  }
  return parts.join(';')
}

/** A message when the control's state cannot be saved, else null. */
export function repeatProblem(r: Repeat, startDate: string): string | null {
  if (r.freq === 'NONE') return null
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 999) return 'Repeat every: enter a number from 1 to 999'
  if (r.freq === 'WEEKLY' && !r.byDay.length) return 'Pick at least one weekday to repeat on'
  if (r.end === 'count' && (!Number.isInteger(r.count) || r.count < 1 || r.count > 9999)) return 'Number of occurrences: enter a number from 1 to 9999'
  if (r.end === 'until') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.until)) return 'Pick the date the repeat ends'
    if (startDate && r.until < startDate) return 'The repeat ends before the event starts'
  }
  return null
}

const DAY_NAMES: Record<Weekday, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }
export function weekdayName(d: Weekday): string { return DAY_NAMES[d] }

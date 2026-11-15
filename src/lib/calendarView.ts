// Date handling for the Calendar view. The server sends event times as
//   "YYYYMMDD"            all-day (a date, no zone)
//   "YYYYMMDDTHHMMSSZ"    an instant (UTC, or a TZID already converted to UTC)
//   "YYYYMMDDTHHMMSS"     floating local time
// and these helpers place them in the browser's local time zone.

export interface CalEventLike {
  start: string
  end?: string
  allDay?: boolean
}

function pad(n: number): string { return String(n).padStart(2, '0') }

export function fmtISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Parse one server value to a local Date; null when unreadable. */
export function icsToDate(v: string | undefined): Date | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2})?(Z)?)?$/.exec(String(v || '').trim())
  if (!m) return null
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]]
  if (!m[4]) return new Date(y, mo, d)
  const [h, mi, s] = [+m[4], +m[5], +(m[6] || 0)]
  return m[7] ? new Date(Date.UTC(y, mo, d, h, mi, s)) : new Date(y, mo, d, h, mi, s)
}

export function isAllDay(ev: CalEventLike): boolean {
  if (typeof ev.allDay === 'boolean') return ev.allDay
  return /^\d{8}$/.test(String(ev.start || '').replace(/-/g, ''))
}

/** [start, end) of an event in local time. A missing end: one day (all-day) or the start. */
export function eventRange(ev: CalEventLike): { start: Date, end: Date } | null {
  const start = icsToDate(ev.start)
  if (!start) return null
  let end = icsToDate(ev.end)
  if (!end || end < start) end = isAllDay(ev) ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) : start
  return { start, end }
}

/** Does the event cover (any part of) local day `dateStr` (YYYY-MM-DD)? */
export function eventOnDay(ev: CalEventLike, dateStr: string): boolean {
  const r = eventRange(ev)
  if (!r) return false
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dayStart = new Date(y, mo - 1, d)
  const dayEnd = new Date(y, mo - 1, d + 1)
  if (r.end.getTime() === r.start.getTime()) return r.start >= dayStart && r.start < dayEnd
  return r.start < dayEnd && r.end > dayStart
}

/** "09:30" for a timed event (local), '' for all-day. */
export function timeLabel(ev: CalEventLike): string {
  if (isAllDay(ev)) return ''
  const d = icsToDate(ev.start)
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''
}

/** Local date ("YYYY-MM-DD") and time ("HH:MM") of a server value, for the editor. */
export function icsToLocalParts(v: string | undefined): { date: string, time: string } {
  const d = icsToDate(v)
  if (!d) return { date: '', time: '' }
  const allDay = /^\d{8}$/.test(String(v || '').replace(/-/g, ''))
  return { date: fmtISODate(d), time: allDay ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

/** Local date + time from the editor → UTC "YYYYMMDDTHHMMSSZ" (unambiguous in any zone). */
export function localToIcsUtc(date: string, time: string): string {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = (time || '00:00').split(':').map(Number)
  const t = new Date(y, mo - 1, d, h || 0, mi || 0, 0)
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00Z`
}

/** "YYYY-MM-DD" → "YYYYMMDD"; `plusDays` for an exclusive all-day DTEND. */
export function dateToIcsDate(date: string, plusDays = 0): string {
  const [y, mo, d] = date.split('-').map(Number)
  const t = new Date(y, mo - 1, d + plusDays)
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`
}

/** The 7 days (Monday first) of the week containing `d`. */
export function weekDays(d: Date): Date[] {
  const offset = (d.getDay() + 6) % 7
  return Array.from({ length: 7 }, (_, i) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset + i))
}

/** Monday-first 6x7 month grid around `viewDate`. */
export function monthGrid(viewDate: Date): { dateStr: string, inMonth: boolean, date: Date }[] {
  const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  const cells = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1 - offset + i)
    cells.push({ dateStr: fmtISODate(d), inMonth: d.getMonth() === viewDate.getMonth(), date: d })
  }
  return cells
}

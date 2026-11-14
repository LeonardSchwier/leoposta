// Time-zone helpers for writing recurring events. A series must repeat in
// the user's wall-clock time (09:00 every Monday, also after the switch to
// summer time) and its BYDAY must mean the user's weekday, so a new series is
// written as DTSTART;TZID=<zone>:<wall clock> with a VTIMEZONE built from
// the browser's own zone rules (Intl), not as a UTC instant.

export interface Wall { y: number, mo: number, d: number, h: number, mi: number, s: number }

const DAY = 86_400_000
const fmts = new Map<string, Intl.DateTimeFormat>()

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
    fmts.set(tz, f)
  }
  return f
}

/** True when Intl knows the zone name. */
export function isKnownZone(tz: string | null | undefined): tz is string {
  if (!tz) return false
  try { fmt(tz); return true } catch { return false }
}

/** The browser's IANA zone ("Europe/Berlin"); "UTC" when it has none. */
export function browserZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isKnownZone(z) ? z : 'UTC'
  } catch { return 'UTC' }
}

/** Wall-clock time in `tz` of a UTC instant. */
export function utcToWall(utcMs: number, tz: string): Wall {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second }
}

/** Offset of `tz` from UTC at an instant, in ms (Berlin in winter: +3600000). */
export function zoneOffsetMs(tz: string, utcMs: number): number {
  const w = utcToWall(utcMs, tz)
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000
}

/** UTC instant of a wall-clock time in `tz` (a time skipped by DST maps forward). */
export function wallToUtc(w: Wall, tz: string): number {
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  const o1 = zoneOffsetMs(tz, naive)
  const o2 = zoneOffsetMs(tz, naive - o1)
  return naive - o2
}

const p2 = (n: number) => String(n).padStart(2, '0')

export function wallDate(w: Wall): string { return `${String(w.y).padStart(4, '0')}${p2(w.mo)}${p2(w.d)}` }
/** "YYYYMMDDTHHMMSS" (floating / TZID form). */
export function wallToIcs(w: Wall): string { return `${wallDate(w)}T${p2(w.h)}${p2(w.mi)}${p2(w.s)}` }
/** UTC instant -> "YYYYMMDDTHHMMSSZ". */
export function utcToIcs(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCFullYear()).padStart(4, '0')}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`
}

function offsetStr(ms: number): string {
  const m = Math.round(ms / 60_000)
  const a = Math.abs(m)
  return `${m < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}${p2(a % 60)}`
}

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** Day of month of the n-th (n<0: from the end) weekday `wd` (0=Sunday) in a month. */
function nthWeekday(y: number, mo: number, n: number, wd: number): number {
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  if (n > 0) {
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay()
    return 1 + ((wd - first + 7) % 7) + 7 * (n - 1)
  }
  const last = new Date(Date.UTC(y, mo - 1, days)).getUTCDay()
  return days - ((last - wd + 7) % 7) + 7 * (n + 1)
}

interface Transition { at: number, from: number, to: number }

function transitions(tz: string, year: number): Transition[] {
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  const out: Transition[] = []
  let prev = zoneOffsetMs(tz, start)
  for (let t = start + DAY; t <= end; t += DAY) {
    const o = zoneOffsetMs(tz, t)
    if (o === prev) continue
    let lo = t - DAY, hi = t
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000
      if (zoneOffsetMs(tz, mid) === prev) lo = mid; else hi = mid
    }
    out.push({ at: hi, from: prev, to: o })
    prev = o
  }
  return out
}

/**
 * VTIMEZONE lines for `tz`, from its rules in `year` (the series' first
 * year): the usual pair of yearly STANDARD/DAYLIGHT observances
 * ("last Sunday of March"), or one fixed STANDARD for a zone without DST.
 */
export function buildVTimezone(tz: string, year: number): string[] {
  const out = ['BEGIN:VTIMEZONE', `TZID:${tz}`]
  const ts = transitions(tz, year)
  const obs = (kind: 'STANDARD' | 'DAYLIGHT', dtstart: string, from: number, to: number, rrule?: string) => {
    out.push(`BEGIN:${kind}`, `DTSTART:${dtstart}`, `TZOFFSETFROM:${offsetStr(from)}`, `TZOFFSETTO:${offsetStr(to)}`)
    if (rrule) out.push(`RRULE:${rrule}`)
    out.push(`END:${kind}`)
  }
  if (ts.length === 2) {
    for (const t of ts) {
      // Onset in the wall-clock time that was in force before the change.
      const local = new Date(t.at + t.from)
      const mo = local.getUTCMonth() + 1
      const d = local.getUTCDate()
      const wd = local.getUTCDay()
      const daysIn = new Date(Date.UTC(local.getUTCFullYear(), mo, 0)).getUTCDate()
      const n = d + 7 > daysIn ? -1 : Math.ceil(d / 7)
      const d1970 = nthWeekday(1970, mo, n, wd)
      const time = `${p2(local.getUTCHours())}${p2(local.getUTCMinutes())}${p2(local.getUTCSeconds())}`
      obs(t.to > t.from ? 'DAYLIGHT' : 'STANDARD', `1970${p2(mo)}${p2(d1970)}T${time}`, t.from, t.to, `FREQ=YEARLY;BYMONTH=${mo};BYDAY=${n}${WD[wd]}`)
    }
  } else {
    const first = zoneOffsetMs(tz, Date.UTC(year, 0, 1))
    obs('STANDARD', '19700101T000000', first, first)
    // Irregular year (a zone changed its rules): fixed onsets.
    for (const t of ts) {
      const local = new Date(t.at + t.from)
      const at = `${local.getUTCFullYear()}${p2(local.getUTCMonth() + 1)}${p2(local.getUTCDate())}T${p2(local.getUTCHours())}${p2(local.getUTCMinutes())}${p2(local.getUTCSeconds())}`
      obs(t.to > t.from ? 'DAYLIGHT' : 'STANDARD', at, t.from, t.to)
    }
  }
  out.push('END:VTIMEZONE')
  return out
}

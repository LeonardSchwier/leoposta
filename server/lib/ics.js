// iCalendar (RFC 5545) reading for the CalDAV routes: unfolding, property
// parsing, VEVENT extraction (never VTIMEZONE's DTSTART), TZID → UTC and
// recurrence expansion for the visible range. Pure functions, no I/O.

/** Unfold RFC 5545 §3.1 content lines (CRLF + space/tab continues a line). */
export function unfoldLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')
}

/** Split one content line into { name, params, value }; params keys are upper-case. */
export function parseProperty(line) {
  let i = 0
  let inQuote = false
  let colon = -1
  for (; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    else if (ch === ':' && !inQuote) { colon = i; break }
  }
  if (colon === -1) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const parts = []
  let cur = ''
  inQuote = false
  for (const ch of head) {
    if (ch === '"') { inQuote = !inQuote; continue }
    if (ch === ';' && !inQuote) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  // A group prefix ("item1.EMAIL" in vCard) is not part of the name.
  const rawName = parts[0].trim()
  const dot = rawName.lastIndexOf('.')
  const name = (dot >= 0 ? rawName.slice(dot + 1) : rawName).toUpperCase()
  const params = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq === -1) { params[p.trim().toUpperCase()] = ''; continue }
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1)
  }
  return { name, params, value }
}

/** Unescape a TEXT value (RFC 5545 §3.3.11 / RFC 6350 §3.4). */
export function unescapeText(v) {
  return String(v || '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))
}

/** Escape a TEXT value. */
export function escapeText(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
}

/**
 * Collect every component of a given name, outermost-level only within its
 * parent: returns arrays of content lines (already unfolded) per block.
 */
function blocks(lines, comp) {
  const out = []
  let depth = 0
  let cur = null
  for (const line of lines) {
    if (/^BEGIN:/i.test(line)) {
      const name = line.slice(6).trim().toUpperCase()
      if (cur) { depth++; cur.push(line); continue }
      if (name === comp) { cur = [line]; depth = 0; continue }
    } else if (/^END:/i.test(line) && cur) {
      const name = line.slice(4).trim().toUpperCase()
      cur.push(line)
      if (depth === 0 && name === comp) { out.push(cur); cur = null; continue }
      depth--
      continue
    }
    if (cur) cur.push(line)
  }
  return out
}

/** The raw text (folded lines kept) of every VTIMEZONE block in an ICS blob. */
export function rawBlocks(text, comp) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let cur = null
  let depth = 0
  for (const line of lines) {
    const begin = /^BEGIN:(.+)$/i.exec(line)
    const end = /^END:(.+)$/i.exec(line)
    if (begin) {
      if (cur) { depth++; cur.push(line); continue }
      if (begin[1].trim().toUpperCase() === comp) { cur = [line]; depth = 0; continue }
    }
    if (end && cur) {
      cur.push(line)
      if (depth === 0 && end[1].trim().toUpperCase() === comp) { out.push(cur.join('\r\n')); cur = null }
      else depth--
      continue
    }
    if (cur) cur.push(line)
  }
  return out
}

// ── Date-time values ─────────────────────────────────────────────────────────

/** Parse a DATE or DATE-TIME value into wall-clock parts. */
export function parseDateValue(value, params = {}) {
  const v = String(value || '').trim()
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v)
  if (!m) return null
  const allDay = !m[4] || params.VALUE === 'DATE'
  return {
    y: +m[1], mo: +m[2], d: +m[3],
    h: allDay ? 0 : +m[4], mi: allDay ? 0 : +m[5], s: allDay ? 0 : +(m[6] || 0),
    allDay,
    utc: !!m[7],
    tzid: !m[7] && !allDay && params.TZID ? params.TZID.replace(/^\//, '') : null
  }
}

const tzFormatters = new Map()
function tzFormatter(tz) {
  if (!tzFormatters.has(tz)) {
    tzFormatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }))
  }
  return tzFormatters.get(tz)
}

/** Offset (ms) of a named zone at a UTC instant, or null for an unknown zone. */
function tzOffset(tz, utcMs) {
  let f
  try { f = tzFormatter(tz) } catch { return null }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - utcMs
}

/** Wall-clock time in zone `tz` → UTC ms; null when the zone is unknown. */
export function zonedToUtc(parts, tz) {
  const naive = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s)
  const o1 = tzOffset(tz, naive)
  if (o1 === null) return null
  const o2 = tzOffset(tz, naive - o1)
  return naive - (o2 ?? o1)
}

function pad(n, w = 2) { return String(n).padStart(w, '0') }

/**
 * The value the frontend gets for a start/end: "YYYYMMDD" (all-day),
 * "YYYYMMDDTHHMMSSZ" (an instant: UTC, or a TZID converted to UTC) or
 * "YYYYMMDDTHHMMSS" (floating local time, or a zone we do not know).
 */
export function formatForClient(parts) {
  if (!parts) return ''
  const date = `${pad(parts.y, 4)}${pad(parts.mo)}${pad(parts.d)}`
  if (parts.allDay) return date
  if (parts.utc) return `${date}T${pad(parts.h)}${pad(parts.mi)}${pad(parts.s)}Z`
  if (parts.tzid) {
    const ms = zonedToUtc(parts, parts.tzid)
    if (ms !== null) {
      const d = new Date(ms)
      return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
    }
  }
  return `${date}T${pad(parts.h)}${pad(parts.mi)}${pad(parts.s)}`
}

/** Absolute UTC ms of a value, for range checks (floating = treated as UTC). */
function toUtcMs(parts) {
  if (parts.tzid && !parts.utc && !parts.allDay) {
    const ms = zonedToUtc(parts, parts.tzid)
    if (ms !== null) return ms
  }
  return Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s)
}

// ── VEVENT parsing ───────────────────────────────────────────────────────────

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim())
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return sign * ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000
}

/** Every VEVENT in an ICS blob, as plain objects. VTIMEZONE etc. are skipped. */
export function parseEvents(ics) {
  const lines = unfoldLines(ics)
  const out = []
  for (const b of blocks(lines, 'VEVENT')) {
    const ev = { uid: '', summary: '', location: '', description: '', attendees: [], exdates: [], rrule: null, dtstart: null, dtend: null, duration: null, recurrenceId: null, status: '' }
    let depth = 0
    for (const line of b.slice(1, -1)) {
      if (/^BEGIN:/i.test(line)) { depth++; continue } // VALARM etc.
      if (/^END:/i.test(line)) { depth--; continue }
      if (depth > 0) continue
      const p = parseProperty(line)
      if (!p) continue
      switch (p.name) {
        case 'UID': ev.uid = p.value.trim(); break
        case 'SUMMARY': ev.summary = unescapeText(p.value); break
        case 'LOCATION': ev.location = unescapeText(p.value); break
        case 'DESCRIPTION': ev.description = unescapeText(p.value); break
        case 'STATUS': ev.status = p.value.trim().toUpperCase(); break
        case 'DTSTART': ev.dtstart = parseDateValue(p.value, p.params); break
        case 'DTEND': ev.dtend = parseDateValue(p.value, p.params); break
        case 'DURATION': ev.duration = parseDuration(p.value); break
        case 'RRULE': ev.rrule = p.value.trim(); break
        case 'RECURRENCE-ID': ev.recurrenceId = parseDateValue(p.value, p.params); break
        case 'EXDATE':
          for (const v of p.value.split(',')) {
            const d = parseDateValue(v, p.params)
            if (d) ev.exdates.push(d)
          }
          break
        case 'ATTENDEE': {
          const m = /^mailto:(.+)$/i.exec(p.value.trim())
          if (m) ev.attendees.push(m[1].trim())
          break
        }
      }
    }
    if (ev.dtstart) out.push(ev)
  }
  return out
}

// ── Recurrence (RFC 5545 §3.3.10, the common subset) ─────────────────────────

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function parseRrule(s) {
  const r = {}
  for (const kv of String(s || '').split(';')) {
    const [k, v] = kv.split('=')
    if (k && v !== undefined) r[k.toUpperCase()] = v
  }
  return {
    freq: r.FREQ,
    interval: Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL ? parseDateValue(r.UNTIL) : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map(x => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim().toUpperCase()); return m ? { n: m[1] ? parseInt(m[1], 10) : 0, day: DAYS.indexOf(m[2]) } : null }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number).filter(Number.isFinite) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number).filter(Number.isFinite) : null
  }
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate() } // m: 1-12
function withDate(parts, y, mo, d) { return { ...parts, y, mo, d } }
function keyOf(p) { return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}` }
function dateKey(p) { return `${p.y}-${p.mo}-${p.d}` }

/** Candidate dates of one period (week/month/year) in chronological order. */
function periodDates(rule, start, py, pmo, pd) {
  const out = []
  if (rule.freq === 'DAILY') return [withDate(start, py, pmo, pd)]
  if (rule.freq === 'WEEKLY') {
    // period = the week (starting Monday, WKST default) containing py-pmo-pd
    const base = new Date(Date.UTC(py, pmo - 1, pd))
    const dow = (base.getUTCDay() + 6) % 7
    const monday = new Date(base.getTime() - dow * 86400000)
    const days = rule.byday ? rule.byday.map(b => b.day) : [new Date(Date.UTC(start.y, start.mo - 1, start.d)).getUTCDay()]
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday.getTime() + i * 86400000)
      if (days.includes(d.getUTCDay())) out.push(withDate(start, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()))
    }
    return out
  }
  const monthDates = (y, mo) => {
    const n = daysInMonth(y, mo)
    const res = []
    if (rule.byday) {
      for (let d = 1; d <= n; d++) {
        const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
        for (const b of rule.byday) {
          if (b.day !== wd) continue
          if (!b.n) { res.push(d); continue }
          const nth = Math.floor((d - 1) / 7) + 1
          const nthFromEnd = Math.floor((n - d) / 7) + 1
          if ((b.n > 0 && nth === b.n) || (b.n < 0 && nthFromEnd === -b.n)) res.push(d)
        }
      }
    } else if (rule.bymonthday) {
      for (const md of rule.bymonthday) {
        const d = md > 0 ? md : n + md + 1
        if (d >= 1 && d <= n) res.push(d)
      }
    } else if (start.d <= n) {
      res.push(start.d)
    }
    return [...new Set(res)].sort((a, b) => a - b).map(d => withDate(start, y, mo, d))
  }
  if (rule.freq === 'MONTHLY') return monthDates(py, pmo)
  if (rule.freq === 'YEARLY') {
    const months = rule.bymonth || [start.mo]
    for (const mo of months) {
      if (rule.byday || rule.bymonthday) out.push(...monthDates(py, mo))
      else if (start.d <= daysInMonth(py, mo)) out.push(withDate(start, py, mo, start.d))
    }
    return out
  }
  return []
}

function advance(rule, y, mo, d) {
  const i = rule.interval
  if (rule.freq === 'DAILY') { const t = new Date(Date.UTC(y, mo - 1, d + i)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()] }
  if (rule.freq === 'WEEKLY') { const t = new Date(Date.UTC(y, mo - 1, d + 7 * i)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()] }
  if (rule.freq === 'MONTHLY') { const t = new Date(Date.UTC(y, mo - 1 + i, 1)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, 1] }
  return [y + i, 1, 1]
}

const MAX_ITERATIONS = 20000

/**
 * Start times (wall-clock parts in the event's own zone) of every occurrence
 * that starts before `rangeEndMs`, skipping EXDATEs. Non-recurring → [dtstart].
 */
export function occurrenceStarts(ev, rangeEndMs) {
  if (!ev.rrule) return [ev.dtstart]
  const rule = parseRrule(ev.rrule)
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return [ev.dtstart]
  const start = ev.dtstart
  const startMs = toUtcMs(start)
  const untilMs = rule.until ? toUtcMs(rule.until.allDay ? { ...rule.until, h: 23, mi: 59, s: 59 } : rule.until) : Infinity
  const ex = new Set(ev.exdates.map(e => (e.allDay ? dateKey(e) : keyOf(e))))
  const out = []
  let produced = 0
  let [py, pmo, pd] = rule.freq === 'MONTHLY' ? [start.y, start.mo, 1] : rule.freq === 'YEARLY' ? [start.y, 1, 1] : [start.y, start.mo, start.d]
  for (let guard = 0; guard < MAX_ITERATIONS; guard++) {
    for (const cand of periodDates(rule, start, py, pmo, pd)) {
      const ms = toUtcMs(cand)
      if (ms < startMs) continue
      if (ms > untilMs) return out
      if (rule.count !== null && produced >= rule.count) return out
      produced++
      if (ms >= rangeEndMs) return out
      if (!ex.has(keyOf(cand)) && !ex.has(dateKey(cand))) out.push(cand)
    }
    ;[py, pmo, pd] = advance(rule, py, pmo, pd)
    if (Date.UTC(py, pmo - 1, pd) > rangeEndMs + 366 * 86400000) return out
  }
  return out
}

/**
 * Events of one calendar object resource, expanded to the occurrences that
 * overlap [rangeStartMs, rangeEndMs). A RECURRENCE-ID override replaces the
 * occurrence it names. Each result has client-format `start`/`end`.
 */
export function expandForRange(ics, rangeStartMs = -Infinity, rangeEndMs = Infinity) {
  const evs = parseEvents(ics)
  const masters = evs.filter(e => !e.recurrenceId)
  const overrides = evs.filter(e => e.recurrenceId)
  const out = []
  const durationOf = (ev) => {
    if (ev.dtend) return toUtcMs(ev.dtend) - toUtcMs(ev.dtstart)
    if (ev.duration !== null) return ev.duration
    return ev.dtstart.allDay ? 86400000 : 0
  }
  const endParts = (startParts, durMs, ev) => {
    if (ev.dtstart.allDay) {
      const t = new Date(Date.UTC(startParts.y, startParts.mo - 1, startParts.d) + durMs)
      return { ...startParts, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }
    }
    // Add in UTC, then express in the same form as the start.
    const ms = toUtcMs(startParts) + durMs
    if (startParts.tzid || startParts.utc) {
      const d = new Date(ms)
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), allDay: false, utc: true, tzid: null }
    }
    const d = new Date(ms)
    return { ...startParts, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
  }
  const emit = (ev, startParts, extra) => {
    const dur = durationOf(ev)
    const sMs = toUtcMs(startParts)
    const eMs = sMs + dur
    if (eMs <= rangeStartMs && !(dur === 0 && sMs >= rangeStartMs)) return
    if (sMs >= rangeEndMs) return
    out.push({
      uid: ev.uid,
      summary: ev.summary,
      location: ev.location,
      description: ev.description,
      attendees: ev.attendees,
      allDay: !!ev.dtstart.allDay,
      start: formatForClient(startParts),
      end: (ev.dtend || ev.duration !== null || ev.dtstart.allDay) ? formatForClient(endParts(startParts, dur, ev)) : '',
      ...extra
    })
  }
  for (const m of masters) {
    const recurring = !!m.rrule
    const own = overrides.filter(o => o.uid === m.uid)
    const overridden = new Set(own.map(o => toUtcMs(o.recurrenceId)))
    for (const st of occurrenceStarts(m, rangeEndMs)) {
      if (recurring && overridden.has(toUtcMs(st))) continue
      emit(m, st, recurring ? { recurring: true, rrule: m.rrule, recurrenceId: formatForClient(st) } : { recurring: false })
    }
    for (const o of own) {
      if (o.status === 'CANCELLED') continue
      emit(o, o.dtstart, { recurring: true, rrule: m.rrule, recurrenceId: formatForClient(o.recurrenceId) })
    }
  }
  // Orphan overrides (master outside this resource) still show.
  for (const o of overrides) {
    if (masters.some(m => m.uid === o.uid) || o.status === 'CANCELLED') continue
    emit(o, o.dtstart, { recurring: true, recurrenceId: formatForClient(o.recurrenceId) })
  }
  return out
}

/** "YYYY-MM-DD" / "YYYYMMDDTHHMMSSZ" query bound → UTC ms. */
export function boundToMs(s, endOfDay = false) {
  if (!s) return endOfDay ? Infinity : -Infinity
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2}))?/.exec(String(s))
  if (!m) return endOfDay ? Infinity : -Infinity
  if (m[4]) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) + (endOfDay ? 86400000 : 0)
}

/**
 * Split an imported ICS file into one calendar object per UID (RFC 4791
 * §4.1: all components of a resource share one UID; a recurring event and
 * its RECURRENCE-ID overrides travel together), each carrying the
 * VTIMEZONEs it needs. Text is kept byte-for-byte (folding and escapes intact).
 */
export function splitIcsByUid(ics) {
  const text = String(ics || '')
  const tzs = rawBlocks(text, 'VTIMEZONE')
  const tzById = new Map()
  for (const tz of tzs) {
    const m = /^TZID[^:]*:(.*)$/im.exec(tz.replace(/\r?\n[ \t]/g, ''))
    if (m) tzById.set(m[1].trim(), tz)
  }
  const groups = new Map()
  let anon = 0
  for (const ev of rawBlocks(text, 'VEVENT')) {
    const unfolded = ev.replace(/\r?\n[ \t]/g, '')
    const um = /^UID[^:]*:(.*)$/im.exec(unfolded)
    const uid = um ? um[1].trim() : `leoposta-import-${Date.now()}-${anon++}`
    if (!groups.has(uid)) groups.set(uid, { uid, events: [], hasUid: !!um })
    groups.get(uid).events.push(ev)
  }
  const out = []
  for (const g of groups.values()) {
    const needed = new Set()
    for (const ev of g.events) {
      for (const m of ev.replace(/\r?\n[ \t]/g, '').matchAll(/;TZID=("?)([^:;"]+)\1/g)) needed.add(m[2])
    }
    const parts = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//leoposta//EN']
    for (const id of needed) if (tzById.has(id)) parts.push(tzById.get(id))
    for (const ev of g.events) {
      parts.push(g.hasUid ? ev : ev.replace(/^BEGIN:VEVENT/i, `BEGIN:VEVENT\r\nUID:${g.uid}`))
    }
    parts.push('END:VCALENDAR')
    out.push({ uid: g.uid, ics: parts.join('\r\n') + '\r\n' })
  }
  return out
}

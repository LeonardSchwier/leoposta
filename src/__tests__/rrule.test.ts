import { describe, it, expect } from 'vitest'
import { parseRRule, buildRRule, defaultRepeat, repeatProblem, weekdayOf, type Repeat, type RuleContext } from '../lib/rrule'
import { buildVTimezone, wallToUtc, utcToWall } from '../lib/tz'
import { eventToICS } from '../lib/vcf'
import { patchEventICS, masterStartInfo, weeklyStartMismatch } from '../lib/icsPatch'

// The server's expansion (what the calendar views show), to check that what
// the editor writes repeats where it should.
interface Expanded { start: string, end: string, recurring: boolean }
const serverIcs = '../../server/lib/ics.js'
const { expandForRange }: { expandForRange: (ics: string, s?: number, e?: number) => Expanded[] } = await import(/* @vite-ignore */ serverIcs)

const BERLIN: RuleContext = { allDay: false, zone: 'Europe/Berlin' }
const ALLDAY: RuleContext = { allDay: true, zone: null }
const rep = (over: Partial<Repeat>, start = '2026-03-02'): Repeat => ({ ...defaultRepeat(start), ...over })

describe('buildRRule', () => {
  it('Never gives no rule', () => {
    expect(buildRRule(defaultRepeat('2026-03-02'), BERLIN)).toBeNull()
  })
  it('daily, with and without an interval', () => {
    expect(buildRRule(rep({ freq: 'DAILY' }), BERLIN)).toBe('FREQ=DAILY')
    expect(buildRRule(rep({ freq: 'DAILY', interval: 3 }), BERLIN)).toBe('FREQ=DAILY;INTERVAL=3')
  })
  it('weekly on picked weekdays (in calendar order), with COUNT', () => {
    expect(buildRRule(rep({ freq: 'WEEKLY', byDay: ['WE', 'MO'], end: 'count', count: 6 }), BERLIN)).toBe('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6')
    expect(buildRRule(rep({ freq: 'WEEKLY', interval: 2 }), BERLIN)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')
  })
  it('monthly / yearly follow DTSTART (no BY* parts)', () => {
    expect(buildRRule(rep({ freq: 'MONTHLY' }), BERLIN)).toBe('FREQ=MONTHLY')
    expect(buildRRule(rep({ freq: 'YEARLY', interval: 2 }), ALLDAY)).toBe('FREQ=YEARLY;INTERVAL=2')
  })
  it('UNTIL of a timed event is the end of that day in its zone, in UTC (summer and winter)', () => {
    expect(buildRRule(rep({ freq: 'MONTHLY', end: 'until', until: '2026-07-15' }), BERLIN)).toBe('FREQ=MONTHLY;UNTIL=20260715T215959Z')
    expect(buildRRule(rep({ freq: 'MONTHLY', end: 'until', until: '2026-12-15' }), BERLIN)).toBe('FREQ=MONTHLY;UNTIL=20261215T225959Z')
  })
  it('UNTIL of an all-day event is a DATE; of a floating event a floating time', () => {
    expect(buildRRule(rep({ freq: 'YEARLY', end: 'until', until: '2030-03-02' }), ALLDAY)).toBe('FREQ=YEARLY;UNTIL=20300302')
    expect(buildRRule(rep({ freq: 'DAILY', end: 'until', until: '2026-03-09' }), { allDay: false, zone: null })).toBe('FREQ=DAILY;UNTIL=20260309T235959')
  })
})

describe('parseRRule', () => {
  it('reads every option the control has, and round-trips', () => {
    const cases: [Repeat, RuleContext][] = [
      [rep({ freq: 'DAILY', interval: 3 }), BERLIN],
      [rep({ freq: 'WEEKLY', byDay: ['MO', 'WE'], end: 'count', count: 6 }), BERLIN],
      [rep({ freq: 'WEEKLY', interval: 2, byDay: ['TU', 'FR', 'SU'] }), BERLIN],
      [rep({ freq: 'MONTHLY', end: 'until', until: '2026-07-15' }), BERLIN],
      [rep({ freq: 'MONTHLY', end: 'until', until: '2026-12-15' }), BERLIN],
      [rep({ freq: 'YEARLY', end: 'until', until: '2030-03-02' }), ALLDAY],
      [rep({ freq: 'DAILY', end: 'until', until: '2026-03-09' }), { allDay: false, zone: null }]
    ]
    for (const [r, ctx] of cases) {
      const s = buildRRule(r, ctx)!
      const back = parseRRule(s, '2026-03-02', ctx)
      expect(back, s).toEqual({ kind: 'simple', repeat: r })
    }
  })
  it('no rule is "none"; WEEKLY without BYDAY means the start weekday', () => {
    expect(parseRRule('', '2026-03-02', BERLIN)).toEqual({ kind: 'none' })
    expect(parseRRule(undefined, '2026-03-02', BERLIN)).toEqual({ kind: 'none' })
    const p = parseRRule('FREQ=WEEKLY;COUNT=3', '2026-03-04', BERLIN)
    expect(p.kind === 'simple' && p.repeat.byDay).toEqual(['WE'])
  })
  it('accepts redundant parts that say what DTSTART says (BYMONTHDAY, BYMONTH, WKST=MO)', () => {
    expect(parseRRule('FREQ=MONTHLY;BYMONTHDAY=2', '2026-03-02', BERLIN).kind).toBe('simple')
    expect(parseRRule('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=2', '2026-03-02', BERLIN).kind).toBe('simple')
    expect(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=MO', '2026-03-02', BERLIN).kind).toBe('simple')
    expect(parseRRule('freq=weekly;byday=mo', '2026-03-02', BERLIN).kind).toBe('simple')
  })
  it('a UTC UNTIL at another time of day still reads as that local date', () => {
    const p = parseRRule('FREQ=DAILY;UNTIL=20260309T080000Z', '2026-03-02', BERLIN)
    expect(p.kind === 'simple' && p.repeat.until).toBe('2026-03-09')
  })
  it('rules the control cannot express are "custom", kept verbatim', () => {
    for (const r of [
      'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=MONTHLY;BYDAY=-1FR',
      'FREQ=MONTHLY;BYMONTHDAY=1,15',
      'FREQ=MONTHLY;BYMONTHDAY=5',
      'FREQ=YEARLY;BYMONTH=1,7',
      'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
      'FREQ=DAILY;BYHOUR=9,17',
      'FREQ=HOURLY;INTERVAL=4',
      'FREQ=WEEKLY;COUNT=3;UNTIL=20260401T000000Z',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU',
      'FREQ=WEEKLY;X-NAME=1',
      'FREQ=WEEKLY;INTERVAL=0',
      'FREQ=WEEKLY;BYDAY=MO;BYDAY=TU'
    ]) {
      expect(parseRRule(r, '2026-03-02', BERLIN), r).toEqual({ kind: 'custom', rrule: r })
    }
  })
})

describe('repeatProblem / weekdayOf', () => {
  it('validates the control', () => {
    expect(weekdayOf('2026-03-02')).toBe('MO')
    expect(weekdayOf('2026-03-08')).toBe('SU')
    expect(repeatProblem(rep({ freq: 'NONE', interval: 0 }), '2026-03-02')).toBeNull()
    expect(repeatProblem(rep({ freq: 'DAILY', interval: 0 }), '2026-03-02')).toMatch(/1 to 999/)
    expect(repeatProblem(rep({ freq: 'WEEKLY', byDay: [] }), '2026-03-02')).toMatch(/weekday/)
    expect(repeatProblem(rep({ freq: 'DAILY', end: 'count', count: 0 }), '2026-03-02')).toMatch(/occurrences/)
    expect(repeatProblem(rep({ freq: 'DAILY', end: 'until', until: '2026-03-01' }), '2026-03-02')).toMatch(/before the event starts/)
    expect(repeatProblem(rep({ freq: 'DAILY', end: 'until', until: '' }), '2026-03-02')).toMatch(/Pick the date/)
    expect(repeatProblem(rep({ freq: 'DAILY', end: 'until', until: '2026-03-02' }), '2026-03-02')).toBeNull()
  })
})

describe('VTIMEZONE from the zone rules', () => {
  it('Europe/Berlin: last Sundays of March and October', () => {
    const v = buildVTimezone('Europe/Berlin', 2026).join('\n')
    expect(v).toContain('BEGIN:DAYLIGHT\nDTSTART:19700329T020000\nTZOFFSETFROM:+0100\nTZOFFSETTO:+0200\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\nEND:DAYLIGHT')
    expect(v).toContain('BEGIN:STANDARD\nDTSTART:19701025T030000\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\nEND:STANDARD')
  })
  it('America/New_York: second Sunday of March, first of November', () => {
    const v = buildVTimezone('America/New_York', 2026).join('\n')
    expect(v).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU')
    expect(v).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU')
    expect(v).toContain('TZOFFSETTO:-0400')
  })
  it('a zone without DST has one fixed STANDARD', () => {
    expect(buildVTimezone('Asia/Tokyo', 2026)).toEqual(['BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'END:STANDARD', 'END:VTIMEZONE'])
  })
  it('wall clock <-> UTC across the change', () => {
    expect(wallToUtc({ y: 2026, mo: 3, d: 30, h: 9, mi: 0, s: 0 }, 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 30, 7))
    expect(utcToWall(Date.UTC(2026, 2, 23, 8), 'Europe/Berlin')).toEqual({ y: 2026, mo: 3, d: 23, h: 9, mi: 0, s: 0 })
  })
})

describe('a new series as written by the editor', () => {
  it('weekly Mon/Wed 09:00 Berlin across the DST change stays at 09:00 local', () => {
    const rrule = buildRRule(rep({ freq: 'WEEKLY', byDay: ['MO', 'WE'], end: 'count', count: 6 }, '2026-03-23'), BERLIN)!
    const ics = eventToICS({ summary: 'Gym', start: '20260323T090000', end: '20260323T100000', location: '', description: '', tzid: 'Europe/Berlin', rrule }, 'u1')
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260323T090000')
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6')
    expect(ics).toContain('BEGIN:VTIMEZONE')
    expect(ics.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(ics.indexOf('BEGIN:VEVENT'))
    const starts = expandForRange(ics).map(e => e.start)
    // Mon 23, Wed 25 (CET, UTC+1), then Mon 30 March onwards CEST (UTC+2).
    expect(starts).toEqual(['20260323T080000Z', '20260325T080000Z', '20260330T070000Z', '20260401T070000Z', '20260406T070000Z', '20260408T070000Z'])
    for (const s of starts) expect(utcToWall(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11)), 'Europe/Berlin').h).toBe(9)
  })
  it('monthly with UNTIL includes an occurrence on the UNTIL day, not after it', () => {
    const rrule = buildRRule(rep({ freq: 'MONTHLY', end: 'until', until: '2026-06-15' }, '2026-03-15'), BERLIN)!
    const ics = eventToICS({ summary: 'Rent', start: '20260315T230000', end: '20260315T233000', location: '', description: '', tzid: 'Europe/Berlin', rrule }, 'u2')
    expect(expandForRange(ics).map(e => e.start)).toEqual(['20260315T220000Z', '20260415T210000Z', '20260515T210000Z', '20260615T210000Z'])
  })
  it('all-day yearly with a DATE UNTIL', () => {
    const rrule = buildRRule(rep({ freq: 'YEARLY', end: 'until', until: '2029-05-04' }, '2026-05-04'), ALLDAY)!
    const ics = eventToICS({ summary: 'Birthday', start: '20260504', end: '20260505', allDay: true, location: '', description: '', rrule }, 'u3')
    expect(ics).toContain('RRULE:FREQ=YEARLY;UNTIL=20290504')
    expect(ics).not.toContain('VTIMEZONE')
    expect(expandForRange(ics).map(e => e.start)).toEqual(['20260504', '20270504', '20280504', '20290504'])
  })
})

const VTZ = buildVTimezone('Europe/Berlin', 2026)
const seriesIcs = (rrule: string) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', ...VTZ,
  'BEGIN:VEVENT', 'UID:s1', 'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Berlin:20260105T090000', 'DTEND;TZID=Europe/Berlin:20260105T093000',
  `RRULE:${rrule}`, 'EXDATE;TZID=Europe/Berlin:20260119T090000', 'SUMMARY:Standup',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID;TZID=Europe/Berlin:20260112T090000', 'DTSTART;TZID=Europe/Berlin:20260112T100000', 'DTEND;TZID=Europe/Berlin:20260112T103000', 'SUMMARY:Standup (late)', 'END:VEVENT',
  'END:VCALENDAR', ''
].join('\r\n')
// The 26 Jan occurrence, 09:00 Berlin = 08:00Z, opened unchanged.
const occ = { summary: 'Standup', location: '', description: '', allDay: false, occurrenceStart: '20260126T080000Z', start: '20260126T080000Z', end: '20260126T083000Z', zone: 'Europe/Berlin' }

describe('patchEventICS and the repeat rule', () => {
  it('no rule change keeps a custom RRULE byte for byte', () => {
    const custom = 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1'
    const out = patchEventICS(seriesIcs(custom), 's1', { ...occ, summary: 'Renamed' })!
    expect(out).toContain(`RRULE:${custom}`)
    expect(out.match(/^RRULE:FREQ=MONTHLY/gm)).toHaveLength(1)
  })
  it('changing the rule replaces only RRULE: start, EXDATE, overrides and alarms stay', () => {
    const out = patchEventICS(seriesIcs('FREQ=WEEKLY;COUNT=10'), 's1', { ...occ, rrule: 'FREQ=MONTHLY;UNTIL=20261231T225959Z' })!
    expect(out).toContain('RRULE:FREQ=MONTHLY;UNTIL=20261231T225959Z')
    expect(out).not.toContain('FREQ=WEEKLY')
    for (const keep of ['DTSTART;TZID=Europe/Berlin:20260105T090000', 'EXDATE;TZID=Europe/Berlin:20260119T090000', 'RECURRENCE-ID;TZID=Europe/Berlin:20260112T090000', 'TRIGGER:-PT10M']) expect(out).toContain(keep)
    expect(out.match(/^BEGIN:VTIMEZONE/gm)).toHaveLength(1)
  })
  it('"Never" removes RRULE, EXDATE and the overridden occurrences; the event is the one the editor showed', () => {
    const out = patchEventICS(seriesIcs('FREQ=WEEKLY;COUNT=10'), 's1', { ...occ, rrule: null })!
    for (const gone of ['RRULE:FREQ=WEEKLY', 'EXDATE', 'RECURRENCE-ID', 'Standup (late)']) expect(out).not.toContain(gone)
    expect(out.match(/^BEGIN:VEVENT/gm)).toHaveLength(1)
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20260126T090000')
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20260126T093000')
    expect(out).toContain('TRIGGER:-PT10M')
    expect(expandForRange(out)).toHaveLength(1)
  })
  it('"Never" on a UTC or all-day series keeps their form', () => {
    const utc = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u', 'DTSTART:20260102T080000Z', 'DTEND:20260102T083000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const o1 = patchEventICS(utc, 'u', { ...occ, occurrenceStart: '20260109T080000Z', start: '20260109T080000Z', end: '20260109T083000Z', rrule: null })!
    expect(o1).toContain('DTSTART:20260109T080000Z')
    expect(o1).not.toContain('RRULE')
    const day = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:d', 'DTSTART;VALUE=DATE:20260102', 'DTEND;VALUE=DATE:20260103', 'RRULE:FREQ=YEARLY', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const o2 = patchEventICS(day, 'd', { ...occ, allDay: true, occurrenceStart: '20270102', start: '20270102', end: '20270103', rrule: null })!
    expect(o2).toContain('DTSTART;VALUE=DATE:20270102')
    expect(o2).toContain('DTEND;VALUE=DATE:20270103')
  })
  it('a single UTC event that becomes a series is rewritten in the local zone with a VTIMEZONE', () => {
    const single = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:x', 'DTSTART:20260323T080000Z', 'DTEND:20260323T090000Z', 'SUMMARY:Gym', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const out = patchEventICS(single, 'x', { ...occ, summary: 'Gym', occurrenceStart: '20260323T080000Z', start: '20260323T080000Z', end: '20260323T090000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2' })!
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20260323T090000')
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20260323T100000')
    expect(out).toContain('BEGIN:VTIMEZONE')
    expect(expandForRange(out).map(e => e.start)).toEqual(['20260323T080000Z', '20260330T070000Z'])
  })
  it('masterStartInfo and weeklyStartMismatch', () => {
    expect(masterStartInfo(seriesIcs('FREQ=DAILY'), 's1')).toEqual({ kind: 'local', tzid: 'Europe/Berlin' })
    expect(weeklyStartMismatch(seriesIcs('FREQ=WEEKLY;BYDAY=MO,WE'), 's1')).toBeNull()
    expect(weeklyStartMismatch(seriesIcs('FREQ=WEEKLY;BYDAY=TU,WE'), 's1')).toBe('MO')
    expect(weeklyStartMismatch(seriesIcs('FREQ=MONTHLY'), 's1')).toBeNull()
  })
})

describe('masterStartLocalDate', () => {
  it('is the series start in the browser zone, not the opened occurrence', async () => {
    const { masterStartLocalDate } = await import('../lib/icsPatch')
    const local = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
    expect(masterStartLocalDate(seriesIcs('FREQ=MONTHLY'), 's1')).toBe(local(wallToUtc({ y: 2026, mo: 1, d: 5, h: 9, mi: 0, s: 0 }, 'Europe/Berlin')))
    const day = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:d', 'DTSTART;VALUE=DATE:20260102', 'RRULE:FREQ=YEARLY', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    expect(masterStartLocalDate(day, 'd')).toBe('2026-01-02')
    const utc = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u', 'DTSTART:20260102T120000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    expect(masterStartLocalDate(utc, 'u')).toBe(local(Date.UTC(2026, 0, 2, 12)))
    expect(masterStartLocalDate(utc, 'nope')).toBeNull()
  })
})

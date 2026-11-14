import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvents, expandForRange, splitIcsByUid, unfoldLines, parseProperty, boundToMs, formatForClient, parseDateValue } from './ics.js'

const TZ_BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
  'END:VTIMEZONE'
].join('\r\n')

const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', TZ_BERLIN, ...events, 'END:VCALENDAR'].join('\r\n')

test('unfoldLines joins continuation lines; parseProperty handles params, quotes and groups', () => {
  assert.deepEqual(unfoldLines('SUMMARY:Long\r\n  title\r\nX:1'), ['SUMMARY:Long title', 'X:1'])
  const p = parseProperty('ATTENDEE;CN="Doe, Jane";RSVP=TRUE:mailto:jane@example.test')
  assert.equal(p.name, 'ATTENDEE')
  assert.equal(p.params.CN, 'Doe, Jane')
  assert.equal(p.value, 'mailto:jane@example.test')
  assert.equal(parseProperty('item1.EMAIL;type=INTERNET:a@b.test').name, 'EMAIL')
})

test('parseEvents reads the VEVENT DTSTART, never the VTIMEZONE one, and unescapes text', () => {
  const [ev] = parseEvents(cal(
    'BEGIN:VEVENT', 'UID:a1', 'DTSTART;TZID=Europe/Berlin:20261120T100000', 'DTEND;TZID=Europe/Berlin:20261120T113000',
    'SUMMARY;LANGUAGE=de:Grüße\\, Team', 'DESCRIPTION:Zeile 1\\nZeile 2 mit \\\\n', 'END:VEVENT'))
  assert.equal(ev.uid, 'a1')
  assert.equal(ev.dtstart.y, 2026)
  assert.equal(ev.dtstart.tzid, 'Europe/Berlin')
  assert.equal(ev.summary, 'Grüße, Team')
  assert.equal(ev.description, 'Zeile 1\nZeile 2 mit \\n')
})

test('TZID times become UTC instants (DST aware); all-day and floating stay as they are', () => {
  assert.equal(formatForClient(parseDateValue('20261120T100000', { TZID: 'Europe/Berlin' })), '20261120T090000Z') // CET
  assert.equal(formatForClient(parseDateValue('20260720T100000', { TZID: 'Europe/Berlin' })), '20260720T080000Z') // CEST
  assert.equal(formatForClient(parseDateValue('20261120', { VALUE: 'DATE' })), '20261120')
  assert.equal(formatForClient(parseDateValue('20261120T100000')), '20261120T100000')
  assert.equal(formatForClient(parseDateValue('20261120T100000', { TZID: 'Not/AZone' })), '20261120T100000')
})

test('expandForRange: weekly series shows every occurrence in range, EXDATE skipped, COUNT honoured', () => {
  const ics = cal('BEGIN:VEVENT', 'UID:w1', 'DTSTART;TZID=Europe/Berlin:20261005T090000', 'DTEND;TZID=Europe/Berlin:20261005T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8', 'EXDATE;TZID=Europe/Berlin:20261109T090000', 'SUMMARY:Standup', 'END:VEVENT')
  const occ = expandForRange(ics, boundToMs('2026-11-01'), boundToMs('2026-11-30', true))
  // Oct 5..Nov 23 = 8 Mondays; November: 2, 9 (excluded), 16, 23
  assert.deepEqual(occ.map(o => o.start), ['20261102T080000Z', '20261116T080000Z', '20261123T080000Z'])
  assert.ok(occ.every(o => o.recurring && o.end))
})

test('expandForRange: RECURRENCE-ID override replaces its occurrence', () => {
  const ics = cal(
    'BEGIN:VEVENT', 'UID:d1', 'DTSTART:20261110T120000Z', 'DTEND:20261110T130000Z', 'RRULE:FREQ=DAILY;UNTIL=20261112T120000Z', 'SUMMARY:Lunch', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d1', 'RECURRENCE-ID:20261111T120000Z', 'DTSTART:20261111T140000Z', 'DTEND:20261111T150000Z', 'SUMMARY:Late lunch', 'END:VEVENT')
  const occ = expandForRange(ics, boundToMs('2026-11-01'), boundToMs('2026-11-30', true))
  assert.deepEqual(occ.map(o => [o.start, o.summary]).sort(), [
    ['20261110T120000Z', 'Lunch'], ['20261111T140000Z', 'Late lunch'], ['20261112T120000Z', 'Lunch']
  ])
})

test('expandForRange: monthly by nth weekday and yearly all-day', () => {
  const m = expandForRange(cal('BEGIN:VEVENT', 'UID:m', 'DTSTART:20260101T180000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:x', 'END:VEVENT'),
    boundToMs('2026-11-01'), boundToMs('2026-11-30', true))
  assert.deepEqual(m.map(o => o.start), ['20261127T180000Z'])
  const y = expandForRange(cal('BEGIN:VEVENT', 'UID:y', 'DTSTART;VALUE=DATE:20200314', 'DTEND;VALUE=DATE:20200315', 'RRULE:FREQ=YEARLY', 'SUMMARY:Bday', 'END:VEVENT'),
    boundToMs('2026-03-01'), boundToMs('2026-03-31', true))
  assert.deepEqual(y.map(o => [o.start, o.end, o.allDay]), [['20260314', '20260315', true]])
})

test('expandForRange: a non-recurring multi-day event overlapping the range start is kept', () => {
  const occ = expandForRange(cal('BEGIN:VEVENT', 'UID:t', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261103', 'SUMMARY:Trip', 'END:VEVENT'),
    boundToMs('2026-11-01'), boundToMs('2026-11-30', true))
  assert.equal(occ.length, 1)
  assert.equal(occ[0].recurring, false)
})

test('splitIcsByUid groups overrides with their master, keeps escapes and adds the VTIMEZONE used', () => {
  const ics = cal(
    'BEGIN:VEVENT', 'UID:s1', 'DTSTART;TZID=Europe/Berlin:20261110T120000', 'RRULE:FREQ=DAILY;COUNT=3', 'DESCRIPTION:a\\nb\\, c', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID;TZID=Europe/Berlin:20261111T120000', 'DTSTART;TZID=Europe/Berlin:20261111T150000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s2', 'DTSTART:20261112T120000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261113T120000Z', 'SUMMARY:no uid', 'END:VEVENT')
  const parts = splitIcsByUid(ics)
  assert.equal(parts.length, 3)
  const s1 = parts.find(p => p.uid === 's1')
  assert.equal((s1.ics.match(/BEGIN:VEVENT/g) || []).length, 2)
  assert.match(s1.ics, /BEGIN:VTIMEZONE[\s\S]*TZID:Europe\/Berlin/)
  assert.match(s1.ics, /DESCRIPTION:a\\nb\\, c/)
  const s2 = parts.find(p => p.uid === 's2')
  assert.doesNotMatch(s2.ics, /VTIMEZONE/)
  const anon = parts.find(p => p.uid.startsWith('leoposta-import-'))
  assert.match(anon.ics, new RegExp(`UID:${anon.uid}`))
})

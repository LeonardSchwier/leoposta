import { describe, it, expect } from 'vitest'
import { patchEventICS } from '../lib/icsPatch'

const VTZ = ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE']
const series = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', ...VTZ,
  'BEGIN:VEVENT', 'UID:s1', 'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Berlin:20260105T090000', 'DTEND;TZID=Europe/Berlin:20260105T093000',
  'RRULE:FREQ=WEEKLY;COUNT=10', 'EXDATE;TZID=Europe/Berlin:20260119T090000',
  'SUMMARY:Standup', 'CATEGORIES:work', 'ORGANIZER:mailto:boss@x.test',
  'ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@x.test',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID;TZID=Europe/Berlin:20260112T090000', 'DTSTART;TZID=Europe/Berlin:20260112T100000', 'DTEND;TZID=Europe/Berlin:20260112T103000', 'SUMMARY:Standup (late)', 'END:VEVENT',
  'END:VCALENDAR', ''
].join('\r\n')

// Occurrence of 26 Jan 09:00 Berlin = 08:00Z, as the server lists it.
const occ = { occurrenceStart: '20260126T080000Z', start: '20260126T080000Z', end: '20260126T083000Z' }

describe('patchEventICS', () => {
  it('renaming one occurrence keeps the series start, TZID, RRULE, EXDATE, overrides, alarms and other properties', () => {
    const out = patchEventICS(series, 's1', { ...occ, summary: 'Daily sync', location: '', description: '', attendees: ['ann@x.test'], allDay: false })!
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20260105T090000')
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20260105T093000')
    for (const keep of ['RRULE:FREQ=WEEKLY;COUNT=10', 'EXDATE;TZID=Europe/Berlin:20260119T090000', 'BEGIN:VTIMEZONE', 'CATEGORIES:work', 'ORGANIZER:mailto:boss@x.test',
      'ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@x.test', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'RECURRENCE-ID;TZID=Europe/Berlin:20260112T090000', 'SUMMARY:Standup (late)']) {
      expect(out).toContain(keep)
    }
    expect(out).toContain('SUMMARY:Daily sync')
    expect(out).not.toContain('SUMMARY:Standup\r\n')
    expect(out).toContain('SEQUENCE:1')
    expect(out.match(/^BEGIN:VEVENT/gm)).toHaveLength(2)
    expect(out.match(/^DTSTAMP/gm)).toHaveLength(1)
  })
  it('moving an occurrence by an hour moves the series by an hour in its own zone', () => {
    const out = patchEventICS(series, 's1', { summary: 'Standup', location: '', description: '', allDay: false, occurrenceStart: occ.occurrenceStart, start: '20260126T090000Z', end: '20260126T100000Z' })!
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20260105T100000')
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20260105T110000')
  })
  it('all-day: moving by two days shifts the DATE values', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'DTSTART;VALUE=DATE:20260310', 'DTEND;VALUE=DATE:20260312', 'SUMMARY:Trip', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const out = patchEventICS(ics, 'a', { summary: 'Trip', location: '', description: '', allDay: true, occurrenceStart: '20260310', start: '20260312', end: '20260315' })!
    expect(out).toContain('DTSTART;VALUE=DATE:20260312')
    expect(out).toContain('DTEND;VALUE=DATE:20260315')
  })
  it('timed -> all-day writes DATE values; text is escaped; a missing VEVENT gives null', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:t', 'DTSTART:20260310T100000Z', 'DURATION:PT1H', 'SUMMARY:x', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const out = patchEventICS(ics, 't', { summary: 'a, b; c', location: 'l\nm', description: '', allDay: true, occurrenceStart: '20260310T100000Z', start: '20260310', end: '20260311' })!
    expect(out).toContain('DTSTART;VALUE=DATE:20260310')
    expect(out).toContain('DTEND;VALUE=DATE:20260311')
    expect(out).not.toContain('DURATION')
    expect(out).toContain('SUMMARY:a\\, b\\; c')
    expect(out).toContain('LOCATION:l\\nm')
    expect(patchEventICS(ics, 'other', { summary: '', location: '', description: '', allDay: false, occurrenceStart: '', start: '20260310T100000Z', end: '20260310T110000Z' })).toBeNull()
  })
})

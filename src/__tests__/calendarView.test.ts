import { describe, it, expect } from 'vitest'
import { icsToDate, eventOnDay, isAllDay, timeLabel, localToIcsUtc, icsToLocalParts, dateToIcsDate, weekDays, monthGrid } from '../lib/calendarView'

describe('calendarView', () => {
  it('parses all-day, UTC and floating values', () => {
    expect(icsToDate('20260314')?.getTime()).toBe(new Date(2026, 2, 14).getTime())
    expect(icsToDate('20260314T093000Z')?.getTime()).toBe(Date.UTC(2026, 2, 14, 9, 30, 0))
    expect(icsToDate('20260314T093000')?.getTime()).toBe(new Date(2026, 2, 14, 9, 30, 0).getTime())
    expect(icsToDate('garbage')).toBeNull()
  })
  it('an all-day event covers its days with an exclusive end', () => {
    const ev = { start: '20260314', end: '20260316' }
    expect(isAllDay(ev)).toBe(true)
    expect(timeLabel(ev)).toBe('')
    expect(eventOnDay(ev, '2026-03-14')).toBe(true)
    expect(eventOnDay(ev, '2026-03-15')).toBe(true)
    expect(eventOnDay(ev, '2026-03-16')).toBe(false)
  })
  it('a timed event round-trips editor local time through UTC', () => {
    const utc = localToIcsUtc('2026-03-14', '09:30')
    expect(icsToLocalParts(utc)).toEqual({ date: '2026-03-14', time: '09:30' })
    const ev = { start: utc, end: localToIcsUtc('2026-03-14', '10:00') }
    expect(timeLabel(ev)).toBe('09:30')
    expect(eventOnDay(ev, '2026-03-14')).toBe(true)
    expect(eventOnDay(ev, '2026-03-15')).toBe(false)
  })
  it('a zero-length event appears on its start day only', () => {
    const s = localToIcsUtc('2026-03-14', '23:00')
    expect(eventOnDay({ start: s, end: s }, '2026-03-14')).toBe(true)
    expect(eventOnDay({ start: s, end: s }, '2026-03-15')).toBe(false)
  })
  it('date helpers', () => {
    expect(dateToIcsDate('2026-12-31', 1)).toBe('20270101')
    const w = weekDays(new Date(2026, 10, 14)) // Saturday
    expect(w[0].getDay()).toBe(1)
    expect(w).toHaveLength(7)
    const g = monthGrid(new Date(2026, 10, 1))
    expect(g).toHaveLength(42)
    expect(g[0].date.getDay()).toBe(1)
    expect(g.filter(c => c.inMonth)).toHaveLength(30)
  })
})

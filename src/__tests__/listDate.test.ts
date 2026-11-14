import { describe, it, expect } from 'vitest'
import { formatListDate, calendarDaysBetween } from '../lib/listDate'

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi)

describe('formatListDate', () => {
  const now = at(2026, 11, 14, 8, 0)

  it('shows a time for a message from earlier today', () => {
    expect(formatListDate(at(2026, 11, 14, 0, 5).toISOString(), now, 'en-US')).toMatch(/12:05\s?AM/)
  })

  it('says Yesterday for 23:55 yesterday although it is less than 24 h ago', () => {
    expect(formatListDate(at(2026, 11, 13, 23, 55).toISOString(), now, 'en-US')).toBe('Yesterday')
  })

  it('says Yesterday for 00:05 yesterday although it is more than 24 h ago', () => {
    expect(formatListDate(at(2026, 11, 13, 0, 5).toISOString(), at(2026, 11, 14, 23, 0), 'en-US')).toBe('Yesterday')
  })

  it('shows the weekday within the last week, then the date', () => {
    expect(formatListDate(at(2026, 11, 10).toISOString(), now, 'en-US')).toBe('Tue')
    expect(formatListDate(at(2026, 10, 1).toISOString(), now, 'en-US')).toBe('Oct 1')
  })

  it('adds the year for an older year', () => {
    expect(formatListDate(at(2025, 12, 24).toISOString(), now, 'en-US')).toBe('Dec 24, 2025')
  })

  it('shows a time for a date later today (sender clock ahead) instead of a weekday', () => {
    expect(formatListDate(at(2026, 11, 14, 9, 30).toISOString(), now, 'en-US')).toMatch(/09:30\s?AM/)
  })

  it('returns empty for a missing or invalid date', () => {
    expect(formatListDate('', now)).toBe('')
    expect(formatListDate('not a date', now)).toBe('')
  })

  it('counts calendar days across a DST change', () => {
    expect(calendarDaysBetween(at(2026, 3, 28, 23), at(2026, 3, 29, 1))).toBe(1)
  })
})

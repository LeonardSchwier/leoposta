/**
 * The date column of the message list. "Today" and "Yesterday" are calendar
 * days in the user's time zone, not 24-hour spans: a message from 23:55
 * yesterday is "Yesterday" at 08:00 today, not a bare time.
 */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Whole calendar days between two instants in local time (DST-safe). */
export function calendarDaysBetween(earlier: Date, later: Date): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / 86_400_000)
}

export function formatListDate(dateStr: string, now: Date = new Date(), locale?: string): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return ''
  const days = calendarDaysBetween(date, now)
  // Today, including a time later today (a sender's clock running fast).
  if (days === 0) return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return date.toLocaleDateString(locale, { weekday: 'short' })
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}

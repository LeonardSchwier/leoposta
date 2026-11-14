// Calendar (CalDAV) against the stack's Radicale: discovery, month / week
// navigation, create / edit / delete (checked on the server), all-day and
// timed events, a TZID event shown in the browser's zone, a recurring
// series, creating/editing repeating events with the Repeat control, .ics
// import, and the not-configured / unreachable states.
import { test, expect, TOKEN, accountBody } from './fixtures'
import { Dav, ics, ymd } from './dav'
import type { Page } from '@playwright/test'

const H = { 'x-leoposta-token': TOKEN }
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// The browser runs in Berlin; events below are written in other zones.
test.use({ timezoneId: 'Europe/Berlin' })

async function openCalendar(app: Page) {
  await app.locator('.sidebar').getByRole('button', { name: /Calendar/ }).click()
  await expect(app.locator('.calendar')).toBeVisible()
}
const cell = (app: Page, d: Date) => app.locator(`.cell[data-date="${iso(d)}"]`)

test.describe('calendar', () => {
  test('discovers calendars; create, edit and delete a timed event on the server', async ({ app, user }) => {
    const dav = new Dav(user)
    const cal = await dav.mkcalendar('personal', 'Personal')
    await dav.mkcalendar('work', 'Work')
    await openCalendar(app)
    await expect(app.locator('.cal-item', { hasText: 'Personal' })).toBeVisible()
    await expect(app.locator('.cal-item', { hasText: 'Work' })).toBeVisible()

    const day = new Date(); day.setDate(12)
    await cell(app, day).click()
    await expect(app.getByRole('heading', { name: 'New event' })).toBeVisible()
    await app.getByLabel('Target calendar').selectOption({ label: 'Personal' })
    await app.getByLabel('Title').fill('Dentist, Dr. Müller')
    await app.getByLabel('Start time').fill('09:30')
    await app.getByLabel('End time').fill('10:15')
    await app.getByLabel('Location').fill('Praxis; 2nd floor')
    await app.getByRole('button', { name: 'Create', exact: true }).click()
    const chip = cell(app, day).locator('.chip', { hasText: 'Dentist, Dr. Müller' })
    await expect(chip).toContainText('09:30')

    let objs = Object.values(await dav.list(cal))
    expect(objs).toHaveLength(1)
    const body = objs[0].replace(/\r?\n[ \t]/g, '')
    expect(body).toContain('SUMMARY:Dentist\\, Dr. Müller')
    expect(body).toContain('LOCATION:Praxis\\; 2nd floor')
    // 09:30 Berlin, stored as an unambiguous UTC instant.
    const startUtc = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 9, 30) - berlinOffsetMin(day) * 60_000)
    expect(body).toContain(`DTSTART:${startUtc.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`)

    // Edit in place
    await chip.click()
    await expect(app.getByRole('heading', { name: 'Edit event' })).toBeVisible()
    await expect(app.getByLabel('Title')).toHaveValue('Dentist, Dr. Müller')
    await expect(app.getByLabel('Start time')).toHaveValue('09:30')
    await app.getByLabel('Title').fill('Dentist moved')
    await app.getByLabel('Start time').fill('11:00')
    await app.getByLabel('End time').fill('11:30')
    await app.getByRole('button', { name: 'Save changes' }).click()
    await expect(cell(app, day).locator('.chip', { hasText: 'Dentist moved' })).toContainText('11:00')
    objs = Object.values(await dav.list(cal))
    expect(objs).toHaveLength(1)
    expect(objs[0]).toContain('SUMMARY:Dentist moved')

    // Move to the other calendar
    await cell(app, day).locator('.chip', { hasText: 'Dentist moved' }).click()
    await app.getByLabel('Target calendar').selectOption({ label: 'Work' })
    await app.getByRole('button', { name: 'Save changes' }).click()
    // Written to Work, then removed from Personal.
    await expect.poll(async () => Object.values(await dav.list(cal)).length).toBe(0)
    await expect(cell(app, day).locator('.chip', { hasText: 'Dentist moved' })).toHaveCount(1)
    expect(Object.values(await dav.list(`${dav.base}work/`))).toHaveLength(1)

    // Delete
    await cell(app, day).locator('.chip', { hasText: 'Dentist moved' }).click()
    app.once('dialog', (d) => d.accept())
    await app.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(cell(app, day).locator('.chip')).toHaveCount(0)
    expect(Object.values(await dav.list(`${dav.base}work/`))).toHaveLength(0)
  })

  test('all-day (multi-day), TZID, UTC and recurring events are placed on the right local days; month/week navigation', async ({ app, user }) => {
    const dav = new Dav(user)
    const cal = await dav.mkcalendar('personal', 'Personal')
    const now = new Date()
    const y = now.getFullYear(), m = now.getMonth()
    const d = (day: number, month = m) => new Date(y, month, day)
    // All-day 3..5 (DTEND exclusive = 6)
    await dav.put(`${cal}allday.ics`, ics('allday-1', [`DTSTART;VALUE=DATE:${ymd(d(3))}`, `DTEND;VALUE=DATE:${ymd(d(6))}`, 'SUMMARY:Holiday trip']), 'text/calendar')
    // 09:00 in New York = 15:00 Berlin, except in the weeks where only one of
    // the two zones is on summer time (from the 2nd Sunday of March, the last
    // Sunday of October): the 2nd of March and the 8th of other months are outside them.
    const nyDay = m === 2 ? 2 : 8
    await dav.put(`${cal}ny.ics`, ics('ny-1', [
      `DTSTART;TZID=America/New_York:${ymd(d(nyDay))}T090000`, `DTEND;TZID=America/New_York:${ymd(d(nyDay))}T100000`, 'SUMMARY:NY call'
    ]), 'text/calendar')
    // 23:30 UTC on the 14th is already the 15th in Berlin.
    await dav.put(`${cal}utc.ics`, ics('utc-1', [`DTSTART:${ymd(d(14))}T233000Z`, `DTEND:${ymd(d(15))}T000000Z`, 'SUMMARY:Late UTC']), 'text/calendar')
    // Weekly on the 1st..: 4 occurrences, one skipped by EXDATE.
    await dav.put(`${cal}weekly.ics`, ics('weekly-1', [
      `DTSTART;VALUE=DATE:${ymd(d(1))}`, 'RRULE:FREQ=WEEKLY;COUNT=4', `EXDATE;VALUE=DATE:${ymd(d(15))}`, 'SUMMARY:Weekly review'
    ]), 'text/calendar')
    // Next month
    await dav.put(`${cal}next.ics`, ics('next-1', [`DTSTART:${ymd(d(10, m + 1))}T100000Z`, `DTEND:${ymd(d(10, m + 1))}T110000Z`, 'SUMMARY:Next month thing']), 'text/calendar')

    await openCalendar(app)
    for (const day of [3, 4, 5]) await expect(cell(app, d(day)).locator('.chip', { hasText: 'Holiday trip' })).toBeVisible()
    await expect(cell(app, d(6)).locator('.chip', { hasText: 'Holiday trip' })).toHaveCount(0)
    await expect(cell(app, d(nyDay)).locator('.chip', { hasText: 'NY call' })).toContainText('15:00')
    await expect(cell(app, d(15)).locator('.chip', { hasText: 'Late UTC' })).toContainText('00:30')
    await expect(cell(app, d(14)).locator('.chip', { hasText: 'Late UTC' })).toHaveCount(0)
    for (const day of [1, 8, 22]) await expect(cell(app, d(day)).locator('.chip', { hasText: 'Weekly review' })).toContainText('↻')
    await expect(cell(app, d(15)).locator('.chip', { hasText: 'Weekly review' })).toHaveCount(0)
    await expect(cell(app, d(29)).locator('.chip', { hasText: 'Weekly review' })).toHaveCount(0)

    // Month navigation
    const title = app.getByTestId('cal-title')
    const monthName = (mm: number) => new Date(y, mm, 1).toLocaleString('en-US', { month: 'long' })
    await expect(title).toHaveText(`${monthName(m)} ${y}`)
    await app.getByRole('button', { name: 'Next month' }).click()
    await expect(title).toHaveText(`${monthName((m + 1) % 12)} ${m === 11 ? y + 1 : y}`)
    await expect(cell(app, d(10, m + 1)).locator('.chip', { hasText: 'Next month thing' })).toBeVisible()
    await app.getByRole('button', { name: 'Previous month' }).click()
    await expect(title).toHaveText(`${monthName(m)} ${y}`)

    // Week view around the 3rd: the all-day trip, then next week has the NY call or not.
    await app.getByRole('button', { name: 'Today' }).click()
    await app.getByRole('button', { name: 'Week', exact: true }).click()
    await expect(app.locator('.grid.week .cell')).toHaveCount(7)
    const todayCell = cell(app, now)
    await expect(todayCell).toBeVisible()
    await app.getByRole('button', { name: 'Next week' }).click()
    const nextWeek = new Date(y, m, now.getDate() + 7)
    await expect(cell(app, nextWeek)).toBeVisible()
    await expect(cell(app, now)).toHaveCount(0)
    await app.getByRole('button', { name: 'Previous week' }).click()
    await expect(cell(app, now)).toBeVisible()
  })

  test('creates an all-day event and edits one occurrence of a series without losing the rule', async ({ app, user }) => {
    const dav = new Dav(user)
    const cal = await dav.mkcalendar('personal', 'Personal')
    const now = new Date()
    const d = (day: number) => new Date(now.getFullYear(), now.getMonth(), day)
    await dav.put(`${cal}series.ics`, ics('series-1', [`DTSTART:${ymd(d(2))}T080000Z`, `DTEND:${ymd(d(2))}T083000Z`, 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Standup']), 'text/calendar')
    await openCalendar(app)

    await app.getByRole('button', { name: '+ New event' }).click()
    await app.getByLabel('Title').fill('Conference')
    await app.getByLabel('All-day').check()
    await app.getByLabel('Start', { exact: true }).fill(iso(d(20)))
    await app.getByLabel('End', { exact: true }).fill(iso(d(21)))
    await app.getByRole('button', { name: 'Create', exact: true }).click()
    for (const day of [20, 21]) await expect(cell(app, d(day)).locator('.chip', { hasText: 'Conference' })).toBeVisible()
    await expect(cell(app, d(22)).locator('.chip', { hasText: 'Conference' })).toHaveCount(0)
    const conf = Object.values(await dav.list(cal)).find((o) => o.includes('Conference'))!
    expect(conf).toContain(`DTSTART;VALUE=DATE:${ymd(d(20))}`)
    expect(conf).toContain(`DTEND;VALUE=DATE:${ymd(d(22))}`)

    await cell(app, d(9)).locator('.chip', { hasText: 'Standup' }).click()
    await expect(app.getByText('This is a repeating event')).toBeVisible()
    await app.getByLabel('Title').fill('Standup (renamed)')
    await app.getByRole('button', { name: 'Save changes' }).click()
    for (const day of [2, 9, 16]) await expect(cell(app, d(day)).locator('.chip', { hasText: 'Standup (renamed)' })).toBeVisible()
    const objs = Object.values(await dav.list(cal))
    expect(objs).toHaveLength(2)
    const series = objs.find((o) => o.includes('series-1'))!
    expect(series).toContain('RRULE:FREQ=WEEKLY;COUNT=3')
    expect(series).toContain(`DTSTART:${ymd(d(2))}T080000Z`) // the series start, not the clicked occurrence
  })

  test('creates a weekly Mon/Wed series with COUNT, edits it to monthly with UNTIL, then to Never', async ({ app, user }) => {
    test.setTimeout(150_000)
    const dav = new Dav(user)
    const cal = await dav.mkcalendar('personal', 'Personal')
    const now = new Date()
    const y = now.getFullYear(), m = now.getMonth()
    // The first Monday of this month: all four occurrences stay in this month's grid.
    const first = new Date(y, m, 1)
    const mon = new Date(y, m, 1 + ((8 - first.getDay()) % 7))
    const plus = (n: number) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + n)
    const veventOf = async () => {
      const objs = Object.values(await dav.list(cal))
      expect(objs).toHaveLength(1)
      const body = objs[0].replace(/\r?\n[ \t]/g, '')
      return { body, vevent: body.slice(body.indexOf('BEGIN:VEVENT')) }
    }
    await openCalendar(app)
    await expect(app.locator('.cal-item', { hasText: 'Personal' })).toBeVisible()

    await cell(app, mon).click()
    await expect(app.getByRole('heading', { name: 'New event' })).toBeVisible()
    await app.getByLabel('Title').fill('Gym')
    await app.getByLabel('Start time').fill('09:00')
    await app.getByLabel('End time').fill('09:45')
    await app.getByLabel('Repeat', { exact: true }).selectOption('WEEKLY')
    await expect(app.getByLabel('Monday')).toBeChecked() // the event's weekday
    await expect(app.getByLabel('Wednesday')).not.toBeChecked()
    await app.getByLabel('Wednesday').focus()
    await app.keyboard.press('Space') // keyboard-operable
    await expect(app.getByLabel('Wednesday')).toBeChecked()
    await app.getByLabel('Ends').selectOption('count')
    await app.getByLabel('Occurrences').fill('4')
    await app.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(app.getByTestId('toast')).toContainText('Event created')

    // On the server: a local-time series with its zone.
    let { body, vevent } = await veventOf()
    expect(vevent).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')
    expect(vevent).toContain(`DTSTART;TZID=Europe/Berlin:${ymd(mon)}T090000`)
    expect(vevent).toContain(`DTEND;TZID=Europe/Berlin:${ymd(mon)}T094500`)
    expect(body).toMatch(/BEGIN:VTIMEZONE\r?\nTZID:Europe\/Berlin/)
    expect(body.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(body.indexOf('BEGIN:VEVENT'))

    // Month view: Mon, Wed, Mon, Wed at 09:00 local — and nothing after COUNT.
    for (const n of [0, 2, 7, 9]) await expect(cell(app, plus(n)).locator('.chip', { hasText: 'Gym' })).toContainText('09:00')
    for (const n of [0, 2, 7, 9]) await expect(cell(app, plus(n)).locator('.chip', { hasText: 'Gym' })).toContainText('↻')
    for (const n of [1, 3, 14, 16]) await expect(cell(app, plus(n)).locator('.chip', { hasText: 'Gym' })).toHaveCount(0)

    // Week view, the series' two weeks.
    await app.getByRole('button', { name: 'Week', exact: true }).click()
    const weekMon = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
    const weeks = Math.round((mon.getTime() - weekMon(now).getTime()) / (7 * 86_400_000))
    for (let i = 0; i < Math.abs(weeks); i++) await app.getByRole('button', { name: weeks > 0 ? 'Next week' : 'Previous week' }).click()
    await expect(cell(app, mon)).toBeVisible()
    await expect(cell(app, mon).locator('.chip', { hasText: 'Gym' })).toContainText('09:00')
    await expect(cell(app, plus(2)).locator('.chip', { hasText: 'Gym' })).toContainText('09:00')
    await expect(cell(app, plus(1)).locator('.chip', { hasText: 'Gym' })).toHaveCount(0)
    await app.getByRole('button', { name: 'Next week' }).click()
    await expect(cell(app, plus(7)).locator('.chip', { hasText: 'Gym' })).toContainText('09:00')
    await expect(cell(app, plus(9)).locator('.chip', { hasText: 'Gym' })).toContainText('09:00')
    await app.getByRole('button', { name: 'Next week' }).click()
    await expect(cell(app, plus(14))).toBeVisible()
    await expect(cell(app, plus(14)).locator('.chip', { hasText: 'Gym' })).toHaveCount(0)
    await app.getByRole('button', { name: 'Month', exact: true }).click()
    await app.getByRole('button', { name: 'Today' }).click()

    // Edit from the third occurrence: the control shows the rule; make it monthly until next month.
    await cell(app, plus(7)).locator('.chip', { hasText: 'Gym' }).click()
    await expect(app.getByRole('heading', { name: 'Edit event' })).toBeVisible()
    await expect(app.getByLabel('Repeat', { exact: true })).toHaveValue('WEEKLY')
    await expect(app.getByLabel('Monday')).toBeChecked()
    await expect(app.getByLabel('Wednesday')).toBeChecked()
    await expect(app.getByLabel('Ends')).toHaveValue('count')
    await expect(app.getByLabel('Occurrences')).toHaveValue('4')
    await app.getByLabel('Repeat', { exact: true }).selectOption('MONTHLY')
    // Anchored to the series start, not to the opened occurrence.
    await expect(app.getByLabel('Repeat', { exact: true }).locator('option:checked')).toHaveText(`Monthly (day ${mon.getDate()})`)
    await app.getByLabel('Ends').selectOption('until')
    const untilDay = new Date(y, m + 1, mon.getDate())
    await app.getByLabel('Repeat until').fill(iso(untilDay))
    await app.getByRole('button', { name: 'Save changes' }).click()
    await expect(app.getByTestId('toast')).toContainText('Event updated')
    ;({ body, vevent } = await veventOf())
    // UNTIL: the end of that day in Berlin, in UTC.
    const untilUtc = new Date(Date.UTC(untilDay.getFullYear(), untilDay.getMonth(), untilDay.getDate(), 23, 59, 59) - berlinOffsetMin(untilDay) * 60_000)
    expect(vevent).toContain(`RRULE:FREQ=MONTHLY;UNTIL=${untilUtc.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`)
    expect(vevent).not.toContain('FREQ=WEEKLY')
    expect(vevent).toContain(`DTSTART;TZID=Europe/Berlin:${ymd(mon)}T090000`) // the series start stays
    await expect(cell(app, mon).locator('.chip', { hasText: 'Gym' })).toContainText('09:00')
    for (const n of [2, 7, 9]) await expect(cell(app, plus(n)).locator('.chip', { hasText: 'Gym' })).toHaveCount(0)
    await app.getByRole('button', { name: 'Next month' }).click()
    await expect(cell(app, untilDay).locator('.chip', { hasText: 'Gym' })).toContainText('09:00')
    await app.getByRole('button', { name: 'Next month' }).click()
    await expect(cell(app, new Date(y, m + 2, mon.getDate()))).toBeVisible()
    await expect(cell(app, new Date(y, m + 2, mon.getDate())).locator('.chip', { hasText: 'Gym' })).toHaveCount(0)
    await app.getByRole('button', { name: 'Today' }).click()

    // Never: a single event, no rule left on the server, no more repetitions.
    await cell(app, mon).locator('.chip', { hasText: 'Gym' }).click()
    await expect(app.getByLabel('Repeat', { exact: true })).toHaveValue('MONTHLY')
    await expect(app.getByLabel('Ends')).toHaveValue('until')
    await expect(app.getByLabel('Repeat until')).toHaveValue(iso(untilDay))
    await app.getByLabel('Repeat', { exact: true }).selectOption('NONE')
    await expect(app.getByLabel('Ends')).toHaveCount(0)
    await app.getByRole('button', { name: 'Save changes' }).click()
    await expect(app.getByTestId('toast')).toContainText('Event updated')
    ;({ vevent } = await veventOf())
    expect(vevent).not.toContain('RRULE')
    expect(vevent).toContain(`DTSTART;TZID=Europe/Berlin:${ymd(mon)}T090000`)
    const chip = cell(app, mon).locator('.chip', { hasText: 'Gym' })
    await expect(chip).toContainText('09:00')
    await expect(chip).not.toContainText('↻')
    await app.getByRole('button', { name: 'Next month' }).click()
    await expect(cell(app, untilDay)).toBeVisible()
    await expect(cell(app, untilDay).locator('.chip', { hasText: 'Gym' })).toHaveCount(0)
  })

  test('creates an all-day yearly event ending on a date; a rule the control cannot show stays as it is', async ({ app, user }) => {
    test.setTimeout(150_000)
    const dav = new Dav(user)
    const cal = await dav.mkcalendar('personal', 'Personal')
    const now = new Date()
    const y = now.getFullYear(), m = now.getMonth()
    const day = new Date(y, m, 10)
    // Monthly on the first Monday: BYSETPOS is beyond the control.
    const firstMon = new Date(y, m, 1 + ((8 - new Date(y, m, 1).getDay()) % 7))
    await dav.put(`${cal}custom.ics`, ics('custom-1', [`DTSTART:${ymd(firstMon)}T120000Z`, `DTEND:${ymd(firstMon)}T130000Z`, 'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', 'SUMMARY:First Monday']), 'text/calendar')
    await openCalendar(app)
    await expect(app.locator('.cal-item', { hasText: 'Personal' })).toBeVisible()

    await cell(app, day).click()
    await app.getByLabel('Title').fill('Anniversary')
    await app.getByLabel('All-day').check()
    await app.getByLabel('Repeat', { exact: true }).selectOption('YEARLY')
    await app.getByLabel('Ends').selectOption('until')
    const until = new Date(y + 1, m, 10)
    await app.getByLabel('Repeat until').fill(iso(until))
    await app.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(app.getByTestId('toast')).toContainText('Event created')
    const ann = Object.values(await dav.list(cal)).find((o) => o.includes('Anniversary'))!
    expect(ann).toContain(`DTSTART;VALUE=DATE:${ymd(day)}`)
    expect(ann).toContain(`RRULE:FREQ=YEARLY;UNTIL=${ymd(until)}`)
    expect(ann).not.toContain('VTIMEZONE')
    await expect(cell(app, day).locator('.chip', { hasText: 'Anniversary' })).toContainText('↻')

    // The custom rule: shown read-only, untouched by an edit of the title.
    await cell(app, firstMon).locator('.chip', { hasText: 'First Monday' }).click()
    await expect(app.getByLabel('Repeat', { exact: true })).toHaveValue('CUSTOM')
    await expect(app.getByTestId('custom-repeat')).toContainText('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1')
    await app.getByLabel('Title').fill('First Monday lunch')
    await app.getByRole('button', { name: 'Save changes' }).click()
    await expect(app.getByTestId('toast')).toContainText('Event updated')
    const custom = Object.values(await dav.list(cal)).find((o) => o.includes('custom-1'))!
    expect(custom).toContain('RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1')
    expect(custom).toContain('SUMMARY:First Monday lunch')

    // Next year: the last occurrence (the UNTIL date); the year after: none.
    for (let i = 0; i < 12; i++) await app.getByRole('button', { name: 'Next month' }).click()
    await expect(app.getByTestId('cal-title')).toContainText(String(y + 1))
    await expect(cell(app, until).locator('.chip', { hasText: 'Anniversary' })).toBeVisible()
    for (let i = 0; i < 12; i++) await app.getByRole('button', { name: 'Next month' }).click()
    await expect(cell(app, new Date(y + 2, m, 10))).toBeVisible()
    await expect(cell(app, new Date(y + 2, m, 10)).locator('.chip', { hasText: 'Anniversary' })).toHaveCount(0)
  })

  test('imports an .ics with several events', async ({ app, user }) => {
    const dav = new Dav(user)
    const cal = await dav.mkcalendar('personal', 'Personal')
    const now = new Date()
    const d = (day: number) => ymd(new Date(now.getFullYear(), now.getMonth(), day))
    const file = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//e2e//EN',
      'BEGIN:VEVENT', 'UID:imp-a', 'DTSTAMP:20260101T000000Z', `DTSTART;VALUE=DATE:${d(11)}`, 'SUMMARY:Imported A', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:imp-b', 'DTSTAMP:20260101T000000Z', `DTSTART:${d(13)}T120000Z`, `DTEND:${d(13)}T130000Z`, 'SUMMARY:Imported B – ünïcode', 'END:VEVENT',
      'END:VCALENDAR', ''].join('\r\n')
    await openCalendar(app)
    await expect(app.locator('.cal-item', { hasText: 'Personal' })).toBeVisible()
    await app.locator('input[type=file][accept*=".ics"]').setInputFiles({ name: 'events.ics', mimeType: 'text/calendar', buffer: Buffer.from(file, 'utf8') })
    await expect(app.getByTestId('toast')).toContainText('Imported 2 of 2')
    await expect(app.locator('.chip', { hasText: 'Imported A' })).toBeVisible()
    await expect(app.locator('.chip', { hasText: 'Imported B – ünïcode' })).toBeVisible()
    expect(Object.values(await dav.list(cal))).toHaveLength(2)
  })

  test('an account without CalDAV shows "not set up" instead of errors', async ({ page, request, baseURL, user, mailbox }) => {
    void mailbox
    for (const x of await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()) await request.delete(`${baseURL}/api/accounts/${encodeURIComponent(x.email)}`, { headers: H })
    expect((await request.post(`${baseURL}/api/accounts`, { headers: H, data: accountBody(user, { davUrl: '' }) })).status()).toBe(200)
    await page.goto('/')
    await openCalendar(page)
    await expect(page.getByTestId('dav-not-configured')).toContainText('Calendar is not set up')
  })

  test.describe('unreachable server', () => {
    test.use({ allowApiErrors: [['/api/calendar/calendars -> 502', /status of 502/], { scope: 'test' }] })
    test('shows a clear message, no crash, and Retry recovers once the URL is fixed', async ({ page, request, baseURL, user, mailbox }) => {
      void mailbox
      for (const x of await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()) await request.delete(`${baseURL}/api/accounts/${encodeURIComponent(x.email)}`, { headers: H })
      expect((await request.post(`${baseURL}/api/accounts`, { headers: H, data: accountBody(user, { davUrl: 'http://127.0.0.1:9/' }) })).status()).toBe(200)
      await new Dav(user).mkcalendar('personal', 'Personal')
      await page.goto('/')
      await openCalendar(page)
      const err = page.locator('.cal-err')
      await expect(err).toContainText('Cannot reach the CalDAV server 127.0.0.1:9')
      expect((await request.put(`${baseURL}/api/accounts/${encodeURIComponent(user)}`, { headers: H, data: { davUrl: accountBody(user).davUrl } })).status()).toBe(200)
      await err.getByRole('button', { name: 'Retry' }).click()
      await expect(err).toHaveCount(0)
      await expect(page.locator('.cal-item', { hasText: 'Personal' })).toBeVisible()
    })
  })
})

/** Minutes Berlin is ahead of UTC on that local day (60 or 120). */
function berlinOffsetMin(day: Date): number {
  const probe = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 12))
  const berlin = new Date(probe.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }))
  return Math.round((berlin.getTime() - utc.getTime()) / 60_000)
}

import { Router } from 'express'
import { resolveAccount, state, invalidateAccountDavCache } from '../lib/state.js'
import { davRequest, resolveDavBase, extractResponseSet, extractDataBlocks, isCalendarResource, joinDavPath, toDavTime } from '../lib/dav.js'
import { TTL_LONG } from '../lib/davcache.js'

const router = Router()

// GET /api/calendar/calendars
router.get('/calendar/calendars', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    const profindXml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:calendar-timezone/>
  </d:prop>
</d:propfind>`
    const r = await davRequest('PROPFIND', basePath, profindXml, null, acct)
    const entries = extractResponseSet(r.body)
    // Drop the home-set root itself (href === basePath) AND any sibling
    // collection that is not a real user-calendar (RFC 6746
    // schedule-inbox / schedule-outbox) — REPORT on those 403s.
    const calendars = entries.filter(e =>
      e.displayname &&
      e.href !== basePath &&
      isCalendarResource(e)
    )
    res.json({ calendars })
  } catch (err) {
    console.error('CalDAV calendars error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/calendar/events
router.get('/calendar/events', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const { calendar } = req.query
    if (!calendar) return res.status(400).json({ error: 'calendar param required' })
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    const startDav = toDavTime(req.query.start)
    const endDav = toDavTime(req.query.end, true)
    const timeRange = (startDav || endDav)
      ? `<c:time-range${startDav ? ` start="${startDav}"` : ''}${endDav ? ` end="${endDav}"` : ''}/>`
      : ''
    const report = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        ${timeRange}
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`
    const urlPath = joinDavPath(basePath, calendar) + '/'
    const cacheKey = `events|${acct.id}|${calendar}|${req.query.start || ''}|${req.query.end || ''}`
    const cached = state.davCache.get(cacheKey)
    if (cached) return res.json(cached)
    const r = await davRequest('REPORT', urlPath, report, null, acct, 1)
    const blocks = extractDataBlocks(r.body, 'calendar-data')
    const events = blocks.map(b => {
      const ics = b.body
      const uid = (ics.match(/UID:(.+)/) || [])[1] || b.href
      const summary = (ics.match(/SUMMARY:(.+)/) || [])[1] || '(no subject)'
      const dtstart = (ics.match(/DTSTART[^:]*:(.+)/) || [])[1] || ''
      const dtend = (ics.match(/DTEND[^:]*:(.+)/) || [])[1] || ''
      const location = (ics.match(/LOCATION:(.+)/) || [])[1] || ''
      const description = (ics.match(/DESCRIPTION:(.+)/) || [])[1] || ''
      const attendees = []
      const reAtt = /ATTENDEE[^:]*mailto:([^;\s\r\n]+)/g
      let m
      while ((m = reAtt.exec(ics)) !== null) {
        const addr = m[1].trim()
        if (addr) attendees.push(addr)
      }
      return { uid: uid.trim(), summary: summary.trim(), start: dtstart.trim(), end: dtend.trim(), location: location.trim(), description: description.trim(), attendees, etag: b.etag || '', href: b.href, ics }
    })
    const payload = { events }
    state.davCache.set(cacheKey, payload, TTL_LONG)
    res.json(payload)
  } catch (err) {
    console.error('CalDAV events error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/calendar/event
router.put('/calendar/event', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const { calendar, ics, uid } = req.body || {}
    if (!calendar || !ics) return res.status(400).json({ error: 'calendar and ics required' })
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    const fileUid = uid || Date.now()
    const urlPath = joinDavPath(basePath, calendar) + `/${fileUid}.ics`
    const r = await davRequest('PUT', urlPath, ics, 'text/calendar; charset=utf-8', acct)
    invalidateAccountDavCache(acct.id)
    res.json({ success: true, uid: fileUid, etag: r.headers.etag || '' })
  } catch (err) {
    console.error('CalDAV event PUT error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/calendar/event
router.delete('/calendar/event', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const { calendar, uid } = req.query
    if (!calendar || !uid) return res.status(400).json({ error: 'calendar and uid required' })
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    const urlPath = joinDavPath(basePath, calendar) + `/${uid}.ics`
    await davRequest('DELETE', urlPath, null, null, acct)
    invalidateAccountDavCache(acct.id)
    res.json({ success: true })
  } catch (err) {
    console.error('CalDAV event DELETE error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/calendar/import
router.post('/calendar/import', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const { calendar, ics } = req.body || {}
    if (!calendar || !ics) return res.status(400).json({ error: 'calendar and ics required' })
    const lines = ics.replace(/\r\n/g, '\n').replace(/\\n/g, '\n').split('\n')
    const events = []
    let current = null
    for (const line of lines) {
      if (line.startsWith('BEGIN:VEVENT')) current = { lines: [] }
      else if (line.startsWith('END:VEVENT')) { if (current) { events.push(current.lines.join('\n')); current = null } }
      else if (current) current.lines.push(line)
    }
    if (!events.length) return res.status(400).json({ error: 'No VEVENT found in ICS' })
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    let imported = 0
    for (const ev of events) {
      const uidMatch = ev.match(/UID:(.+)/)
      const uid = uidMatch ? uidMatch[1].trim() : Date.now() + imported
      const urlPath = joinDavPath(basePath, calendar) + `/${uid}.ics`
      let full = ev
      if (!ev.includes('BEGIN:VCALENDAR')) {
        full = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//leoposta//EN\r\n${ev}\r\nEND:VCALENDAR`
      }
      try {
        await davRequest('PUT', urlPath, full, 'text/calendar; charset=utf-8', acct)
        imported++
      } catch {}
    }
    invalidateAccountDavCache(acct.id)
    res.json({ success: true, imported, total: events.length })
  } catch (err) {
    console.error('CalDAV import error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router

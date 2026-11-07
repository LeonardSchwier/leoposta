import { Router } from 'express'
import { state } from '../lib/state.js'
import { davRequest, DAV_PATH_PREFIX, extractResponseSet } from '../lib/dav.js'

const router = Router()

// GET /api/calendar/calendars
router.get('/calendar/calendars', async (req, res) => {
  try {
    if (!state.accounts[0]) return res.status(400).json({ error: 'No account configured' })
    const basePath = DAV_PATH_PREFIX(state.accounts[0].imapUser)
    const profindXml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:calendar-timezone/>
  </d:prop>
</d:propfind>`
    const r = await davRequest('PROPFIND', basePath, profindXml)
    const entries = extractResponseSet(r.body).filter(e => e.displayname || /\/calendars\//.test(e.href))
    const calendars = entries.filter(e => e.displayname)
    res.json({ calendars })
  } catch (err) {
    console.error('CalDAV calendars error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/calendar/events
router.get('/calendar/events', async (req, res) => {
  try {
    if (!state.accounts[0]) return res.status(400).json({ error: 'No account configured' })
    const { calendar, start, end } = req.query
    if (!calendar) return res.status(400).json({ error: 'calendar param required' })
    const basePath = DAV_PATH_PREFIX(state.accounts[0].imapUser)
    const report = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <d:getcontenttype/>
  </d:prop>
  <c:filter>
    <c:time-range start="${start || ''}" end="${end || ''}"/>
  </c:filter>
</c:calendar-query>`
    const urlPath = `${basePath}/${calendar.replace(/^\/+|\/+$/g, '')}`
    const r = await davRequest('REPORT', urlPath, report)
    const resources = extractResponseSet(r.body).filter(e => /ics/i.test(e.href))
    const events = []
    for (const ev of resources) {
      const evPath = ev.href.startsWith('/') ? ev.href : `/${ev.href}`
      try {
        const evRes = await davRequest('GET', evPath, null, null)
        const ics = evRes.body
        const uid = (ics.match(/UID:(.+)/) || [])[1] || evPath
        const summary = (ics.match(/SUMMARY:(.+)/) || [])[1] || '(no subject)'
        const dtstart = (ics.match(/DTSTART[;TZID=[^;]*;?[^:]*:(.+)/) || [])[1] || ''
        const dtend = (ics.match(/DTEND[;TZID=[^;]*;?[^:]*:(.+)/) || [])[1] || ''
        const location = (ics.match(/LOCATION:(.+)/) || [])[1] || ''
        const description = (ics.match(/DESCRIPTION:(.+)/) || [])[1] || ''
        events.push({ uid: uid.trim(), summary: summary.trim(), start: dtstart.trim(), end: dtend.trim(), location: location.trim(), description: description.trim(), etag: evRes.headers.etag || '', href: ev.href, ics })
      } catch {}
    }
    res.json({ events })
  } catch (err) {
    console.error('CalDAV events error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/calendar/event
router.put('/calendar/event', async (req, res) => {
  try {
    if (!state.accounts[0]) return res.status(400).json({ error: 'No account configured' })
    const { calendar, ics, uid } = req.body || {}
    if (!calendar || !ics) return res.status(400).json({ error: 'calendar and ics required' })
    const basePath = DAV_PATH_PREFIX(state.accounts[0].imapUser)
    const urlPath = `${basePath}/${calendar.replace(/^\/+|\/+$/g, '')}/${uid || Date.now()}.ics`
    const r = await davRequest('PUT', urlPath, ics, 'text/calendar; charset=utf-8')
    res.json({ success: true, uid: uid || urlPath.split('/').pop().replace('.ics', ''), etag: r.headers.etag || '' })
  } catch (err) {
    console.error('CalDAV event PUT error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/calendar/event
router.delete('/calendar/event', async (req, res) => {
  try {
    if (!state.accounts[0]) return res.status(400).json({ error: 'No account configured' })
    const { calendar, uid } = req.query
    if (!calendar || !uid) return res.status(400).json({ error: 'calendar and uid required' })
    const basePath = DAV_PATH_PREFIX(state.accounts[0].imapUser)
    const urlPath = `${basePath}/${calendar.replace(/^\/+|\/+$/g, '')}/${uid}.ics`
    await davRequest('DELETE', urlPath, null, null)
    res.json({ success: true })
  } catch (err) {
    console.error('CalDAV event DELETE error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/calendar/import
router.post('/calendar/import', async (req, res) => {
  try {
    if (!state.accounts[0]) return res.status(400).json({ error: 'No account configured' })
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
    const basePath = DAV_PATH_PREFIX(state.accounts[0].imapUser)
    let imported = 0
    for (const ev of events) {
      const uidMatch = ev.match(/UID:(.+)/)
      const uid = uidMatch ? uidMatch[1].trim() : Date.now() + imported
      const urlPath = `${basePath}/${calendar.replace(/^\/+|\/+$/g, '')}/${uid}.ics`
      let full = ev
      if (!ev.includes('BEGIN:VCALENDAR')) {
        full = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//leoposta//EN\r\n${ev}\r\nEND:VCALENDAR`
      }
      try {
        await davRequest('PUT', urlPath, full, 'text/calendar; charset=utf-8')
        imported++
      } catch {}
    }
    res.json({ success: true, imported, total: events.length })
  } catch (err) {
    console.error('CalDAV import error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router

import { Router } from 'express'
import { resolveAccount, state, invalidateAccountDavCache } from '../lib/state.js'
import {
  davRequest, resolveDavBase, extractResponseSet, extractDataBlocks, isCalendarResource, joinDavPath, toDavTime,
  isDavConfigured, davErrorResponse, sameHref, DavNotConfiguredError
} from '../lib/dav.js'
import { expandForRange, boundToMs, splitIcsByUid, parseEvents } from '../lib/ics.js'
import { TTL_LONG } from '../lib/davcache.js'
import { trimEndChar } from '../lib/trim.js'

const router = Router()

function davAccount(req) {
  const acct = resolveAccount(req)
  return acct && isDavConfigured(acct) ? acct : null
}

function fail(res, err, acct, what) {
  const r = davErrorResponse(err, acct, 'CalDAV')
  if (r.status >= 500) console.error(`CalDAV ${what} error:`, err && err.message)
  res.status(r.status).json({ error: r.error, code: r.code })
}

/** Path of one event resource: its listed href, else <calendar>/<uid>.ics. */
function eventPath(basePath, calendar, uid, href) {
  if (typeof href === 'string' && href.startsWith('/')) return href
  return joinDavPath(basePath, calendar) + `/${encodeURIComponent(uid)}.ics`
}

function lastSegment(href) {
  const seg = trimEndChar(String(href || ''), '/').split('/').pop() || ''
  try { return decodeURIComponent(seg) } catch { return seg }
}

function decodeXmlText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

// GET /api/calendar/calendars — always 200; `configured: false` when the
// account has no CalDAV URL (the UI explains how to set one up).
router.get('/calendar/calendars', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return res.json({ configured: false, calendars: [] })
  try {
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
    // Drop the home-set root itself and any sibling that is not a real
    // user calendar (RFC 6638 schedule-inbox/-outbox: REPORT 403s there).
    // A calendar without a displayname is still a calendar: name it by path.
    const calendars = entries
      .filter(e => !sameHref(e.href, basePath))
      .filter(e => e.resourcetype.length ? e.resourcetype.includes('calendar') : (e.displayname && isCalendarResource(e)))
      .map(e => ({ ...e, displayname: e.displayname || lastSegment(e.href) }))
    res.json({ configured: true, calendars })
  } catch (err) {
    fail(res, err, acct, 'calendars')
  }
})

// GET /api/calendar/events?calendar=&start=&end=
// Recurring events are expanded into their occurrences in [start, end].
router.get('/calendar/events', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return fail(res, new DavNotConfiguredError(), null, 'events')
  try {
    const { calendar } = req.query
    if (!calendar || typeof calendar !== 'string') return res.status(400).json({ error: 'calendar param required' })
    const cacheKey = `events|${acct.id}|${calendar}|${req.query.start || ''}|${req.query.end || ''}`
    const cached = state.davCache.get(cacheKey)
    if (cached) return res.json(cached)
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    const startDav = toDavTime(req.query.start)
    const endDav = toDavTime(req.query.end, true)
    const timeRange = (startDav || endDav)
      // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- CalDAV XML, not HTML; toDavTime only returns '' or /^\d{8}T\d{6}Z$/ (server/lib/dav.test.js)
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
    const r = await davRequest('REPORT', urlPath, report, null, acct, 1)
    const rangeStart = boundToMs(req.query.start)
    const rangeEnd = boundToMs(req.query.end, true)
    const events = []
    for (const b of extractDataBlocks(r.body, 'calendar-data')) {
      const ics = decodeXmlText(b.body)
      for (const ev of expandForRange(ics, rangeStart, rangeEnd)) {
        events.push({ ...ev, uid: ev.uid || lastSegment(b.href).replace(/\.ics$/i, ''), etag: b.etag || '', href: b.href, calendar, ics })
      }
    }
    const payload = { events }
    state.davCache.set(cacheKey, payload, TTL_LONG)
    res.json(payload)
  } catch (err) {
    fail(res, err, acct, 'events')
  }
})

// PUT /api/calendar/event { calendar, ics, uid?, href? }
router.put('/calendar/event', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return fail(res, new DavNotConfiguredError(), null, 'event PUT')
  try {
    const { calendar, ics, href } = req.body || {}
    if (!calendar || !ics || typeof ics !== 'string') return res.status(400).json({ error: 'calendar and ics required' })
    const parsed = parseEvents(ics)
    if (!parsed.length) return res.status(400).json({ error: 'ics has no VEVENT with a DTSTART' })
    const uid = req.body.uid || parsed[0].uid
    if (!uid) return res.status(400).json({ error: 'the event needs a UID' })
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    const r = await davRequest('PUT', eventPath(basePath, calendar, uid, href), ics, 'text/calendar; charset=utf-8', acct)
    invalidateAccountDavCache(acct.id)
    res.json({ success: true, uid, etag: r.headers.etag || '' })
  } catch (err) {
    fail(res, err, acct, 'event PUT')
  }
})

// DELETE /api/calendar/event?calendar=&uid=[&href=]
router.delete('/calendar/event', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return fail(res, new DavNotConfiguredError(), null, 'event DELETE')
  try {
    const { calendar, uid, href } = req.query
    if (!calendar || (!uid && !href)) return res.status(400).json({ error: 'calendar and uid (or href) required' })
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    await davRequest('DELETE', eventPath(basePath, calendar, uid, href), null, null, acct)
    invalidateAccountDavCache(acct.id)
    res.json({ success: true })
  } catch (err) {
    fail(res, err, acct, 'event DELETE')
  }
})

// POST /api/calendar/import { calendar, ics }
// One resource per UID (a series travels with its overrides), each with the
// VTIMEZONEs it uses; the text is kept as imported (escapes, folding).
router.post('/calendar/import', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return fail(res, new DavNotConfiguredError(), null, 'import')
  try {
    const { calendar, ics } = req.body || {}
    if (!calendar || !ics || typeof ics !== 'string') return res.status(400).json({ error: 'calendar and ics required' })
    const objects = splitIcsByUid(ics)
    if (!objects.length) return res.status(400).json({ error: 'No VEVENT found in ICS' })
    const basePath = (await resolveDavBase(acct, 'calendar')).basePath
    let imported = 0
    const failed = []
    for (const o of objects) {
      try {
        await davRequest('PUT', eventPath(basePath, calendar, o.uid), o.ics, 'text/calendar; charset=utf-8', acct)
        imported++
      } catch (e) {
        if (davErrorResponse(e, acct).code === 'dav_unreachable') throw e
        failed.push({ uid: o.uid, error: String(e.message).slice(0, 200) })
      }
    }
    invalidateAccountDavCache(acct.id)
    if (!imported && failed.length) {
      return res.status(502).json({ error: `The server rejected all ${failed.length} event(s): ${failed[0].error}`, imported, total: objects.length, failed })
    }
    res.json({ success: true, imported, total: objects.length, failed })
  } catch (err) {
    fail(res, err, acct, 'import')
  }
})

export default router

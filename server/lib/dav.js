import https from 'node:https'
import http from 'node:http'

// Read vs write timeouts. Reads (PROPFIND/REPORT) against a large book can take
// well over the old hard 30s under load, so they get a longer ceiling; writes
// stay short. Both env-overridable for tests.
export const DAV_READ_TIMEOUT_MS = Number(process.env.DAV_TIMEOUT_READ_MS) || 120_000
export const DAV_WRITE_TIMEOUT_MS = Number(process.env.DAV_TIMEOUT_WRITE_MS) || 30_000

const READ_METHODS = new Set(['GET', 'PROPFIND', 'REPORT', 'OPTIONS'])

export function timeoutForMethod(method) {
  return READ_METHODS.has(String(method || '').toUpperCase()) ? DAV_READ_TIMEOUT_MS : DAV_WRITE_TIMEOUT_MS
}

/** Thrown (before any network I/O) when the account has no usable DAV URL. */
export class DavNotConfiguredError extends Error {
  constructor() {
    super('CalDAV/CardDAV is not configured for this account. Add a CalDAV/CardDAV URL in Settings.')
    this.code = 'dav_not_configured'
  }
}

/**
 * The DAV server for one account, from its own `davUrl` — or null when the
 * account has none (or it is not an http(s) URL). There is deliberately no
 * global fallback host: an account without DAV settings has no calendar or
 * address book, and asking some placeholder host with the IMAP password
 * would leak that password to whoever answers there.
 */
export function resolveDavTarget(acct) {
  const a = acct || {}
  if (!a.davUrl || typeof a.davUrl !== 'string') return null
  let u
  try { u = new URL(a.davUrl.trim()) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const tls = u.protocol === 'https:'
  const port = u.port ? parseInt(u.port, 10) : (tls ? 443 : 80)
  return {
    hostname: u.hostname,
    port,
    tls,
    basePath: u.pathname || '/',
    user: a.davUser || a.imapUser || a.email || '',
    pass: a.davPass || a.imapPass || ''
  }
}

/** True when DAV requests for this account would go anywhere. */
export function isDavConfigured(acct) {
  return resolveDavTarget(acct) !== null
}

// Network-level failures (refused, DNS, timeout, TLS) — the DAV server could
// not be reached at all, as opposed to it answering with an error status.
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE'])

/**
 * Map a DAV failure to { status, error } for a route's JSON response, so the
 * UI can show the user something they can act on instead of a raw socket
 * error. `kind` is 'CalDAV' or 'CardDAV'.
 */
export function davErrorResponse(err, acct, kind = 'DAV') {
  if (err instanceof DavNotConfiguredError) return { status: 409, error: err.message, code: err.code }
  const t = resolveDavTarget(acct)
  const where = t ? `${t.hostname}:${t.port}` : 'the server'
  if (err && (UNREACHABLE_CODES.has(err.code) || /times out after/.test(String(err.message)))) {
    return { status: 502, error: `Cannot reach the ${kind} server ${where} (${err.code || 'timeout'}). Check the CalDAV/CardDAV URL in Settings and your connection.`, code: 'dav_unreachable' }
  }
  if (err && (err.davStatus === 401 || err.davStatus === 403)) {
    return { status: 502, error: `The ${kind} server ${where} rejected the login (HTTP ${err.davStatus}). Check the CalDAV/CardDAV user and password in Settings.`, code: 'dav_auth' }
  }
  if (err && err.davStatus) {
    return { status: 502, error: String(err.message), code: 'dav_error' }
  }
  return { status: 500, error: String((err && err.message) || err), code: 'dav_error' }
}

export function davRequest(method, urlPath, body, contentType, acct, depth) {
  return new Promise((resolve, reject) => {
    const t = resolveDavTarget(acct)
    if (!t) return reject(new DavNotConfiguredError())
    const token = Buffer.from(`${t.user}:${t.pass}`).toString('base64')
    const opts = {
      hostname: t.hostname,
      port: t.port,
      path: urlPath,
      method,
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': contentType || 'application/xml; charset="utf-8"',
        'Depth': depth == null ? '1' : String(depth)
      }
    }
    if (contentType === 'text/xml') opts.headers['Content-Type'] = contentType
    // A fixed Content-Length, never chunked transfer encoding: WSGI servers
    // such as Radicale do not read a chunked request body and act on an empty
    // one (PUT -> 400, REPORT -> empty multistatus, PROPFIND -> allprop).
    const payload = body ? Buffer.from(body, 'utf8') : null
    opts.headers['Content-Length'] = String(payload ? payload.length : 0)
    const lib = t.tls ? https : http
    const timeoutMs = timeoutForMethod(method)
    const req = lib.request(opts, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data, headers: res.headers })
        } else {
          const e = new Error(`DAV ${method} ${urlPath} → ${res.statusCode}: ${data.slice(0, 300)}`)
          e.davStatus = res.statusCode
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`DAV ${method} times out after ${Math.round(timeoutMs / 1000)}s`))
    })
    req.end(payload || undefined)
  })
}

export function xmlParseNodes(xml, parentTag, childTag) {
  const results = []
  const re = new RegExp(`<${parentTag}[\\s>][\\s\\S]*?<${childTag}[^>]*>([\\s\\S]*?)</${childTag}>`, 'g')
  let m
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim())
  if (results.length) return results
  const re2 = new RegExp(`<${parentTag}[^>]*>([\\s\\S]*?)</${parentTag}>`, 'g')
  while ((m = re2.exec(xml)) !== null) {
    const inner = m[1]
    const cm = inner.match(new RegExp(`<${childTag}[^>]*>([\\s\\S]*?)</${childTag}>`))
    if (cm) results.push(cm[1].trim())
  }
  return results
}

const homeSetCache = new Map() // key → { href, ts }
const HOME_SET_TTL = 10 * 60 * 1000

// Resolve the DAV home-set for a given account + kind ('calendar' | 'cards').
// Returns { basePath } — the URL root to PROPFIND/REPORT against.
// If the user's davUrl already had a concrete sub-path (e.g. /dav/j/), trust it.
// If it's just '/' (or empty), discover per RFC 4791/6352:
//   PROPFIND / for current-user-principal → PROPFIND principal for home-set.
export async function resolveDavBase(account, kind) {
  const t = resolveDavTarget(account)
  if (!t) throw new DavNotConfiguredError()
  if (t.basePath && t.basePath !== '/') return { ...t, basePath: t.basePath }
  const key = `${t.tls ? 'https' : 'http'}://${t.hostname}:${t.port}|${t.user}|${kind}`
  const cached = homeSetCache.get(key)
  if (cached && Date.now() - cached.ts < HOME_SET_TTL) return { ...t, basePath: cached.href }

  const p1Xml = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`
  const p1 = await davRequest('PROPFIND', '/', p1Xml, null, account, 0)
  const pm = p1.body.match(/<(?:\w+:)?current-user-principal[^>]*(?<!\/)>\s*<(?:\w+:)?href[^>]*>\s*([^<\s]+?)\s*</i)
  if (!pm) throw new Error(`DAV discovery: no current-user-principal from ${t.hostname}:${t.port}`)
  const principal = hrefPath(pm[1])

  // RFC 6352 §7.1.1 names it addressbook-home-set (one word). Asking for
  // "address-book-home-set" gets a 404 propstat from every compliant server.
  const homeProp = kind === 'calendar' ? 'calendar-home-set' : 'addressbook-home-set'
  const nsPrefix = kind === 'calendar' ? 'c' : 'crd'
  const p2Xml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:crd="urn:ietf:params:xml:ns:carddav">
<d:prop><${nsPrefix}:${homeProp}/></d:prop>
</d:propfind>`
  const p2 = await davRequest('PROPFIND', principal, p2Xml, null, account, 0)
  const homeRe = new RegExp(`<(?:\\w+:)?(${kind === 'calendar' ? homeProp : 'address-?book-home-set'})[^>]*(?<!/)>\\s*<(?:\\w+:)?href[^>]*>\\s*([^<\\s]+?)\\s*<`, 'i')
  let hm = p2.body.match(homeRe)
  if (!hm) {
    // A server that does not advertise the home-set on the principal: probe
    // the usual well-known collection paths instead.
    const candidates = kind === 'calendar'
      ? ['/caldav/', '/calendars/', '/dav/calendars/']
      : ['/carddav/', '/addressbook/', '/dav/addressbook/']
    const probeXml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`
    for (const path of candidates) {
      try {
        const probe = await davRequest('PROPFIND', path, probeXml, null, account)
        // OX, radical/davserver and other servers each advertise the DAV
        // namespace either via xmlns:<PREFIX>="…/caldav" (or …/carddav) or
        // via element tags like cal:calendar / crd:address-book. Accept any.
        const isDav = kind === 'calendar'
          ? /caldav|cal:calendar|calendar-home|addressbook/i.test(probe.body)
          : /carddav|crd:address|address-book/i.test(probe.body)
        if (isDav) { hm = ['', path]; break }
      } catch { /* try next candidate */ }
    }
  }
  if (!hm) throw new Error(`DAV discovery: no ${homeProp} on principal ${principal}`)
  // Kept percent-encoded as the server sent it: it goes straight back into
  // request paths (a decoded space or non-ASCII character would make the
  // request invalid). Compare hrefs with sameHref().
  const href = hrefPath(hm[2] ?? hm[1])
  homeSetCache.set(key, { href, ts: Date.now() })
  return { ...t, basePath: href }
}

export function clearDavBaseCache() { homeSetCache.clear() }

/** The path of a DAV href, which may be an absolute URL (RFC 4918 §8.3). */
export function hrefPath(href) {
  const h = String(href || '').trim()
  if (/^https?:\/\//i.test(h)) {
    try { return new URL(h).pathname } catch { return h }
  }
  return h
}

/** Two hrefs name the same resource (ignoring percent-encoding and a trailing slash). */
export function sameHref(a, b) {
  const norm = (h) => {
    let p = hrefPath(h)
    try { p = decodeURIComponent(p) } catch {}
    return p.replace(/\/+$/, '')
  }
  return norm(a) === norm(b)
}

// Join a DAV base path with a relative (or already-absolute) sub-path.
// Returns a path WITHOUT a trailing slash. Sites that target a DAV collection
// (REPORT / PROPFIND on the collection itself) must append '/' themselves,
// since OX 400s on a bare (non-collection) href there; file-PUT/DELETE sites
// rely on this no-slash form so `+ '/uid.ics'` does not double-slash.
export function joinDavPath(basePath, sub) {
  if (sub && sub.startsWith('/')) return sub.replace(/\/+$/, '')
  const base = (basePath || '').replace(/\/+$/, '')
  const s = (sub || '').replace(/^\/+|\/+$/g, '')
  return s ? base + '/' + s : base
}

// Extract <carddav:address-data> (or any ns-prefixed address-data) blocks
// from a multiget response. Returns array of { href, vcf } objects.
// Extract { href, body, etag } pairs from a multiget-ish REPORT response.
// `dataTag` is 'address-data' (CardDAV, RFC 6352 §10.2) or
// 'calendar-data' (CalDAV, RFC 4791 §7.10). Handles both bare and
// namespace-prefixed (e.g. `<crd:address-data>`) forms.
export function extractDataBlocks(xml, dataTag) {
  const results = []
  const respRe = /<(\w+:)?response[^>]*>([\s\S]*?)<\/\1response>/gi
  const dataRe = new RegExp(`<((?:\\w+:)?${dataTag})[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i')
  const etagRe = /<(\w+:)?etag[^>]*>([\s\S]*?)<\/\1etag>/i
  const hrefRe = /<(\w+:)?href[^>]*>([\s\S]*?)<\/\1href>/i
  let m
  while ((m = respRe.exec(xml)) !== null) {
    const inner = m[2]
    const hrefM = inner.match(hrefRe)
    const dataM = inner.match(dataRe)
    const etagM = inner.match(etagRe)
    const href = hrefM ? hrefM[2].trim() : ''
    const body = dataM ? dataM[2].trim() : ''
    if (href && body) results.push({ href, body, etag: (etagM ? etagM[2].trim().replace(/"/g, '') : '') })
  }
  return results
}

// Convenience wrapper for CardDAV — returns { href, vcf, etag }.
export function extractAddressData(xml) {
  return extractDataBlocks(xml, 'address-data').map(({ href, body, etag }) => ({ href, vcf: body, etag }))
}

// Convert a date string like '2025-01-01' or '20250101T000000Z' to CalDAV
// time-range format 'yyyyMMddTHHmmssZ' (UTC).
export function toDavTime(s, endOfDay = false) {
  if (!s) return ''
  // Already in DAV format
  if (/^\d{8}T\d{6}Z$/.test(s)) return s
  // Full ISO 'YYYY-MM-DDTHH:mm:ssZ' (check before date-only)
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)
  if (m2) return `${m2[1]}${m2[2]}${m2[3]}T${m2[4]}${m2[5]}${m2[6]}Z`
  // ISO date 'YYYY-MM-DD'
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}${m[2]}${m[3]}T${endOfDay ? '235959' : '000000'}Z`
  return s
}

// Halving-retry wrapper for addressbook/calendar multiget REPORTs. `fetchBatch`
// receives a slice of hrefs (already formatted the way the caller wants, e.g.
// `<d:href>…</d:href>` strings or raw hrefs) and does ONE REPORT, returning an
// array of parsed cards. Normal path keeps batches at <= maxBatch. If a single
// REPORT times out (the OX "ein paar" failure) and the slice is larger than
// minBatch, split the slice in half and retry each half — recursively. Any
// non-timeout error propagates to the route's 500 handler.
// `acct` is passed for call-site clarity; `fetchBatch` typically closes over it.
export async function multigetWithRetry(urlPath, allHrefs, fetchBatch, acct, { maxBatch = 500, minBatch = 50 } = {}) {
  if (allHrefs.length > maxBatch) {
    const out = []
    for (let i = 0; i < allHrefs.length; i += maxBatch) {
      out.push(...await multigetWithRetry(urlPath, allHrefs.slice(i, i + maxBatch), fetchBatch, acct, { maxBatch, minBatch }))
    }
    return out
  }
  try {
    return await fetchBatch(allHrefs)
  } catch (err) {
    if (/times out after \d+s/i.test(String((err && err.message) || '')) && allHrefs.length > minBatch) {
      const half = Math.ceil(allHrefs.length / 2)
      const front = await multigetWithRetry(urlPath, allHrefs.slice(0, half), fetchBatch, acct, { maxBatch, minBatch })
      const back = await multigetWithRetry(urlPath, allHrefs.slice(half), fetchBatch, acct, { maxBatch, minBatch })
      return [...front, ...back]
    }
    throw err
  }
}

export function extractResponseSet(xml) {
  const responses = []
  const tagRe = (name) => new RegExp(
    `<(${name})[^>]*>([\\s\\S]*?)</${name}>|(\\w+:)(${name})[^>]*>([\\s\\S]*?)</\\3${name}>`
  )
  const innerOf = (m) => (m[2] ?? m[5] ?? '').trim()
  const respRe = new RegExp(tagRe('response').source, 'g')
  // Matches any self-closing tag inside a <resourcetype> block, with
  // optional namespace prefix (e.g. <c:schedule-inbox/>) or bare.
  const RES_TYPES_RE = /<(\w+:)?([\w\-]+)\s*\//
  const RT_RE = new RegExp(tagRe('resourcetype').source)
  let m
  while ((m = respRe.exec(xml)) !== null) {
    const inner = innerOf(m)
    const hrefM = inner.match(tagRe('href'))
    const nameM = inner.match(tagRe('displayname'))
    const etagM = inner.match(tagRe('etag'))
    const href = hrefM ? innerOf(hrefM) : ''
    const displayname = nameM ? innerOf(nameM) : ''
    const etag = etagM ? innerOf(etagM).replace(/"/g, '') : ''
    // Local names (not namespace URIs) — enough for client-side filtering
    // across arbitrary CalDAV backends that vary their ns prefixes.
    const resourcetype = []
    const rtM = inner.match(RT_RE)
    if (rtM) {
      const rtInner = innerOf(rtM)
      for (const m2 of rtInner.matchAll(new RegExp(RES_TYPES_RE.source, 'g'))) {
        resourcetype.push(m2[2])
      }
    }
    if (href) responses.push({ href, displayname, etag, resourcetype })
  }
  return responses
}

// A collection is a *user-viewable* CalDAV calendar iff its resourcetype
// includes c:calendar.  Siblings like schedule-inbox / schedule-outbox
// (RFC 6746 iMip plumbing) do NOT include c:calendar and would 403 on
// REPORT, so they are excluded.
// Servers that do not report resourcetype at all are kept with the old
// lenient behaviour (treat as calendar) so we don't regress on older or
// non-standard backends.
export function isCalendarResource(entry) {
  const rt = (entry && Array.isArray(entry.resourcetype)) ? entry.resourcetype : []
  return rt.length === 0 || rt.includes('calendar')
}

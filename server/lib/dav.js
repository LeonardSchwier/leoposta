import https from 'node:https'
import http from 'node:http'
import { state } from './state.js'

export const DAV_HOST = process.env.DAV_HOST || 'dav.example.com'
export const DAV_PORT = parseInt(process.env.DAV_PORT || '443', 10)
export const DAV_TLS = (process.env.DAV_TLS || (process.env.DAV_HOST ? 'true' : 'false')) === 'true'
export const DAV_PATH_PREFIX = (user) => (process.env.DAV_PREFIX || '/dav/' + user)

export function resolveDavTarget(acct) {
  const a = acct || {}
  const user = a.davUser || a.imapUser || ''
  const pass = a.davPass || a.imapPass || ''
  if (a.davUrl) {
    try {
      const u = new URL(a.davUrl)
      const tls = u.protocol === 'https:'
      const port = u.port
        ? parseInt(u.port, 10)
        : (tls ? 443 : 80)
      return { hostname: u.hostname, port, tls, basePath: u.pathname || '/', user, pass }
    } catch {}
  }
  return {
    hostname: DAV_HOST,
    port: DAV_PORT,
    tls: DAV_TLS,
    basePath: DAV_PATH_PREFIX(a.imapUser || ''),
    user,
    pass
  }
}

export function davRequest(method, urlPath, body, contentType, acct, depth) {
  return new Promise((resolve, reject) => {
    const account = acct || state.accounts[0] || {}
    const t = resolveDavTarget(account)
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
    const lib = t.tls ? https : http
    const req = lib.request(opts, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data, headers: res.headers })
        } else {
          reject(new Error(`DAV ${method} ${urlPath} → ${res.statusCode}: ${data.slice(0, 300)}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => {
      req.destroy(new Error(`DAV ${method} times out after 30s`))
    })
    if (body) req.write(body)
    req.end()
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
  const key = `${t.hostname}:${t.port}|${t.user}|${kind}`
  const cached = homeSetCache.get(key)
  if (cached && Date.now() - cached.ts < HOME_SET_TTL) return { ...t, basePath: cached.href }
  if (t.basePath && t.basePath !== '/') return { ...t, basePath: t.basePath }

  const p1Xml = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`
  const p1 = await davRequest('PROPFIND', '/', p1Xml, null, account)
  const pm = p1.body.match(/<(?:\w+:)?current-user-principal[^>]*>\s*<\w*:href[^>]*>\s*([^<\s]+?)\s*</i)
  if (!pm) throw new Error(`DAV discovery: no current-user-principal from ${t.hostname}:${t.port}`)
  const principal = pm[1]

  const homeProp = kind === 'calendar' ? 'calendar-home-set' : 'address-book-home-set'
  const nsPrefix = kind === 'calendar' ? 'c' : 'crd'
  const p2Xml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:crd="urn:ietf:params:xml:ns:carddav">
<d:prop><${nsPrefix}:${homeProp}/></d:prop>
</d:propfind>`
  const p2 = await davRequest('PROPFIND', principal, p2Xml, null, account)
  const homeRe = new RegExp(`<(?:\\w+:)?(${homeProp})[^>]*>\\s*<\\w*:href[^>]*>\\s*([^<\\s]+?)\\s*<`, 'i')
  let hm = p2.body.match(homeRe)
  if (!hm) {
    // Open-Xchange (mailbox.org) does not advertise address-book-home-set on the
    // principal (returns 404 on the propstat) but still serves the home-set at
    // the well-known /carddav/ path. Fall back to probing candidate well-known
    // paths for a CardDAV collection.
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
  let href = hm[2] ?? hm[1]
  try { href = decodeURIComponent(href) } catch {}
  homeSetCache.set(key, { href, ts: Date.now() })
  return { ...t, basePath: href }
}

export function clearDavBaseCache() { homeSetCache.clear() }

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

export function extractResponseSet(xml) {
  const responses = []
  const tagRe = (name) => new RegExp(
    `<(${name})[^>]*>([\\s\\S]*?)</${name}>|(\\w+:)(${name})[^>]*>([\\s\\S]*?)</\\3${name}>`
  )
  const innerOf = (m) => (m[2] ?? m[5] ?? '').trim()
  const respRe = new RegExp(tagRe('response').source, 'g')
  let m
  while ((m = respRe.exec(xml)) !== null) {
    const inner = innerOf(m)
    const hrefRe = tagRe('href')
    const nameRe = tagRe('displayname')
    const etagRe = tagRe('etag')
    const hrefM = inner.match(hrefRe)
    const nameM = inner.match(nameRe)
    const etagM = inner.match(etagRe)
    const href = hrefM ? innerOf(hrefM) : ''
    const displayname = nameM ? innerOf(nameM) : ''
    const etag = etagM ? innerOf(etagM).replace(/"/g, '') : ''
    if (href) responses.push({ href, displayname, etag })
  }
  return responses
}

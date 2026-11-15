import { Router } from 'express'
import { resolveAccount, state, invalidateAccountDavCache } from '../lib/state.js'
import {
  davRequest, resolveDavBase, extractResponseSet, extractAddressData, joinDavPath, multigetWithRetry,
  isDavConfigured, davErrorResponse, sameHref, DavNotConfiguredError
} from '../lib/dav.js'
import { parseVcf, parseCard } from '../lib/vcf.js'
import { TTL_LONG } from '../lib/davcache.js'
import { trimEndChar } from '../lib/trim.js'

const router = Router()

/** The request's account when it has CardDAV configured, else null. */
function davAccount(req) {
  const acct = resolveAccount(req)
  return acct && isDavConfigured(acct) ? acct : null
}

function fail(res, err, acct, what) {
  const r = davErrorResponse(err, acct, 'CardDAV')
  if (r.status >= 500) console.error(`CardDAV ${what} error:`, err && err.message)
  res.status(r.status).json({ error: r.error, code: r.code })
}

/** Path of one card: the href the server listed it under, else <book>/<uid>.vcf. */
function cardPath(basePath, book, uid, href) {
  if (typeof href === 'string' && href.startsWith('/')) return href
  return joinDavPath(basePath, book) + `/${encodeURIComponent(uid)}.vcf`
}

function lastSegment(href) {
  const seg = trimEndChar(String(href || ''), '/').split('/').pop() || ''
  try { return decodeURIComponent(seg) } catch { return seg }
}

// GET /api/contacts/calendars  (list address books)
// Always 200: an account without CardDAV is a normal state the UI explains
// (`configured: false`), not an error.
router.get('/contacts/calendars', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return res.json({ configured: false, addressBooks: [] })
  try {
    const cacheKey = `books|${acct.id}`
    const cached = state.davCache.get(cacheKey)
    if (cached) return res.json(cached)
    const basePath = (await resolveDavBase(acct, 'cards')).basePath
    const profindXml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:crd="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`
    const r = await davRequest('PROPFIND', basePath, profindXml, null, acct)
    const entries = extractResponseSet(r.body)
    // Address books (resourcetype addressbook); the home-set root itself is
    // not one. Servers that report no resourcetype at all: keep named ones.
    const books = entries
      .filter(e => !sameHref(e.href, basePath))
      .filter(e => e.resourcetype.includes('addressbook') || (e.resourcetype.length === 0 && e.displayname))
      .map(e => ({ ...e, displayname: e.displayname || lastSegment(e.href) }))
    const payload = { configured: true, addressBooks: books }
    state.davCache.set(cacheKey, payload, TTL_LONG)
    res.json(payload)
  } catch (err) {
    fail(res, err, acct, 'address books')
  }
})

// GET /api/contacts?book=<id>&q=<query>
router.get('/contacts', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return fail(res, new DavNotConfiguredError(), null, 'contacts')
  try {
    const { book, q } = req.query
    if (!book || typeof book !== 'string') return res.status(400).json({ error: 'book param required' })
    const cacheKey = `contacts|${acct.id}|${book}`
    let contacts = state.davCache.get(cacheKey)
    if (!contacts) {
      const basePath = (await resolveDavBase(acct, 'cards')).basePath
      const profind = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <d:getcontenttype/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`
      const urlPath = joinDavPath(basePath, book) + '/'
      const r = await davRequest('PROPFIND', urlPath, profind, null, acct)
      // Every member resource, not just "*.vcf": servers are free to name
      // cards however they like (RFC 6352 §5.1).
      const entries = extractResponseSet(r.body)
        .filter(e => !sameHref(e.href, urlPath) && !e.resourcetype.includes('collection'))
      contacts = []
      if (entries.length) {
        // RFC 6352 §8.7 addressbook-multiget: card bodies in round-trips of
        // <= 500 (larger REPORTs make OX hang); a timed-out batch is halved.
        const fetchBatch = async (hrefs) => {
          const report = `<?xml version="1.0" encoding="utf-8"?>
<c:addressbook-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
    <c:address-data content-type="text/vcard"/>
  </d:prop>
    ${hrefs.join('')}
</c:addressbook-multiget>`
          const r2 = await davRequest('REPORT', urlPath, report, null, acct, 0)
          return extractAddressData(r2.body)
        }
        const allCards = await multigetWithRetry(urlPath, entries.map(e => `<d:href>${e.href}</d:href>`), fetchBatch, acct, { maxBatch: 500, minBatch: 50 })
        contacts = allCards.map(c => {
          const vcf = decodeXmlText(c.vcf)
          const card = parseCard(vcf)
          const fallbackId = lastSegment(c.href).replace(/\.vcf$/i, '')
          return {
            ...card,
            uid: card.uid || fallbackId,
            name: card.name || card.email || fallbackId || '(unknown)',
            vcf, href: c.href, etag: c.etag || '', bookUri: book
          }
        })
      }
      state.davCache.set(cacheKey, contacts, TTL_LONG)
    }

    let filtered = contacts
    if (typeof q === 'string' && q.trim()) {
      const lq = q.trim().toLowerCase()
      filtered = contacts.filter(c =>
        c.name.toLowerCase().includes(lq) ||
        c.emails.some(e => e.toLowerCase().includes(lq)) ||
        (c.org || '').toLowerCase().includes(lq) ||
        c.phones.some(p => p.includes(lq)))
    }
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name))
    res.json({ contacts: filtered, total: contacts.length })
  } catch (err) {
    fail(res, err, acct, 'contacts')
  }
})

// XML text content arrives entity-encoded (&amp; &lt; …).
function decodeXmlText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

// PUT /api/contact  (create or update a contact) { book, vcf, href? }
router.put('/contact', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return fail(res, new DavNotConfiguredError(), null, 'contact PUT')
  try {
    const { book, vcf, href } = req.body || {}
    if (!book || !vcf) return res.status(400).json({ error: 'book and vcf required' })
    const { cards, errors } = parseVcf(vcf)
    if (errors.length) return res.status(400).json({ error: errors[0], errors })
    if (cards.length !== 1) return res.status(400).json({ error: 'PUT /contact accepts exactly one card' })
    const basePath = (await resolveDavBase(acct, 'cards')).basePath
    const card = cards[0]
    const r = await davRequest('PUT', cardPath(basePath, book, card.uid, href), card.raw, 'text/vcard; charset=utf-8', acct)
    invalidateAccountDavCache(acct.id)
    res.json({ success: true, uid: card.uid, etag: r.headers.etag || '' })
  } catch (err) {
    fail(res, err, acct, 'contact PUT')
  }
})

// DELETE /api/contact?book=<id>&uid=<uid>[&href=<href>]
router.delete('/contact', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return fail(res, new DavNotConfiguredError(), null, 'contact DELETE')
  try {
    const { book, uid, href } = req.query
    if (!book || (!uid && !href)) return res.status(400).json({ error: 'book and uid (or href) required' })
    const basePath = (await resolveDavBase(acct, 'cards')).basePath
    await davRequest('DELETE', cardPath(basePath, book, uid, href), null, null, acct)
    invalidateAccountDavCache(acct.id)
    res.json({ success: true })
  } catch (err) {
    fail(res, err, acct, 'contact DELETE')
  }
})

// POST /api/contacts/import  (VCF import)
router.post('/contacts/import', async (req, res) => {
  const acct = davAccount(req)
  if (!acct) return fail(res, new DavNotConfiguredError(), null, 'import')
  try {
    const { book, vcf } = req.body || {}
    if (!book || !vcf) return res.status(400).json({ error: 'book and vcf required' })
    const { cards, errors } = parseVcf(vcf)
    if (errors.length) return res.status(400).json({ error: errors[0], errors })
    const basePath = (await resolveDavBase(acct, 'cards')).basePath
    let imported = 0
    const failed = []
    for (const card of cards) {
      try {
        await davRequest('PUT', cardPath(basePath, book, card.uid), card.raw, 'text/vcard; charset=utf-8', acct)
        imported++
      } catch (e) {
        // A server that is down fails every card the same way: stop and say so.
        if (davErrorResponse(e, acct).code === 'dav_unreachable') throw e
        failed.push({ uid: card.uid, error: String(e.message).slice(0, 200) })
      }
    }
    invalidateAccountDavCache(acct.id)
    if (!imported && failed.length) {
      return res.status(502).json({ error: `The server rejected all ${failed.length} contact(s): ${failed[0].error}`, imported, total: cards.length, failed })
    }
    res.json({ success: true, imported, total: cards.length, failed })
  } catch (err) {
    fail(res, err, acct, 'import')
  }
})

export default router

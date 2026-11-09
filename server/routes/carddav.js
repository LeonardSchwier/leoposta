import { Router } from 'express'
import { resolveAccount, state, invalidateAccountDavCache } from '../lib/state.js'
import { davRequest, resolveDavBase, extractResponseSet, extractAddressData, joinDavPath, multigetWithRetry } from '../lib/dav.js'
import { parseVcf } from '../lib/vcf.js'
import { TTL_LONG } from '../lib/davcache.js'

const router = Router()

// GET /api/contacts/calendars  (list address books)
router.get('/contacts/calendars', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const cacheKey = `calendars|${acct.id}`
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
    // Keep entries with a displayname, excluding the home-set root itself.
    // basePath always ends in '/' (e.g. '/carddav/'); hrefs do too.
    const books = entries.filter(e => e.displayname && e.href !== basePath)
    const payload = { addressBooks: books }
    state.davCache.set(cacheKey, payload, TTL_LONG)
    res.json(payload)
  } catch (err) {
    console.error('CardDAV calendars error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/contacts?book=<id>&q=<query>
router.get('/contacts', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const { book, q } = req.query
    if (!book) return res.status(400).json({ error: 'book param required' })
    const cacheKey = `contacts|${acct.id}|${book}`
    let contacts = null
    const cached = state.davCache.get(cacheKey)
    if (!cached) {
      const basePath = (await resolveDavBase(acct, 'cards')).basePath
      const profind = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getetag/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>`
      const urlPath = joinDavPath(basePath, book) + '/'
      const r = await davRequest('PROPFIND', urlPath, profind, null, acct)
      const entries = extractResponseSet(r.body).filter(e => /\.vcf/i.test(e.href))
      if (entries.length) {
        // RFC 6352 §10.2: addressbook-multiget returns card bodies in round-trips
        // (collapses the N+1 sequential GETs that triggered rate-limiting on OX).
        // A single REPORT with thousands of cards makes OX (mailbox.org) hang
        // (verified: 150/300/500 → clean 207; ~2700 → no response). 500/batch stays
        // under the hang threshold and well under the 120s read timeout. On a read
        // timeout multigetWithRetry halves the slice and retries (500→250→…).
        const fetchBatch = async (hrefs) => {
          const report = `<?xml version="1.0" encoding="utf-8"?>
<c:addressbook-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:displayname/>
    <d:getetag/>
    <c:address-data content-type="text/vcard"/>
  </d:prop>
    ${hrefs}
</c:addressbook-multiget>`
          const r2 = await davRequest('REPORT', urlPath, report, null, acct, 0)
          return extractAddressData(r2.body)
        }
        const allCards = await multigetWithRetry(urlPath, entries.map(e => `<d:href>${e.href}</d:href>`), fetchBatch, acct, { maxBatch: 500, minBatch: 50 })

        contacts = allCards.map(c => {
          const vcf = c.vcf
          const fn = (vcf.match(/FN:(.+)/) || [])[1] || c.href.split('/').pop()?.replace(/\.vcf$/i, '') || '(unknown)'
          const email = (vcf.match(/EMAIL[^:]*:(.+)/) || [])[1] || ''
          const phone = (vcf.match(/TEL[^:]*:(.+)/) || [])[1] || ''
          const uid = (vcf.match(/UID:(.+)/) || [])[1] || c.href.split('/').pop()?.replace(/\.vcf$/i, '')
          const org = (vcf.match(/ORG:(.+)/) || [])[1] || ''
          return { uid: uid.trim(), name: fn.trim(), email: email.trim(), phone: phone.trim(), org: org.trim().split(';')[0], vcf, href: c.href, etag: c.etag || '' }
        })
        state.davCache.set(cacheKey, contacts, TTL_LONG)
      } else {
        contacts = []
      }
    } else {
      contacts = cached
    }

    let filtered = contacts
    if (q) {
      const lq = q.toLowerCase()
      filtered = contacts.filter(c => c.name.toLowerCase().includes(lq) || c.email.toLowerCase().includes(lq))
    }
    filtered.sort((a, b) => a.name.localeCompare(b.name))
    res.json({ contacts: filtered, total: contacts.length })
  } catch (err) {
    console.error('CardDAV contacts error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/contact  (create or update a contact)
router.put('/contact', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const { book, vcf } = req.body || {}
    if (!book || !vcf) return res.status(400).json({ error: 'book and vcf required' })
    const { cards, errors } = parseVcf(vcf)
    if (errors.length) return res.status(400).json({ error: errors[0], errors })
    if (cards.length !== 1) return res.status(400).json({ error: 'PUT /contact accepts exactly one card' })
    const basePath = (await resolveDavBase(acct, 'cards')).basePath
    const card = cards[0]
    const urlPath = joinDavPath(basePath, book) + `/${card.uid}.vcf`
    const r = await davRequest('PUT', urlPath, card.raw, 'text/vcard; charset=utf-8', acct)
    invalidateAccountDavCache(acct.id)
    res.json({ success: true, uid: card.uid, etag: r.headers.etag || '' })
  } catch (err) {
    console.error('CardDAV contact PUT error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/contact?book=<id>&uid=<uid>
router.delete('/contact', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const { book, uid } = req.query
    if (!book || !uid) return res.status(400).json({ error: 'book and uid required' })
    const basePath = (await resolveDavBase(acct, 'cards')).basePath
    const urlPath = joinDavPath(basePath, book) + `/${uid}.vcf`
    await davRequest('DELETE', urlPath, null, null, acct)
    invalidateAccountDavCache(acct.id)
    res.json({ success: true })
  } catch (err) {
    console.error('CardDAV contact DELETE error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/contacts/import  (VCF import)
router.post('/contacts/import', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const { book, vcf } = req.body || {}
    if (!book || !vcf) return res.status(400).json({ error: 'book and vcf required' })
    const { cards, errors } = parseVcf(vcf)
    if (errors.length) return res.status(400).json({ error: errors[0], errors })
    const basePath = (await resolveDavBase(acct, 'cards')).basePath
    let imported = 0
    for (const card of cards) {
      const urlPath = joinDavPath(basePath, book) + `/${card.uid}.vcf`
      try {
        await davRequest('PUT', urlPath, card.raw, 'text/vcard; charset=utf-8', acct)
        imported++
      } catch {}
    }
    invalidateAccountDavCache(acct.id)
    res.json({ success: true, imported, total: cards.length })
  } catch (err) {
    console.error('CardDAV import error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router

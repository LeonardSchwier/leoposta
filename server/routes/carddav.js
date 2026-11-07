import { Router } from 'express'
import { state } from '../lib/state.js'
import { davRequest, DAV_PATH_PREFIX, extractResponseSet } from '../lib/dav.js'

const router = Router()

// GET /api/contacts/calendars  (list address books)
router.get('/contacts/calendars', async (req, res) => {
  try {
    if (!state.account) return res.status(400).json({ error: 'No account configured' })
    const basePath = DAV_PATH_PREFIX(state.account.imapUser)
    const profindXml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:crd="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`
    const r = await davRequest('PROPFIND', basePath, profindXml)
    const entries = extractResponseSet(r.body)
    const books = entries.filter(e => /addressbooks/i.test(e.href) && e.displayname)
    res.json({ addressBooks: books })
  } catch (err) {
    console.error('CardDAV calendars error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/contacts?book=<id>&q=<query>
router.get('/contacts', async (req, res) => {
  try {
    if (!state.account) return res.status(400).json({ error: 'No account configured' })
    const { book, q } = req.query
    if (!book) return res.status(400).json({ error: 'book param required' })
    const basePath = DAV_PATH_PREFIX(state.account.imapUser)
    const profind = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getetag/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>`
    const urlPath = `${basePath}/${book.replace(/^\/+|\/+$/g, '')}`
    const r = await davRequest('PROPFIND', urlPath, profind)
    const entries = extractResponseSet(r.body).filter(e => /\.vcf/i.test(e.href))
    const contacts = []
    for (const c of entries) {
      try {
        const vcfPath = c.href.startsWith('/') ? c.href : `/${c.href}`
        const vres = await davRequest('GET', vcfPath, null, null)
        const vcf = vres.body
        const fn = (vcf.match(/FN:(.+)/) || [])[1] || c.displayname || '(unknown)'
        const email = (vcf.match(/EMAIL[^:]*:(.+)/) || [])[1] || ''
        const phone = (vcf.match(/TEL[^:]*:(.+)/) || [])[1] || ''
        const uid = (vcf.match(/UID:(.+)/) || [])[1] || c.href.split('/').pop()
        const org = (vcf.match(/ORG:(.+)/) || [])[1] || ''
        contacts.push({ uid: uid.trim(), name: fn.trim(), email: email.trim(), phone: phone.trim(), org: org.trim().split(';')[0], vcf, href: c.href, etag: vres.headers.etag || '' })
      } catch {}
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
    if (!state.account) return res.status(400).json({ error: 'No account configured' })
    const { book, vcf } = req.body || {}
    if (!book || !vcf) return res.status(400).json({ error: 'book and vcf required' })
    const basePath = DAV_PATH_PREFIX(state.account.imapUser)
    const uidMatch = vcf.match(/UID:(.+)/)
    const uid = uidMatch ? uidMatch[1].trim() : ('leoposta_' + Date.now())
    const urlPath = `${basePath}/${book.replace(/^\/+|\/+$/g, '')}/${uid}.vcf`
    const r = await davRequest('PUT', urlPath, vcf, 'text/vcard; charset=utf-8')
    res.json({ success: true, uid, etag: r.headers.etag || '' })
  } catch (err) {
    console.error('CardDAV contact PUT error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/contact?book=<id>&uid=<uid>
router.delete('/contact', async (req, res) => {
  try {
    if (!state.account) return res.status(400).json({ error: 'No account configured' })
    const { book, uid } = req.query
    if (!book || !uid) return res.status(400).json({ error: 'book and uid required' })
    const basePath = DAV_PATH_PREFIX(state.account.imapUser)
    const urlPath = `${basePath}/${book.replace(/^\/+|\/+$/g, '')}/${uid}.vcf`
    await davRequest('DELETE', urlPath, null, null)
    res.json({ success: true })
  } catch (err) {
    console.error('CardDAV contact DELETE error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/contacts/import  (VCF import)
router.post('/contacts/import', async (req, res) => {
  try {
    if (!state.account) return res.status(400).json({ error: 'No account configured' })
    const { book, vcf } = req.body || {}
    if (!book || !vcf) return res.status(400).json({ error: 'book and vcf required' })
    const parts = vcf.split(/BEGIN:VCARD/).filter(p => p.includes('VERSION:'))
    const basePath = DAV_PATH_PREFIX(state.account.imapUser)
    let imported = 0
    for (const part of parts) {
      const card = 'BEGIN:VCARD' + part
      const uidMatch = card.match(/UID:(.+)/)
      const uid = uidMatch ? uidMatch[1].trim() : ('leoposta_' + Date.now() + imported)
      const urlPath = `${basePath}/${book.replace(/^\/+|\/+$/g, '')}/${uid}.vcf`
      try {
        await davRequest('PUT', urlPath, card, 'text/vcard; charset=utf-8')
        imported++
      } catch {}
    }
    res.json({ success: true, imported, total: parts.length })
  } catch (err) {
    console.error('CardDAV import error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router

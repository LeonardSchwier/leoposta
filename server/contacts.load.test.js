// Loading a large address book: concurrent requests share one download, card
// batches run in parallel (bounded), an expired list is served at once while
// it refreshes, and a write during a load keeps the old result out of the cache.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const TOKEN = 'contacts-load-token-0123456789'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-contacts-load-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR

const N = 250 // -> 3 multiget batches of <= 100
const REPORT_DELAY_MS = 300
let version = 1
const calls = { bookPropfind: 0, report: 0, inFlight: 0, maxInFlight: 0 }
const card = (i) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c${i}\r\nFN:Person ${String(i).padStart(3, '0')} v${version}\r\nEND:VCARD`
const resp = (href, prop) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${prop}</D:prop></D:propstat></D:response>`

const fakeDav = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const p = req.url || ''
    res.writeHead(207, { 'content-type': 'application/xml' })
    if (req.method === 'PROPFIND') {
      if (p === '/' || p.startsWith('/dav/1')) {
        return res.end(`<D:multistatus xmlns:D="DAV:">${resp(p, '<D:current-user-principal><D:href>/dav/1</D:href></D:current-user-principal><D:carddav-home-set><D:href>/carddav/</D:href></D:carddav-home-set>')}</D:multistatus>`)
      }
      if (p.startsWith('/carddav/big')) {
        calls.bookPropfind++
        const members = Array.from({ length: N }, (_, i) => resp(`/carddav/big/c${i}.vcf`, '<D:getetag>"e"</D:getetag><D:getcontenttype>text/vcard</D:getcontenttype><D:resourcetype/>')).join('')
        return res.end(`<D:multistatus xmlns:D="DAV:">${resp('/carddav/big/', '<D:resourcetype><D:collection/></D:resourcetype>')}${members}</D:multistatus>`)
      }
      return res.end(`<D:multistatus xmlns:D="DAV:">${resp('/carddav/', '')}</D:multistatus>`)
    }
    if (req.method === 'REPORT') {
      calls.report++
      calls.inFlight++
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight)
      const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1])
      setTimeout(() => {
        calls.inFlight--
        res.end(`<D:multistatus xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">` +
          hrefs.map((h) => resp(h, `<D:getetag>"e"</D:getetag><c:address-data>${card(Number(/c(\d+)\.vcf/.exec(h)[1]))}</c:address-data>`)).join('') +
          `</D:multistatus>`)
      }, REPORT_DELAY_MS)
      return
    }
    res.end('<D:multistatus xmlns:D="DAV:"/>')
  })
})
await new Promise((r) => fakeDav.listen(0, '127.0.0.1', r))

const { createApp } = await import('./index.js')
const { setNow, resetClock, TTL_LONG } = await import('./lib/davcache.js')
const { state } = await import('./lib/state.js')
const authed = { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }
let server, base

before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  const res = await fetch(`${base}/api/account`, {
    method: 'POST', headers: authed,
    body: JSON.stringify({
      email: 'big@x.test', imapHost: 'imap.x.test', imapPort: 993, imapTls: true, imapUser: 'u', imapPass: 'p',
      smtpHost: 'smtp.x.test', smtpPort: 465, smtpTls: true, smtpUser: 'u', smtpPass: 'p',
      davUrl: `http://127.0.0.1:${fakeDav.address().port}`, davUser: 'u', davPass: 'p'
    })
  })
  assert.equal(res.status, 200)
})
after(async () => {
  resetClock()
  await new Promise((r) => server.close(r))
  await new Promise((r) => fakeDav.close(r))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

const getContacts = async (q = '') => {
  const r = await fetch(`${base}/api/contacts?book=big${q ? `&q=${encodeURIComponent(q)}` : ''}`, { headers: authed })
  assert.equal(r.status, 200)
  return r.json()
}
const reset = () => { state.davCache.clear(); Object.assign(calls, { bookPropfind: 0, report: 0, inFlight: 0, maxInFlight: 0 }) }

test('concurrent requests for one book share one download; batches run in parallel, in order', async () => {
  reset()
  const t = Date.now()
  const [a, b, c] = await Promise.all([getContacts(), getContacts('person 1'), getContacts()])
  const ms = Date.now() - t
  assert.equal(calls.bookPropfind, 1, 'one PROPFIND for three requests')
  assert.equal(calls.report, 3, 'one set of 3 multiget batches for three requests')
  assert.ok(calls.maxInFlight > 1 && calls.maxInFlight <= 6, `batches in parallel, at most 6 (was ${calls.maxInFlight})`)
  assert.ok(ms < 3 * REPORT_DELAY_MS, `parallel, not 3 x ${REPORT_DELAY_MS} ms one after another (took ${ms} ms)`)
  assert.equal(a.total, N)
  assert.equal(new Set(a.contacts.map((x) => x.uid)).size, N, 'every card once')
  assert.deepEqual(c.contacts, a.contacts)
  assert.ok(b.contacts.length > 0 && b.contacts.every((x) => x.name.toLowerCase().includes('person 1')))
})

test('an expired list is served at once and refreshed in the background', async () => {
  reset()
  version = 1
  await getContacts()
  const real = Date.now
  setNow(() => real() + TTL_LONG + 1000)
  try {
    version = 2
    const t = Date.now()
    const stale = await getContacts()
    assert.ok(Date.now() - t < REPORT_DELAY_MS, 'answered without waiting for the server')
    assert.ok(stale.contacts[0].name.endsWith('v1'), 'the last list, as it was')
    // The background refresh lands; then the new list is served.
    const end = Date.now() + 5000
    let fresh
    do { await new Promise((r) => setTimeout(r, 100)); fresh = await getContacts() } while (!fresh.contacts[0].name.endsWith('v2') && Date.now() < end)
    assert.ok(fresh.contacts[0].name.endsWith('v2'), 'refreshed in the background')
    assert.equal(calls.bookPropfind, 2, 'one load, one background refresh')
  } finally {
    resetClock()
  }
})

test('a write during a load keeps the outdated result out of the cache', async () => {
  reset()
  version = 1
  const loading = getContacts()
  await new Promise((r) => setTimeout(r, 50)) // the load is in flight
  state.davCache.invalidatePrefix('contacts|') // what a contact write does
  await loading
  const before = calls.bookPropfind
  await getContacts()
  assert.equal(calls.bookPropfind, before + 1, 'the next request loads again instead of using the outdated result')
})

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const TOKEN = 'intg-test-token-012345'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-intg-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

// Fake DAV server with DAV call counters (per path + method).
let davCalls = { propfind: 0, multiget: 0, report: 0 }
const fakeDav = http.createServer((req, res) => {
  const p = req.url || ''
  const m = req.method
  if (m === 'PROPFIND') { davCalls.propfind++; res.writeHead(207, { 'content-type': 'application/xml' });
    // current-user-principal discovery (root)
    if (p === '/' || /current-user-principal/i.test(p)) {
      res.end(`<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav/1</D:href></D:current-user-principal></D:prop></D:propstat></D:response></D:multistatus>`)
    } else if (p.startsWith('/dav/1')) {
      // home-set discovery on the principal
      res.end(`<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/1</D:href><D:propstat><D:prop><D:carddav-home-set><D:href>/carddav/</D:href></D:carddav-home-set><D:calendar-home-set><D:href>/caldav/</D:href></D:calendar-home-set></D:prop></D:propstat></D:response></D:multistatus>`)
    } else {
      res.end(
        `<D:multistatus xmlns:D="DAV:">` +
        `<D:response><D:href>/carddav/</D:href><D:propstat><D:prop></D:prop></D:propstat></D:response>` +
        `<D:response><D:href>/carddav/personal/</D:href><D:propstat><D:prop><D:displayname>Personal</D:displayname></D:prop></D:propstat></D:response>` +
        `<D:response><D:href>/carddav/personal/a.vcf</D:href><D:propstat><D:prop><D:getetag>"x"</D:getetag><D:getcontenttype>text/vcard</D:getcontenttype></D:prop></D:propstat></D:response>` +
        `</D:multistatus>`
      )
    }
  } else if (m === 'REPORT' && p.startsWith('/carddav/')) { davCalls.multiget++; res.writeHead(207, { 'content-type': 'application/xml' }); res.end(
    `<D:multistatus xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">` +
    `<D:response><D:href>/carddav/personal/a.vcf</D:href><D:propstat><D:prop><c:address-data content-type="text/vcard">BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:Alpha\r\nEND:VCARD</c:address-data><D:getetag>"x"</D:getetag></D:prop></D:propstat></D:response>` +
    `</D:multistatus>`
  ) } else { davCalls.report++; res.writeHead(207, { 'content-type': 'application/xml' }); res.end(
    `<D:multistatus xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<D:response><D:href>/caldav/pal/1.ics</D:href><D:propstat><D:prop><c:calendar-data>BEGIN:VCALENDAR\r\nUID:1\r\nSUMMARY:One\r\nEND:VCALENDAR</c:calendar-data><D:getetag>"x"</D:getetag></D:prop></D:propstat></D:response>` +
    `</D:multistatus>`
  ) }
})
await new Promise((resolve, reject) => { fakeDav.once('error', reject); fakeDav.listen(0, '127.0.0.1', () => resolve()) })
process.env.DAV_HOST = '127.0.0.1'
process.env.DAV_PORT = String(fakeDav.address().port)
process.env.DAV_TLS = 'false'

const { createApp } = await import('./index.js')

let server
let base
const authed = { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }

before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve, reject) => fakeDav.close((e) => e ? reject(e) : resolve()))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

async function seedAccount(email = 'j@x.com') {
  const res = await fetch(`${base}/api/account`, {
    method: 'POST', headers: authed,
    body: JSON.stringify({
      email, imapHost: 'imap.x.com', imapPort: 993, imapTls: true,
      imapUser: 'j', imapPass: 'p', smtpHost: 'smtp.x.com', smtpPort: 465, smtpTls: true,
      smtpUser: 'j', smtpPass: 'p', davUrl: `http://127.0.0.1:${fakeDav.address().port}`,
      davUser: 'j', davPass: 'p',
    }),
  })
  if (res.status !== 200) console.error('[seed]', res.status, await res.text())
  assert.equal(res.status, 200)
}

test('second GET /api/contacts is served from cache (DAV is not re-hit)', async () => {
  await seedAccount('j1@x.com')
  // First call: should be a miss, hits DAV.
  const first = await fetch(`${base}/api/contacts?book=personal`, { headers: authed })
  assert.equal(first.status, 200)

  const j1 = await first.json()
  assert.equal(typeof j1.contacts.length, 'number')
  const propfindAfter1 = davCalls.propfind
  const multigetAfter1 = davCalls.multiget

  // Second call: should be a hit — no new DAV calls.
  const second = await fetch(`${base}/api/contacts?book=personal`, { headers: authed })
  assert.equal(second.status, 200)
  const j2 = await second.json()
  assert.deepEqual(j2.contacts, j1.contacts)
  assert.equal(davCalls.propfind, propfindAfter1, 'no new PROPFIND on cache hit')
  assert.equal(davCalls.multiget, multigetAfter1, 'no new REPORT on cache hit')
})

test('write (PUT /api/contact) invalidates the /api/contacts cache', async () => {
  await seedAccount('j2@x.com')
  const putVcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:Beta\r\nEND:VCARD'
  const putRes = await fetch(`${base}/api/contact`, {
    method: 'PUT', headers: authed, body: JSON.stringify({ book: 'personal', vcf: putVcf }),
  })
  assert.equal(putRes.status, 200)
  // Force a pre-invalidation cache populate
  const pre = await fetch(`${base}/api/contacts?book=personal`, { headers: authed })
  assert.equal(pre.status, 200)

  // Now write again — should clear cache. Next read must re-hit DAV, so the
  // multiget counter increases.
  const propfindBefore = davCalls.propfind
  const multigetBefore = davCalls.multiget
  const putRes2 = await fetch(`${base}/api/contact`, {
    method: 'PUT', headers: authed, body: JSON.stringify({ book: 'personal', vcf: putVcf }),
  })
  assert.equal(putRes2.status, 200)
  const post = await fetch(`${base}/api/contacts?book=personal`, { headers: authed })
  assert.equal(post.status, 200)
  assert.ok(davCalls.multiget > multigetBefore, 'multiget re-ran after invalidation')
  assert.ok(davCalls.propfind > propfindBefore, 'PROPFIND re-ran after invalidation')
})

test('calendar events is cached and invalidated on write', async () => {
  await seedAccount('j3@x.com')
  const g1 = await fetch(`${base}/api/calendar/events?calendar=personal&start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z`, { headers: authed })
  assert.equal(g1.status, 200)
  const multigetBefore = davCalls.multiget
  const reportBefore = davCalls.report
  const g2 = await fetch(`${base}/api/calendar/events?calendar=personal&start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z`, { headers: authed })
  assert.equal(g2.status, 200)
  assert.deepEqual(await g2.json(), await g1.json())
  // The events REPORT is a REPORT verb, but the DAV fake counts it under
  // `report`. On a cache hit we expect no new REPORT.
  assert.equal(davCalls.multiget, multigetBefore)
  assert.equal(davCalls.report, reportBefore, 'cache hit → no new REPORT')

  // Invalidation on write
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:42\r\nSUMMARY:X\r\nEND:VEVENT\r\nEND:VCALENDAR'
  const put = await fetch(`${base}/api/calendar/event`, {
    method: 'PUT', headers: authed,
    body: JSON.stringify({ calendar: 'personal', ics, uid: '42' }),
  })
  assert.equal(put.status, 200)
  const reportBefore2 = davCalls.report
  const g3 = await fetch(`${base}/api/calendar/events?calendar=personal&start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z`, { headers: authed })
  assert.equal(g3.status, 200)
  assert.ok(davCalls.report > reportBefore2, 'REPORT re-ran after calendar write invalidation')
})

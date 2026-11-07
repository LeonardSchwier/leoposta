// Route-level tests for /api/contacts/import and PUT /api/contact using the
// real Express app, the fake DAV (from server.test.js's setup), and real
// `fetch`. These tests run in the same test file as the rest of the suite.
//
// They are split out this way so they can fail in isolation and are easy to
// find when someone greps for "import validation".

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// Isolate state: data files go to a temp dir, token is fixed. These env vars
// must be set before server/index.js is imported (it reads them at load).
const TOKEN = 'test-token-import-validators'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-import-test-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

// Fake DAV upstream. We record the last PUT body the fake saw so the tests
// can assert what actually went out to the (simulated) CalDAV/CardDAV server.
let davLastBody = null
const fakeDav = http.createServer((req, res) => {
  if (req.method === 'PUT') {
    const chunks = []
    req.on('data', (b) => chunks.push(b))
    req.on('end', () => { davLastBody = Buffer.concat(chunks).toString('utf8') })
  }
  res.writeHead(200, { 'content-type': 'application/xml', etag: '"test-etag"' })
  res.end('<?xml version="1.0"?><multistatus xmlns="DAV:"/>')
})
await new Promise((resolve) => fakeDav.listen(0, '127.0.0.1', resolve))
process.env.DAV_HOST = '127.0.0.1'
process.env.DAV_PORT = String(fakeDav.address().port)
process.env.DAV_TLS = 'false'

const { createApp } = await import('./index.js')

let server
let base
const authed = { 'x-leoposta-token': TOKEN }

// Seed one account via the account endpoint (this is what real clients do).
function seedOneAccount() {
  const body = JSON.stringify({
    name: 'import-test@example.com',
    email: 'import-test@example.com',
    imapHost: 'imap.example.com', 'imapPort': '993', 'imapUser': 'import-test-example-com',
    'smtpHost': 'smtp.example.com', 'smtpPort': '465', 'smtpUser': 'import-test-example-com',
    password: 'x', 'imapTls': true, 'smtpTls': true,
  })
  return fetch(`${base}/api/accounts`, { method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body })
    .then((r) => r.json())
}

before(async () => {
  await new Promise((resolve) => server = createApp().listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve, reject) => fakeDav.close((e) => e ? reject(e) : resolve()))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

// ────────────────────────── POST /api/contacts/import ──────────────────────────

test('POST /api/contacts/import rejects an empty blob with 400 and no DAV PUT', async () => {
  await seedOneAccount()
  davLastBody = null
  const res = await fetch(`${base}/api/contacts/import`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ book: '/dav/path', vcf: '' }),
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /book and vcf required|no cards/i)
  assert.equal(davLastBody, null, 'no PUT should have gone to the DAV server')
})

test('POST /api/contacts/import rejects a card without VERSION with 400', async () => {
  davLastBody = null
  const bad = 'BEGIN:VCARD\r\nUID:ghost\r\nEND:VCARD\r\n'
  const res = await fetch(`${base}/api/contacts/import`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ book: '/dav/path', vcf: bad }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /VERSION|missing/i)
  assert.equal(davLastBody, null, 'no PUT should have gone to the DAV server')
})

test('POST /api/contacts/import rejects an oversized card with 400', async () => {
  davLastBody = null
  // 70KB of filler in the FN field — exceeds the 64KB per-card limit.
  const big = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:' + 'x'.repeat(70 * 1024) + '\r\nEND:VCARD\r\n'
  const res = await fetch(`${base}/api/contacts/import`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ book: '/dav/path', vcf: big }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /too large/i)
})

test('POST /api/contacts/import rejects a too-many-cards payload with 400', async () => {
  davLastBody = null
  // 501 minimal cards, each ~40 bytes — over the MAX_CARDS_PER_IMPORT=500 cap.
  const many = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:u\r\nEND:VCARD\r\n'.repeat(501)
  const res = await fetch(`${base}/api/contacts/import`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ book: '/dav/path', vcf: many }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /too many cards/i)
})

test('POST /api/contacts/import accepts valid cards and PUTs each to DAV', async () => {
  davLastBody = null
  const ok = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:A1\r\nFN:Alice\r\nEND:VCARD\r\n' +
            'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:B1\r\nFN:Bob\r\nEND:VCARD\r\n'
  const res = await fetch(`${base}/api/contacts/import`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ book: '/dav/path', vcf: ok }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.imported, 2)
  assert.equal(body.total, 2)
  // The last of the two PUTs should carry the second card's UID.
  assert.ok(davLastBody)
})

// ─────────────────────────────── PUT /api/contact ──────────────────────────────

test('PUT /api/contact rejects a card without VERSION with 400', async () => {
  davLastBody = null
  const bad = 'BEGIN:VCARD\r\nUID:ghost\r\nEND:VCARD\r\n'
  const res = await fetch(`${base}/api/contact`, {
    method: 'PUT',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ book: '/dav/path', vcf: bad }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /VERSION|missing/i)
  assert.equal(davLastBody, null)
})

test('PUT /api/contact rejects an oversized card with 400', async () => {
  davLastBody = null
  const big = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:x\r\nFN:' + 'x'.repeat(70 * 1024) + '\r\nEND:VCARD\r\n'
  const res = await fetch(`${base}/api/contact`, {
    method: 'PUT',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ book: '/dav/path', vcf: big }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /too large/i)
})

test('PUT /api/contact accepts a valid card and PUTs it to the DAV server', async () => {
  davLastBody = null
  const good = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:good-01\r\nFN:Carol\r\nEND:VCARD\r\n'
  const res = await fetch(`${base}/api/contact`, {
    method: 'PUT',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ book: '/dav/path', vcf: good }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.match(body.uid, /good-01/)
  assert.ok(davLastBody && davLastBody.includes('good-01'))
})

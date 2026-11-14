// POST/PUT /api/accounts with verify:true log in to IMAP+SMTP; they are
// rate-limited so the server can't be used to guess passwords at speed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

const TOKEN = 'ratelimit-token-0123456789abcdef'
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-ratelimit-'))
process.env.LEOPOSTA_VERIFY_TIMEOUT_MS = '2000'

const { createApp } = await import('./index.js')
const json = { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }
let server, base, closedPort

before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
  const tmp = net.createServer()
  await new Promise(r => tmp.listen(0, '127.0.0.1', r))
  closedPort = tmp.address().port
  await new Promise(r => tmp.close(r))
})
after(() => server.close())

const acct = (i, verify) => JSON.stringify({
  email: `u${i}@x.test`, verify,
  imapHost: '127.0.0.1', imapPort: closedPort, imapTls: false, imapUser: 'u', imapPass: 'p',
  smtpHost: '127.0.0.1', smtpPort: closedPort, smtpTls: false, smtpUser: 'u', smtpPass: 'p'
})

test('plain stores (no verify) are never rate-limited', async () => {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: acct(`plain${i}`, undefined) })
    assert.equal(r.status, 200)
  }
})

test('verify:true is limited to 20 per minute, then 429 JSON', async () => {
  const codes = []
  for (let i = 0; i < 21; i++) {
    const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: acct(i, true) })
    codes.push(r.status)
    if (r.status === 429) assert.deepEqual(await r.json(), { error: 'too_many_requests' })
    else await r.body?.cancel()
  }
  assert.ok(codes.slice(0, 20).every(c => c === 400), `first 20 verify (failing login) -> 400: ${codes}`)
  assert.equal(codes[20], 429)
  const put = await fetch(`${base}/api/accounts/uplain0@x.test`, { method: 'PUT', headers: json, body: acct('plain0', true) })
  assert.equal(put.status, 429, 'PUT shares the same limit')
})

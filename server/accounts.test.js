// Account routes: credential verification before saving, DAV URL validation,
// and secrets never leaving the server.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

const TOKEN = 'accounts-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-accounts-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
process.env.LEOPOSTA_VERIFY_TIMEOUT_MS = '3000'
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

const { createApp } = await import('./index.js')
const { state } = await import('./lib/state.js')
const { verifyAccount } = await import('./lib/imap.js')

const json = { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }
let server, base, closedPort

// A tiny IMAP server that greets and rejects every LOGIN — like Dovecot with a
// wrong password.
let imapRejecting
before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
  const tmp = net.createServer()
  await new Promise(r => tmp.listen(0, '127.0.0.1', r))
  closedPort = tmp.address().port
  await new Promise(r => tmp.close(r))
  imapRejecting = net.createServer((sock) => {
    sock.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n')
    sock.on('data', (d) => {
      for (const line of d.toString().split('\r\n').filter(Boolean)) {
        const tag = line.split(' ')[0]
        if (/ CAPABILITY/i.test(line)) sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`)
        else if (/ (LOGIN|AUTHENTICATE)/i.test(line)) sock.write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`)
        else if (/ LOGOUT/i.test(line)) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end() }
        else if (/^\S+$/.test(line)) sock.write('+ \r\n')
        else sock.write(`${tag} BAD unknown\r\n`)
      }
    })
    sock.on('error', () => {})
  })
  await new Promise(r => imapRejecting.listen(0, '127.0.0.1', r))
})
after(async () => {
  await new Promise(r => server.close(r))
  await new Promise(r => imapRejecting.close(r))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})
beforeEach(() => { state.accounts = []; fs.rmSync(path.join(DATA_DIR, 'accounts.json'), { force: true }) })

const body = (extra = {}) => ({
  email: 'v@example.test', name: 'V',
  imapHost: '127.0.0.1', imapPort: imapRejecting.address().port, imapTls: false, imapUser: 'v@example.test', imapPass: 'wrong-pass-123',
  smtpHost: '127.0.0.1', smtpPort: closedPort, smtpTls: false, smtpUser: 'v@example.test', smtpPass: 'wrong-pass-123',
  ...extra
})

test('POST /api/accounts with verify:true and a wrong password: 400 naming IMAP, nothing saved, no password echoed', async () => {
  const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: JSON.stringify(body({ verify: true })) })
  assert.equal(r.status, 400)
  const text = await r.text()
  const b = JSON.parse(text)
  assert.equal(b.field, 'imap')
  assert.match(b.error, /IMAP login to 127\.0\.0\.1:\d+ failed: wrong user name or password/)
  assert.ok(!text.includes('wrong-pass-123'))
  assert.equal(state.accounts.length, 0)
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'accounts.json')), false, 'nothing half-saved')
})

test('POST /api/accounts with verify:true and an unreachable IMAP port: 400 "connection refused"', async () => {
  const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: JSON.stringify(body({ verify: true, imapPort: closedPort })) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /connection refused/)
  assert.equal(state.accounts.length, 0)
})

test('PUT /api/accounts/:email with verify:true and a failing login keeps the stored account unchanged', async () => {
  const add = await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: JSON.stringify(body({ name: 'Before' })) })
  assert.equal(add.status, 200)
  const r = await fetch(`${base}/api/accounts/v%40example.test`, { method: 'PUT', headers: json, body: JSON.stringify({ name: 'After', imapPass: 'x', verify: true }) })
  assert.equal(r.status, 400)
  assert.equal(state.accounts[0].name, 'Before')
  assert.equal(state.accounts[0].imapPass, 'wrong-pass-123')
})

test('verifyAccount: SMTP failure is reported as SMTP after IMAP succeeds', async () => {
  const fakeImap = { on() {}, connect: async () => {}, logout: async () => {} }
  const fakeSmtp = { verify: async () => { throw Object.assign(new Error('Invalid login: 535 Authentication failed'), { code: 'EAUTH' }) }, close() {} }
  await assert.rejects(
    verifyAccount({ imapHost: 'i', imapPort: 1, smtpHost: 's', smtpPort: 2 }, { makeImap: () => fakeImap, makeSmtp: () => fakeSmtp }),
    (e) => e.field === 'smtp' && /SMTP login to s:2 failed: wrong user name or password/.test(e.message))
  await verifyAccount({ imapHost: 'i', imapPort: 1, smtpHost: 's', smtpPort: 2 }, { makeImap: () => fakeImap, makeSmtp: () => ({ verify: async () => true, close() {} }) })
})

test('a davUrl that is not http(s) is rejected with 400 on add and edit', async () => {
  const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: JSON.stringify(body({ davUrl: 'dav.example.test' })) })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).field, 'dav')
  await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: JSON.stringify(body()) })
  const r2 = await fetch(`${base}/api/accounts/v%40example.test`, { method: 'PUT', headers: json, body: JSON.stringify({ davUrl: 'ftp://x/' }) })
  assert.equal(r2.status, 400)
  const r3 = await fetch(`${base}/api/accounts/v%40example.test`, { method: 'PUT', headers: json, body: JSON.stringify({ davUrl: '' }) })
  assert.equal(r3.status, 200, 'an empty davUrl clears it')
})

test('GET /api/accounts and /api/account never contain a password, the stored file keeps them (0600)', async () => {
  await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: JSON.stringify(body({ davUrl: 'https://dav.example.test/', davPass: 'dav-secret-9' })) })
  for (const p of ['/api/accounts', '/api/account']) {
    const text = await (await fetch(`${base}${p}`, { headers: json })).text()
    assert.ok(!/wrong-pass-123|dav-secret-9|imapPass|smtpPass|davPass/.test(text), `${p}: ${text}`)
  }
  const file = path.join(DATA_DIR, 'accounts.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

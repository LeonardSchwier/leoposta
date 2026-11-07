import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as openpgp from 'openpgp'

// Isolate state: data files go to a temp dir, token is fixed. These env vars
// must be set before server/index.js is imported (it reads them at load).
const TOKEN = 'test-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-test-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

const { createApp, processPgp } = await import('./index.js')

let server
let base
const authed = { 'x-leoposta-token': TOKEN }

before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

test('createApp() returns an Express app with a request handler', () => {
  const app = createApp()
  assert.equal(typeof app, 'function')
  assert.equal(typeof app.handle, 'function')
  assert.equal(typeof app.listen, 'function')
})

test('GET /api/account with the right token responds 200 JSON', async () => {
  const res = await fetch(`${base}/api/account`, { headers: authed })
  assert.equal(res.status, 200)
  assert.equal(typeof (await res.json()), 'object')
})

test('no token header gives 401', async () => {
  const res = await fetch(`${base}/api/account`)
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: 'unauthorized' })
})

test('wrong token gives 401', async () => {
  const res = await fetch(`${base}/api/account`, { headers: { 'x-leoposta-token': 'nope' } })
  assert.equal(res.status, 401)
  const res2 = await fetch(`${base}/api/account`, { headers: { 'x-leoposta-token': TOKEN + 'x' } })
  assert.equal(res2.status, 401)
})

test('GET /api/health is open without a header', async () => {
  const res = await fetch(`${base}/api/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

test('?token= works only for idle and attachment GETs', async () => {
  const bad = await fetch(`${base}/api/account?token=${TOKEN}`)
  assert.equal(bad.status, 401)
  const att = await fetch(`${base}/api/message/1/attachment/2?token=${TOKEN}`)
  assert.notEqual(att.status, 401)
})

test('body limits: 2 MB JSON to /api/account gives 413, 1 KB does not', async () => {
  const big = await fetch(`${base}/api/account`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })
  })
  assert.equal(big.status, 413)
  assert.deepEqual(await big.json(), { error: 'too_large' })
  const small = await fetch(`${base}/api/account`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(1024) })
  })
  assert.notEqual(small.status, 413)
})

test('/api/send accepts bodies larger than the 1 MB default', async () => {
  const res = await fetch(`${base}/api/send`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })
  })
  assert.notEqual(res.status, 413)
})

test('PGP: passphrase never persisted; locked until unlocked; wrong passphrase 401', async () => {
  const pass = 'correct horse'
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 't', email: 't@example.com' }], passphrase: pass, format: 'armored'
  })
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: 'Content-Type: text/plain\r\n\r\nsecret body' }),
    encryptionKeys: await openpgp.readKey({ armoredKey: publicKey })
  })
  const json = { ...authed, 'content-type': 'application/json' }
  const put = await fetch(`${base}/api/pgp`, { method: 'PUT', headers: json, body: JSON.stringify({ privateAsc: privateKey, passphrase: pass }) })
  assert.equal(put.status, 200)
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'pgp_passphrase.txt')), false)
  const st = await (await fetch(`${base}/api/pgp/status`, { headers: authed })).json()
  assert.equal(st.hasPassphrase, true)

  // PUT with a passphrase must not unlock: lock first via a fresh lock call
  await fetch(`${base}/api/pgp/lock`, { method: 'POST', headers: authed })
  let r = await processPgp(armored)
  assert.equal(r.decrypted, false)
  assert.equal(r.error, 'pgp_locked')

  const bad = await fetch(`${base}/api/pgp/unlock`, { method: 'POST', headers: json, body: JSON.stringify({ passphrase: 'nope' }) })
  assert.equal(bad.status, 401)
  r = await processPgp(armored)
  assert.equal(r.error, 'pgp_locked')

  const ok = await fetch(`${base}/api/pgp/unlock`, { method: 'POST', headers: json, body: JSON.stringify({ passphrase: pass }) })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true })
  r = await processPgp(armored)
  assert.equal(r.decrypted, true)
  assert.match(r.text, /secret body/)
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'pgp_passphrase.txt')), false)
})

test('scheduled send with attachments persists the attachments on disk', async () => {
  await fetch(`${base}/api/account`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'a@example.com', imapHost: 'localhost', imapUser: 'a', imapPass: 'p',
      smtpHost: 'localhost', smtpUser: 'a', smtpPass: 'p'
    })
  })
  const b64 = Buffer.from('payload-bytes').toString('base64')
  const res = await fetch(`${base}/api/send`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: ['r@example.com'],
      subject: 's',
      body: 'b',
      scheduled: new Date(Date.now() + 3600 * 1000).toISOString(),
      attachments: [{ filename: 'note.txt', content: b64, contentType: 'text/plain' }]
    })
  })
  const data = await res.json()
  assert.equal(data.success, true)
  assert.equal(data.scheduled, true)
  const raw = fs.readFileSync(path.join(DATA_DIR, 'scheduled.json'), 'utf-8')
  const parsed = JSON.parse(raw)
  const last = parsed[parsed.length - 1]
  assert.ok(Array.isArray(last.attachments), 'attachments persisted to scheduled.json')
  assert.equal(last.attachments.length, 1)
  assert.equal(last.attachments[0].filename, 'note.txt')
  assert.equal(last.attachments[0].content, b64)
  assert.equal(last.attachments[0].contentType, 'text/plain')
})

test('credentials: env passwords override and are never written to account.json', async () => {
  process.env.LEOPOSTA_IMAP_PASS = 'envsecret-imap'
  try {
    const res = await fetch(`${base}/api/account`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'a@example.com', imapHost: 'localhost', imapUser: 'a', imapPass: 'filepass',
        smtpHost: 'localhost', smtpUser: 'a', smtpPass: 'smtpfilepass'
      })
    })
    assert.equal(res.status, 200)
    const raw = fs.readFileSync(path.join(DATA_DIR, 'accounts.json'), 'utf-8')
    assert.ok(!raw.includes('envsecret-imap'))
    assert.ok(!raw.includes('"imapPass"'), 'env-sourced imapPass omitted')
    assert.ok(raw.includes('smtpfilepass'), 'non-env smtpPass still stored')
  } finally {
    delete process.env.LEOPOSTA_IMAP_PASS
  }
})

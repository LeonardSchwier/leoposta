// PGP decryption with unprotected and passphrase-protected keys (curve25519
// and RSA 3072): inline and RFC 3156 PGP/MIME, signed+encrypted, encrypted
// attachments; save/unlock never persists the passphrase.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN = 'pgp-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-pgp-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR

const { createApp } = await import('./index.js')
const { processPgp: processFor, findPgpPayload, pgpLock } = await import('./lib/pgp.js')
const { getAccount } = await import('./lib/state.js')
// Keys belong to accounts: these tests use the one account they create.
const processPgp = (input) => processFor(input, getAccount('me@example.test'))
const { parseMessageSource } = await import('./lib/attachments.js')
const { makeKey, inlineEncrypted, pgpMimeEncrypted } = await import('./fixtures/pgpMail.js')

const json = { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }
let server, base
const PASS = 'Kennwort mit Ümlaut ß 42'
let ecc, eccPlain, rsa, sender

before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
  const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'me@example.test', imapHost: '127.0.0.1', smtpHost: '127.0.0.1', imapPass: 'x', smtpPass: 'x' }) })
  assert.equal(r.status, 200)
  ;[ecc, eccPlain, rsa, sender] = await Promise.all([
    makeKey({ type: 'ecc', passphrase: PASS }),
    makeKey({ type: 'ecc' }),
    makeKey({ type: 'rsa', passphrase: PASS }),
    makeKey({ type: 'ecc', email: 'sender@example.test' })
  ])
})
after(async () => {
  await new Promise(r => server.close(r))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

const put = (b) => fetch(`${base}/api/pgp`, { method: 'PUT', headers: json, body: JSON.stringify(b) })
const unlock = (passphrase) => fetch(`${base}/api/pgp/unlock`, { method: 'POST', headers: json, body: JSON.stringify({ passphrase }) })
const lock = () => fetch(`${base}/api/pgp/lock`, { method: 'POST', headers: json })
const status = async () => (await fetch(`${base}/api/pgp/status`, { headers: json })).json()

async function decryptRaw(raw) {
  const parsed = await parseMessageSource(raw)
  const payload = findPgpPayload(parsed)
  assert.ok(payload, 'payload found')
  return { payload, r: await processPgp(payload) }
}

const keyFile = () => path.join(DATA_DIR, 'pgp-keys', `${getAccount('me@example.test').id}.asc`)

function noPassphraseOnDisk() {
  for (const f of fs.readdirSync(DATA_DIR, { recursive: true })) {
    const p = path.join(DATA_DIR, f)
    if (!fs.statSync(p).isFile()) continue
    const c = fs.readFileSync(p, 'utf-8')
    assert.ok(!c.includes(PASS), `${f} contains the passphrase`)
  }
}

for (const [label, keyName] of [['curve25519', 'ecc'], ['RSA 3072', 'rsa']]) {
  test(`${label}, protected: locked → wrong passphrase stays locked → right one decrypts inline + PGP/MIME → lock`, async () => {
    const key = keyName === 'ecc' ? ecc : rsa
    await fetch(`${base}/api/pgp`, { method: 'DELETE', headers: json })
    assert.equal((await put({ privateAsc: key.privateKey })).status, 200, 'saving without passphrase is allowed (stays locked)')
    let st = await status()
    assert.deepEqual([st.hasPrivateKey, st.hasPassphrase, st.unlocked], [true, true, false])

    const inline = await inlineEncrypted({ from: 'a@example.test', to: 'me@example.test', subject: 'i', text: 'Grüße aus Köln — inline', publicKey: key.publicKey })
    const mime = await pgpMimeEncrypted({ from: 'a@example.test', to: 'me@example.test', subject: 'm', text: 'Grüße aus Köln — PGP/MIME', publicKey: key.publicKey })

    let { payload, r } = await decryptRaw(mime)
    assert.equal(payload.mime, true)
    assert.equal(payload.hide.length, 2, 'Version part and encrypted.asc are hidden')
    assert.equal(r.decrypted, false)
    assert.equal(r.error, 'pgp_locked')

    assert.equal((await unlock('falsch')).status, 401)
    st = await status()
    assert.equal(st.unlocked, false)
    ;({ r } = await decryptRaw(inline))
    assert.equal(r.error, 'pgp_locked')

    assert.equal((await unlock(PASS)).status, 200)
    ;({ r } = await decryptRaw(inline))
    assert.equal(r.decrypted, true)
    assert.equal(r.text.trim(), 'Grüße aus Köln — inline', 'inline plaintext is not run through a MIME parser')
    ;({ r } = await decryptRaw(mime))
    assert.equal(r.decrypted, true)
    assert.equal(r.text.trim(), 'Grüße aus Köln — PGP/MIME')
    noPassphraseOnDisk()

    await lock()
    ;({ r } = await decryptRaw(mime))
    assert.equal(r.error, 'pgp_locked')
  })
}

test('unprotected key: decrypts without unlock', async () => {
  await fetch(`${base}/api/pgp`, { method: 'DELETE', headers: json })
  assert.equal((await put({ privateAsc: eccPlain.privateKey })).status, 200)
  await lock()
  const raw = await inlineEncrypted({ from: 'a@example.test', to: 'me@example.test', subject: 'x', text: 'offen', publicKey: eccPlain.publicKey })
  const { r } = await decryptRaw(raw)
  assert.equal(r.decrypted, true)
  assert.equal(r.text.trim(), 'offen')
})

test('PGP/MIME with an encrypted attachment: attachment listed with bytes; signed+encrypted: verified with a known key, null for an unknown one', async () => {
  await fetch(`${base}/api/pgp`, { method: 'DELETE', headers: json })
  await put({ privateAsc: ecc.privateKey, passphrase: PASS })
  const raw = await pgpMimeEncrypted({
    from: 'sender@example.test', to: 'me@example.test', subject: 'att', text: 'Siehe Anhang',
    attachments: [{ filename: 'Übersicht.txt', content: 'Inhalt mit Ümläuten', contentType: 'text/plain; charset=utf-8' }],
    publicKey: ecc.publicKey, signWith: sender.privateKey
  })
  let { r } = await decryptRaw(raw)
  assert.equal(r.decrypted, true)
  assert.equal(r.text.trim(), 'Siehe Anhang')
  assert.deepEqual(r.attachments.map(a => a.filename), ['Übersicht.txt'])
  assert.equal(r.parts[0].toString('utf-8'), 'Inhalt mit Ümläuten')
  assert.equal(r.signed, true)
  assert.equal(r.verified, null, 'signer key unknown → not claimed valid or invalid')

  assert.equal((await put({ publicAsc: sender.publicKey })).status, 200)
  ;({ r } = await decryptRaw(raw))
  assert.equal(r.verified, true, 'v6 verification API: signature checked against stored public keys')
  assert.ok(r.signer)
})

test('saving a protected key with a wrong passphrase: 400 "Wrong passphrase", previous key and unlock state untouched, nothing written', async () => {
  await fetch(`${base}/api/pgp`, { method: 'DELETE', headers: json })
  await put({ privateAsc: eccPlain.privateKey })
  const before = fs.readFileSync(keyFile(), 'utf-8')
  const bad = await put({ privateAsc: rsa.privateKey, passphrase: 'wrong' })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /Wrong passphrase/)
  assert.equal(fs.readFileSync(keyFile(), 'utf-8'), before)
  const junk = await put({ privateAsc: 'not a key' })
  assert.equal(junk.status, 400)
  assert.match((await junk.json()).error, /Not a valid OpenPGP private key/)
})

test('no key configured: error pgp_no_key (UI says "add your key"), not "locked"', async () => {
  await fetch(`${base}/api/pgp`, { method: 'DELETE', headers: json })
  await pgpLock()
  const raw = await inlineEncrypted({ from: 'a@example.test', to: 'me@example.test', subject: 'x', text: 'y', publicKey: ecc.publicKey })
  const { r } = await decryptRaw(raw)
  assert.equal(r.error, 'pgp_no_key')
})

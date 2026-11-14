// PGP keys belong to accounts: each account decrypts with its own key only,
// unlock/lock is per key, removing an account removes its key, and the old
// single global key is migrated to every account.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN = 'pgp-accounts-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-pgpacct-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR

const { createApp } = await import('./index.js')
const pgp = await import('./lib/pgp.js')
const { state, getAccount } = await import('./lib/state.js')
const { parseMessageSource } = await import('./lib/attachments.js')
const { makeKey, inlineEncrypted } = await import('./fixtures/pgpMail.js')

const H = { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }
const as = (email) => ({ ...H, 'x-account': email })
const PASS = 'geheim'
let server, base, keyA, keyB, shared

const account = (email) => ({ email, imapHost: '127.0.0.1', smtpHost: '127.0.0.1', imapPass: 'x', smtpPass: 'x' })
const api = (p, init = {}) => fetch(`${base}/api${p}`, init)

before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
  ;[keyA, keyB, shared] = await Promise.all([
    makeKey({ email: 'a@example.test', passphrase: PASS }),
    makeKey({ email: 'b@example.test' }),
    makeKey({ email: 'legacy@example.test', passphrase: PASS })
  ])
  for (const e of ['a@example.test', 'b@example.test']) {
    assert.equal((await api('/accounts', { method: 'POST', headers: H, body: JSON.stringify(account(e)) })).status, 200)
  }
})
after(async () => {
  await new Promise(r => server.close(r))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

const decryptAs = async (email, raw) => pgp.processPgp(pgp.findPgpPayload(await parseMessageSource(raw)), getAccount(email))

test('each account has its own key: status, decryption and unlock are per account', async () => {
  assert.equal((await api('/pgp', { method: 'PUT', headers: as('a@example.test'), body: JSON.stringify({ privateAsc: keyA.privateKey }) })).status, 200)
  assert.equal((await api('/pgp', { method: 'PUT', headers: as('b@example.test'), body: JSON.stringify({ privateAsc: keyB.privateKey }) })).status, 200)

  const stA = await (await api('/pgp/status', { headers: as('a@example.test') })).json()
  const stB = await (await api('/pgp/status', { headers: as('b@example.test') })).json()
  assert.equal(stA.account, 'a@example.test')
  assert.deepEqual([stA.hasPrivateKey, stA.hasPassphrase, stA.unlocked], [true, true, false])
  assert.deepEqual([stB.hasPrivateKey, stB.hasPassphrase], [true, false])
  assert.deepEqual(stA.userIds.map(u => u.email), ['a@example.test'])
  assert.notEqual(stA.fingerprint, stB.fingerprint)

  const toA = await inlineEncrypted({ from: 'x@example.test', to: 'a@example.test', subject: 's', text: 'for A', publicKey: keyA.publicKey })
  const toB = await inlineEncrypted({ from: 'x@example.test', to: 'b@example.test', subject: 's', text: 'for B', publicKey: keyB.publicKey })

  // B's unprotected key decrypts B's mail, never A's.
  assert.equal((await decryptAs('b@example.test', toB)).text.trim(), 'for B')
  const wrong = await decryptAs('b@example.test', toA)
  assert.equal(wrong.decrypted, false)
  assert.notEqual(wrong.error, 'pgp_locked')

  assert.equal((await decryptAs('a@example.test', toA)).error, 'pgp_locked')
  assert.equal((await api('/pgp/unlock', { method: 'POST', headers: as('a@example.test'), body: JSON.stringify({ passphrase: PASS }) })).status, 200)
  assert.equal((await decryptAs('a@example.test', toA)).text.trim(), 'for A')

  await api('/pgp/lock', { method: 'POST', headers: as('a@example.test') })
  assert.equal((await decryptAs('a@example.test', toA)).error, 'pgp_locked')
})

test('the private key never shows in the accounts API; files are 0600 under pgp-keys/', async () => {
  const list = await (await api('/accounts', { headers: H })).json()
  assert.doesNotMatch(JSON.stringify(list), /PRIVATE KEY/)
  for (const a of state.accounts) {
    const f = pgp.keyFileFor(a)
    assert.equal(path.dirname(f), path.join(DATA_DIR, 'pgp-keys'))
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  }
})

test('removing the key of one account leaves the other; removing an account removes its key', async () => {
  await api('/pgp', { method: 'DELETE', headers: as('a@example.test') })
  assert.equal((await (await api('/pgp/status', { headers: as('a@example.test') })).json()).hasPrivateKey, false)
  assert.equal((await (await api('/pgp/status', { headers: as('b@example.test') })).json()).hasPrivateKey, true)

  await api('/accounts', { method: 'POST', headers: H, body: JSON.stringify(account('c@example.test')) })
  await api('/pgp', { method: 'PUT', headers: as('c@example.test'), body: JSON.stringify({ privateAsc: keyB.privateKey }) })
  const fileC = pgp.keyFileFor(getAccount('c@example.test'))
  assert.ok(fs.existsSync(fileC))
  assert.equal((await api('/accounts/c%40example.test', { method: 'DELETE', headers: H })).status, 200)
  assert.equal(fs.existsSync(fileC), false)
  assert.ok(fs.existsSync(pgp.keyFileFor(getAccount('b@example.test'))), 'B keeps the same key')
})

test('the keyring: public keys are listed, merged, removed one by one', async () => {
  await api('/pgp/publics', { method: 'DELETE', headers: H })
  assert.equal((await api('/pgp', { method: 'PUT', headers: H, body: JSON.stringify({ publicAsc: keyA.publicKey }) })).status, 200)
  assert.equal((await api('/pgp', { method: 'PUT', headers: H, body: JSON.stringify({ publicAsc: keyA.publicKey + '\n' + shared.publicKey }) })).status, 200)
  let keys = (await (await api('/pgp/publics', { headers: H })).json()).keys
  assert.equal(keys.length, 2, 'the same key twice is one entry')
  assert.deepEqual(keys.map(k => k.userIds[0].email).sort(), ['a@example.test', 'legacy@example.test'])
  assert.ok(keys.every(k => k.canEncrypt))
  const fp = keys.find(k => k.userIds[0].email === 'a@example.test').fingerprint
  assert.equal((await api(`/pgp/publics/${fp}`, { method: 'DELETE', headers: H })).status, 200)
  assert.equal((await api(`/pgp/publics/${fp}`, { method: 'DELETE', headers: H })).status, 404)
  assert.equal((await api('/pgp/publics/not-hex', { method: 'DELETE', headers: H })).status, 400)
  keys = (await (await api('/pgp/publics', { headers: H })).json()).keys
  assert.deepEqual(keys.map(k => k.userIds[0].email), ['legacy@example.test'])

  const look = await (await api('/pgp/lookup', { method: 'POST', headers: H, body: JSON.stringify({ recipients: ['Legacy <LEGACY@example.test>', 'nobody@example.test', 'b@example.test'] }) })).json()
  assert.deepEqual(look, { found: ['legacy@example.test', 'b@example.test'], missing: ['nobody@example.test'] }, 'own account keys count as known')
  await api('/pgp/publics', { method: 'DELETE', headers: H })
})

test('a private key cannot be stored without an account', async () => {
  const saved = state.accounts
  state.accounts = []
  try {
    await assert.rejects(pgp.savePgp(null, { privateAsc: keyB.privateKey }), /No account configured/)
  } finally { state.accounts = saved }
})

test('migration: the old global key goes to every account without a key, then the old file is deleted', async () => {
  // a has no key (deleted above), b has its own key.
  fs.writeFileSync(pgp.LEGACY_PRIVATE_FILE, shared.privateKey, { mode: 0o600 })
  const stA = await (await api('/pgp/status', { headers: as('a@example.test') })).json()
  assert.equal(stA.hasPrivateKey, true)
  assert.deepEqual(stA.userIds.map(u => u.email), ['legacy@example.test'])
  const stB = await (await api('/pgp/status', { headers: as('b@example.test') })).json()
  assert.deepEqual(stB.userIds.map(u => u.email), ['b@example.test'], 'an account with its own key keeps it')
  assert.equal(fs.existsSync(pgp.LEGACY_PRIVATE_FILE), false)

  // Mail encrypted to the old key still decrypts (after unlocking).
  const old = await inlineEncrypted({ from: 'x@example.test', to: 'a@example.test', subject: 's', text: 'old mail', publicKey: shared.publicKey })
  await api('/pgp/unlock', { method: 'POST', headers: as('a@example.test'), body: JSON.stringify({ passphrase: PASS }) })
  assert.equal((await decryptAs('a@example.test', old)).text.trim(), 'old mail')
})

test('migration with no account yet keeps the old file until there is one', () => {
  fs.writeFileSync(pgp.LEGACY_PRIVATE_FILE, shared.privateKey, { mode: 0o600 })
  assert.equal(pgp.migrateLegacyKey([]), 0)
  assert.ok(fs.existsSync(pgp.LEGACY_PRIVATE_FILE))
  const fresh = [{ id: 'acct-new1', email: 'n1@example.test' }, { id: 'weird id/../x', email: 'n2@example.test' }]
  assert.equal(pgp.migrateLegacyKey(fresh), 2)
  for (const a of fresh) {
    assert.equal(fs.readFileSync(pgp.keyFileFor(a), 'utf-8'), shared.privateKey)
    assert.equal(path.dirname(pgp.keyFileFor(a)), path.join(DATA_DIR, 'pgp-keys'), 'an odd id cannot escape the key directory')
  }
  assert.equal(fs.existsSync(pgp.LEGACY_PRIVATE_FILE), false)
})

test('signedPart: the exact bytes of the first part, CRLF and LF sources', () => {
  const src = 'Content-Type: multipart/signed; boundary="b1"\r\n\r\npre\r\n--b1\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b1\r\nsig\r\n--b1--\r\n'
  assert.equal(pgp.signedPart(Buffer.from(src), 'b1'), 'Content-Type: text/plain\r\n\r\nhi')
  assert.equal(pgp.signedPart(src.replace(/\r\n/g, '\n'), 'b1'), 'Content-Type: text/plain\n\nhi')
  assert.equal(pgp.signedPart(src, 'nope'), null)
  assert.equal(pgp.signedPart(src, ''), null)
})

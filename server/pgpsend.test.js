// OpenPGP on send (RFC 3156): sign only (multipart/signed), encrypt + sign
// (multipart/encrypted), encrypted to the sender too so the Sent copy is
// readable; a missing recipient key or a locked key sends nothing; Bcc
// recipients get their own ciphertext. Also through POST /api/send against
// a local SMTP server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as openpgp from 'openpgp'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'

const TOKEN = 'pgp-send-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-pgpsend-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR

const { createApp } = await import('./index.js')
const pgp = await import('./lib/pgp.js')
const { buildPgpMail, PgpSendError, addressesOf, pgpOptions } = await import('./lib/pgpSend.js')
const { buildMessageData } = await import('./routes/send.js')
const { getAccount } = await import('./lib/state.js')
const { parseMessageSource } = await import('./lib/attachments.js')
const { makeKey } = await import('./fixtures/pgpMail.js')

const H = { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }
const as = (email) => ({ ...H, 'x-account': email })
const PASS = 'Passwort für Schlüssel'
let server, base, smtp, smtpPort
const received = []
let me, bob, carol

before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
  smtp = new SMTPServer({
    secure: false, authOptional: true, disabledCommands: ['STARTTLS'],
    onAuth(_a, _s, cb) { cb(null, { user: 'x' }) },
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => { received.push({ to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) }); cb() })
    }
  })
  await new Promise(r => smtp.listen(0, '127.0.0.1', r))
  smtpPort = smtp.server.address().port
  ;[me, bob, carol] = await Promise.all([
    makeKey({ email: 'me@example.test', passphrase: PASS }),
    makeKey({ email: 'bob@example.test' }),
    makeKey({ email: 'carol@example.test', type: 'rsa' })
  ])
  // Our account (IMAP on a closed port: the Sent copy fails quietly, which
  // the route never waits for) and bob as a second account (his own key
  // decrypts what he receives).
  for (const email of ['me@example.test', 'bob@example.test']) {
    const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: H, body: JSON.stringify({
      email, name: email === 'me@example.test' ? 'Me Myself' : 'Bob',
      imapHost: '127.0.0.1', imapPort: 1, imapTls: false, imapPass: 'x',
      smtpHost: '127.0.0.1', smtpPort, smtpTls: false, smtpPass: 'x'
    }) })
    assert.equal(r.status, 200)
  }
  await fetch(`${base}/api/pgp`, { method: 'PUT', headers: as('me@example.test'), body: JSON.stringify({ privateAsc: me.privateKey }) })
  await fetch(`${base}/api/pgp`, { method: 'PUT', headers: as('bob@example.test'), body: JSON.stringify({ privateAsc: bob.privateKey }) })
  await fetch(`${base}/api/pgp`, { method: 'PUT', headers: H, body: JSON.stringify({ publicAsc: carol.publicKey }) })
})
after(async () => {
  await new Promise(r => server.close(r))
  await new Promise(r => smtp.close(r))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

const meAcct = () => getAccount('me@example.test')
const unlockMe = () => fetch(`${base}/api/pgp/unlock`, { method: 'POST', headers: as('me@example.test'), body: JSON.stringify({ passphrase: PASS }) })
const lockMe = () => fetch(`${base}/api/pgp/lock`, { method: 'POST', headers: as('me@example.test') })

/** What the app shows for `raw` when read in `account`. */
async function readAs(account, raw) {
  const parsed = await parseMessageSource(raw)
  const payload = pgp.findPgpPayload(parsed, raw)
  assert.ok(payload, 'an OpenPGP payload is found')
  return { parsed, payload, r: await pgp.processPgp(payload, getAccount(account)) }
}

test('pgpOptions / addressesOf', () => {
  assert.equal(pgpOptions(undefined), null)
  assert.equal(pgpOptions({ sign: false, encrypt: false }), null)
  assert.equal(pgpOptions({ sign: 'yes' }), null, 'only true counts')
  assert.deepEqual(pgpOptions({ sign: true }), { sign: true, encrypt: false })
  assert.deepEqual(addressesOf(['"Doe, Jane" <JANE@x.test>, bob@x.test', 'bob@x.test']), ['jane@x.test', 'bob@x.test'])
})

test('sign only: RFC 3156 multipart/signed whose signature verifies, attachments and non-ASCII intact', async () => {
  await unlockMe()
  const data = buildMessageData(meAcct(), {
    to: ['bob@example.test'], subject: 'Signiert ✓', body: 'Grüße,   \ntrailing spaces and a very long line ' + 'x'.repeat(200) + '\nFrom the start of a line',
    attachments: [{ filename: 'Übersicht.bin', content: Buffer.from([0, 1, 2, 255]).toString('base64'), contentType: 'application/octet-stream' }]
  })
  const out = await buildPgpMail(meAcct(), data, { sign: true, encrypt: false })
  assert.equal(out.sends.length, 1)
  const raw = out.sends[0].raw
  const unfolded = raw.toString().replace(/\r\n[ \t]+/g, ' ')
  assert.match(unfolded, /Content-Type: multipart\/signed; micalg=pgp-sha(256|512); protocol="application\/pgp-signature"/)
  assert.doesNotMatch(raw.toString(), /[^\r]\n/, 'CRLF only')
  assert.doesNotMatch(raw.toString(), /\nBcc:/i)
  const { parsed, payload, r } = await readAs('bob@example.test', raw)
  assert.deepEqual(payload.hide.length, 1, 'signature.asc is not shown as an attachment')
  assert.equal(r.signed, true)
  assert.equal(r.verified, true, 'signature verifies with the sender key')
  assert.equal(r.encrypted, false)
  assert.match(parsed.text, /^Grüße, {3}\ntrailing spaces/)
  assert.equal(parsed.subject, 'Signiert ✓')
  const att = parsed.attachments.find(a => a.filename === 'Übersicht.bin')
  assert.deepEqual([...att.content], [0, 1, 2, 255])

  // A changed body no longer verifies.
  const tampered = Buffer.from(raw.toString().replace('trailing spaces', 'trailing spacez'))
  assert.equal((await readAs('bob@example.test', tampered)).r.verified, false)
})

test('sign + encrypt: the recipient decrypts and verifies; the Sent copy decrypts with the own key and keeps Bcc', async () => {
  await unlockMe()
  const data = buildMessageData(meAcct(), {
    to: ['Bob <bob@example.test>'], cc: ['carol@example.test'], subject: 'Geheim', body: 'Nur für euch ✓',
    attachments: [{ filename: 'plan.txt', content: Buffer.from('der Plan').toString('base64'), contentType: 'text/plain' }]
  })
  const out = await buildPgpMail(meAcct(), data, { sign: true, encrypt: true })
  assert.equal(out.sends.length, 1)
  assert.deepEqual(out.sends[0].envelope.to.sort(), ['bob@example.test', 'carol@example.test'])
  const raw = out.sends[0].raw.toString()
  assert.match(raw.replace(/\r\n[ \t]+/g, ' '), /Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"/)
  assert.doesNotMatch(raw, /Nur für|der Plan|plan\.txt/, 'nothing of the content is in clear')
  assert.match(raw, /Subject: Geheim/)

  const bobReads = await readAs('bob@example.test', out.sends[0].raw)
  assert.equal(bobReads.r.decrypted, true)
  assert.equal(bobReads.r.text.trim(), 'Nur für euch ✓')
  assert.equal(bobReads.r.verified, true)
  assert.deepEqual(bobReads.r.attachments.map(a => a.filename), ['plan.txt'])
  assert.equal(bobReads.r.parts[0].toString(), 'der Plan')

  // Carol (keyring only) can decrypt too: encrypted to her key.
  const msg = await openpgp.readMessage({ armoredMessage: bobReads.payload.armored })
  const carolKey = await openpgp.readPrivateKey({ armoredKey: carol.privateKey })
  const { data: plain } = await openpgp.decrypt({ message: msg, decryptionKeys: carolKey })
  assert.match(plain, /Nur f=C3=BCr euch/)

  const sent = await readAs('me@example.test', out.sentRaw)
  assert.equal(sent.r.decrypted, true, 'own key decrypts the Sent copy')
  assert.equal(sent.r.verified, true)
  assert.equal(sent.parsed.messageId, out.messageId)
})

test('encrypt with Bcc: each Bcc recipient gets a separate ciphertext; the main one does not carry the Bcc key', async () => {
  const data = buildMessageData(meAcct(), { to: ['bob@example.test'], bcc: ['carol@example.test'], subject: 'b', body: 'x' })
  const out = await buildPgpMail(meAcct(), data, { sign: false, encrypt: true })
  assert.equal(out.sends.length, 2)
  assert.deepEqual(out.sends[0].envelope.to, ['bob@example.test'])
  assert.deepEqual(out.sends[1].envelope.to, ['carol@example.test'])
  const carolPub = await openpgp.readKey({ armoredKey: carol.publicKey })
  const carolIds = carolPub.getKeyIDs().map(k => k.toHex())
  const idsIn = async (raw) => {
    const { payload } = await readAs('me@example.test', raw)
    return (await openpgp.readMessage({ armoredMessage: payload.armored })).getEncryptionKeyIDs().map(k => k.toHex())
  }
  assert.ok(!(await idsIn(out.sends[0].raw)).some(id => carolIds.includes(id)), 'main copy is not encrypted to the Bcc key')
  assert.ok((await idsIn(out.sends[1].raw)).some(id => carolIds.includes(id)))
  for (const s of out.sends) assert.doesNotMatch(s.raw.toString(), /^Bcc:/im)
  assert.match(out.sentRaw.toString(), /^Bcc: carol@example\.test/im)
  const r = (await readAs('me@example.test', out.sentRaw)).r
  assert.equal(r.decrypted, true)
  assert.equal(r.signed, false)
})

test('a recipient without a key, a locked key, or no own key: PgpSendError, nothing built', async () => {
  const data = buildMessageData(meAcct(), { to: ['bob@example.test', 'nokey@example.test'], cc: ['Also None <none2@example.test>'], body: 'x' })
  await assert.rejects(buildPgpMail(meAcct(), data, { encrypt: true }), (e) => e instanceof PgpSendError && e.code === 'pgp_missing_keys' && e.missing.join() === 'nokey@example.test,none2@example.test' && /nokey@example\.test, none2@example\.test/.test(e.message))
  await lockMe()
  await assert.rejects(buildPgpMail(meAcct(), buildMessageData(meAcct(), { to: ['bob@example.test'], body: 'x' }), { sign: true }), (e) => e.code === 'pgp_locked' && e.status === 423)
  // Encrypt without signing needs no unlock (own key is used as public key).
  const out = await buildPgpMail(meAcct(), buildMessageData(meAcct(), { to: ['bob@example.test'], body: 'x' }), { encrypt: true })
  assert.equal(out.sends.length, 1)
  const noKey = { id: 'acct-none', email: 'none@example.test' }
  await assert.rejects(buildPgpMail(noKey, buildMessageData(noKey, { to: ['bob@example.test'], body: 'x' }), { encrypt: true }), (e) => e.code === 'pgp_no_own_key' && /Sent/.test(e.message))
})

test('POST /api/send with pgp: errors send nothing; signed+encrypted mail reaches SMTP and decrypts', async () => {
  received.length = 0
  const send = (body) => fetch(`${base}/api/send`, { method: 'POST', headers: as('me@example.test'), body: JSON.stringify(body) })
  await lockMe()
  let r = await send({ to: ['bob@example.test'], subject: 's', body: 'b', pgp: { sign: true, encrypt: true } })
  assert.equal(r.status, 423)
  assert.equal((await r.json()).code, 'pgp_locked')
  r = await send({ to: ['stranger@example.test'], subject: 's', body: 'b', pgp: { encrypt: true } })
  assert.equal(r.status, 400)
  const missing = await r.json()
  assert.equal(missing.code, 'pgp_missing_keys')
  assert.deepEqual(missing.missing, ['stranger@example.test'])
  r = await send({ to: ['bob@example.test'], subject: 's', body: 'b', pgp: { sign: true }, scheduled: new Date(Date.now() + 3600e3).toISOString() })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).code, 'pgp_not_schedulable')
  assert.equal(received.length, 0, 'nothing reached SMTP')

  await unlockMe()
  r = await send({ to: ['bob@example.test'], bcc: ['carol@example.test'], subject: 'Über SMTP', body: 'geheimer Text', pgp: { sign: true, encrypt: true } })
  assert.equal(r.status, 200)
  const res = await r.json()
  assert.equal(res.success, true)
  assert.match(res.messageId, /^<.+@example\.test>$/)
  assert.equal(received.length, 2)
  assert.deepEqual(received.map(m => m.to), [['bob@example.test'], ['carol@example.test']])
  const parsed = await simpleParser(received[0].raw)
  assert.equal(parsed.messageId, res.messageId)
  assert.equal(parsed.from.value[0].address, 'me@example.test')
  const { r: shown } = await readAs('bob@example.test', received[0].raw)
  assert.equal(shown.text.trim(), 'geheimer Text')
  assert.equal(shown.verified, true)

  // Without pgp nothing changes: a normal mail.
  received.length = 0
  r = await send({ to: ['bob@example.test'], subject: 'plain', body: 'plain text' })
  assert.equal(r.status, 200)
  assert.doesNotMatch(received[0].raw.toString(), /multipart\/(signed|encrypted)/)
})

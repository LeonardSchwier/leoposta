// OpenPGP on send: RFC 3156 PGP/MIME.
//   sign only:        multipart/signed; protocol="application/pgp-signature"
//                     (the MIME entity + a detached signature.asc)
//   encrypt (+ sign): multipart/encrypted; protocol="application/pgp-encrypted"
//                     (the MIME entity encrypted, and signed inside the
//                     encryption when signing too: RFC 3156 section 6.2)
// The encrypted entity is always also encrypted to the sender's own key so
// the copy in Sent stays readable. A recipient without a key fails the send
// (PgpSendError 'pgp_missing_keys'): nothing ever goes out unencrypted when
// the user asked for encryption.
import crypto from 'node:crypto'
import * as openpgp from 'openpgp'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import MimeNode from 'nodemailer/lib/mime-node/index.js'
import addressparser from 'nodemailer/lib/addressparser/index.js'
import { usableOwnKey, encryptionCandidates } from './pgp.js'

export class PgpSendError extends Error {
  constructor(code, message, { status = 400, ...extra } = {}) {
    super(message)
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

/** `{ sign, encrypt }` from a /api/send body, or null when neither is on. */
export function pgpOptions(raw) {
  if (!raw || typeof raw !== 'object') return null
  const sign = raw.sign === true
  const encrypt = raw.encrypt === true
  return sign || encrypt ? { sign, encrypt } : null
}

/** Bare, lower-cased addresses of a To/Cc/Bcc value (string or list). */
export function addressesOf(value) {
  const flat = []
  const walk = (list) => {
    for (const a of list) {
      if (a.group) walk(a.group)
      else if (a.address) flat.push(a.address.trim().toLowerCase())
    }
  }
  for (const v of [].concat(value || [])) {
    if (typeof v === 'string') walk(addressparser(v))
    else if (v && v.address) flat.push(String(v.address).trim().toLowerCase())
  }
  return [...new Set(flat)]
}

async function canEncryptTo(key) {
  try { return !!(await key.getEncryptionKey()) } catch { return false }
}

/**
 * The usable public keys of each address (keyring + the accounts' own
 * keys): a key matches when one of its user IDs carries that address and it
 * has a valid (not expired or revoked) encryption subkey.
 */
export async function lookupRecipientKeys(addresses) {
  const wanted = addressesOf(addresses)
  const candidates = await encryptionCandidates()
  const byAddress = new Map()
  for (const key of candidates) {
    const emails = new Set(key.users.map(u => u.userID && u.userID.email && u.userID.email.toLowerCase()).filter(Boolean))
    const matches = wanted.filter(a => emails.has(a))
    if (!matches.length || !await canEncryptTo(key)) continue
    for (const a of matches) {
      const list = byAddress.get(a) || []
      if (!list.some(k => k.getFingerprint() === key.getFingerprint())) list.push(key)
      byAddress.set(a, list)
    }
  }
  return {
    keys: byAddress,
    found: wanted.filter(a => byAddress.has(a)),
    missing: wanted.filter(a => !byAddress.has(a))
  }
}

/**
 * The MIME entity that gets signed/encrypted: the body and attachments as
 * nodemailer would send them, with only the Content-* headers. Text parts
 * are quoted-printable, so no line has trailing white space or is long
 * enough for a relay to change it (which would break the signature).
 */
export async function buildEntity({ text, html, attachments }) {
  const mail = { text: text || '', textEncoding: 'quoted-printable' }
  if (html) mail.html = html
  if (attachments && attachments.length) mail.attachments = attachments
  const built = (await new MailComposer(mail).compile().build()).toString('utf-8')
  const sep = built.indexOf('\r\n\r\n')
  const headers = built.slice(0, sep).split(/\r\n(?![ \t])/).filter(h => /^content-/i.test(h)).join('\r\n')
  return headers + '\r\n\r\n' + built.slice(sep + 4)
}

const OUTER_HEADERS = ['from', 'sender', 'to', 'cc', 'bcc', 'reply-to', 'in-reply-to', 'references', 'subject', 'message-id', 'date']

/** The top-level message: the mail's headers around `children`. */
async function assemble(mail, contentType, children, { keepBcc = false } = {}) {
  const root = new MimeNode(contentType, { keepBcc })
  for (const header of OUTER_HEADERS) {
    const key = header.replace(/-(\w)/g, (_, c) => c.toUpperCase())
    if (mail[key]) root.setHeader(header, mail[key])
  }
  for (const c of children) {
    const child = root.createChild(c.contentType)
    if (c.raw !== undefined) { child.setRaw(c.raw); continue }
    for (const [k, v] of Object.entries(c.headers || {})) child.setHeader(k, v)
    child.setContent(c.content)
  }
  return root.build()
}

const sevenBit = { 'Content-Transfer-Encoding': '7bit' }

function encryptedParts(armored) {
  return [
    { contentType: 'application/pgp-encrypted', headers: { 'Content-Description': 'PGP/MIME version identification', ...sevenBit }, content: 'Version: 1\r\n' },
    {
      contentType: 'application/octet-stream; name="encrypted.asc"',
      headers: { 'Content-Description': 'OpenPGP encrypted message', 'Content-Disposition': 'inline; filename="encrypted.asc"', ...sevenBit },
      content: armored.replace(/\r?\n/g, '\r\n')
    }
  ]
}

function micalgOf(signature) {
  const alg = signature.packets[0] && signature.packets[0].hashAlgorithm
  const name = openpgp.enums.read(openpgp.enums.hash, alg) || 'sha256'
  return `pgp-${String(name).toLowerCase()}`
}

function newMessageId(fromAddress) {
  const domain = String(fromAddress || '').split('@')[1] || 'leoposta.local'
  return `<${crypto.randomUUID()}@${domain}>`
}

/**
 * Build the PGP/MIME message(s) for `messageData` (buildMessageData's shape).
 * Returns { messageId, sends: [{ envelope, raw }], sentRaw }: what goes to
 * SMTP (one message; with encryption, one more per Bcc recipient so no
 * recipient learns of a Bcc from the key IDs in the ciphertext) and the
 * copy for Sent (Bcc header kept, readable with the sender's own key).
 * Throws PgpSendError: pgp_no_own_key, pgp_locked, pgp_missing_keys.
 */
export async function buildPgpMail(acct, messageData, { sign, encrypt }, { date = new Date(), messageId } = {}) {
  const { accountId: _ignored, ...mail } = messageData
  void _ignored
  mail.date = date
  mail.messageId = messageId || newMessageId(acct.email)
  const toCc = [...new Set([...addressesOf(mail.to), ...addressesOf(mail.cc)])]
  const bcc = addressesOf(mail.bcc).filter(a => !toCc.includes(a))

  const own = await usableOwnKey(acct)
  if ((sign || encrypt) && !own.own) {
    throw new PgpSendError('pgp_no_own_key', sign
      ? `No PGP key is set up for ${acct.email}. Add it in Settings → PGP to sign mail.`
      : `No PGP key is set up for ${acct.email}. Add it in Settings → PGP: mail is also encrypted to your own key so the copy in Sent stays readable.`)
  }
  if (sign && own.locked) {
    throw new PgpSendError('pgp_locked', `Your PGP key for ${acct.email} is locked. Enter its passphrase to sign.`, { status: 423 })
  }
  const signingKeys = sign ? own.key : undefined

  let recipientKeys = null
  if (encrypt) {
    const found = await lookupRecipientKeys([...toCc, ...bcc])
    if (found.missing.length) {
      throw new PgpSendError('pgp_missing_keys',
        `No PGP public key for ${found.missing.join(', ')}. Import their key in Settings → PGP, or send without encryption.`,
        { missing: found.missing })
    }
    recipientKeys = found.keys
  }

  const entity = await buildEntity(mail)
  const envelopeFrom = acct.email
  const built = { messageId: mail.messageId, sends: [], sentRaw: null }

  if (!encrypt) {
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ text: entity }),
      signingKeys,
      detached: true
    })
    const ct = `multipart/signed; micalg=${micalgOf(await openpgp.readSignature({ armoredSignature: signature }))}; protocol="application/pgp-signature"`
    const children = [
      { contentType: 'text/plain', raw: entity },
      {
        contentType: 'application/pgp-signature; name="signature.asc"',
        headers: { 'Content-Description': 'OpenPGP digital signature', 'Content-Disposition': 'attachment; filename="signature.asc"', ...sevenBit },
        content: signature.replace(/\r?\n/g, '\r\n')
      }
    ]
    built.sends.push({ envelope: { from: envelopeFrom, to: [...toCc, ...bcc] }, raw: await assemble(mail, ct, children) })
    built.sentRaw = await assemble(mail, ct, children, { keepBcc: true })
    return built
  }

  const selfKey = own.own.toPublic()
  const keysFor = (addrs) => [selfKey, ...addrs.flatMap(a => recipientKeys.get(a) || [])]
  const encryptFor = async (addrs) => openpgp.encrypt({
    message: await openpgp.createMessage({ text: entity }),
    encryptionKeys: keysFor(addrs),
    signingKeys
  })
  const ct = 'multipart/encrypted; protocol="application/pgp-encrypted"'
  const main = encryptedParts(await encryptFor(toCc))
  built.sends.push({ envelope: { from: envelopeFrom, to: toCc }, raw: await assemble(mail, ct, main) })
  for (const b of bcc) {
    built.sends.push({ envelope: { from: envelopeFrom, to: [b] }, raw: await assemble(mail, ct, encryptedParts(await encryptFor([...toCc, b]))), bcc: b })
  }
  built.sentRaw = await assemble(mail, ct, main, { keepBcc: true })
  return built
}

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as openpgp from 'openpgp'
import { simpleParser } from 'mailparser'
import { DATA_DIR, state } from './state.js'

// Every account has its own private key: DATA_DIR/pgp-keys/<account id>.asc
// (mode 0600). The public keys of other people (to verify their signatures
// and to encrypt to them) are one shared keyring, pgp_publics.asc.
//
// Passphrases are never persisted. An unlocked key lives in memory only,
// with a 15-minute sliding TTL. It is keyed by fingerprint: two accounts
// that hold the same key (e.g. after the migration below) unlock and lock
// together.
export const PGP_KEY_DIR = path.join(DATA_DIR, 'pgp-keys')
// Before keys belonged to accounts there was one key for all of them.
export const LEGACY_PRIVATE_FILE = path.join(DATA_DIR, 'pgp_private.asc')
const PGP_PUBLIC_FILE = path.join(DATA_DIR, 'pgp_publics.asc')
const KEY_TTL_MS = 15 * 60 * 1000
// A sender can compress a huge plaintext into a tiny encrypted message
// (622 KB -> 450 MB, ~2 GB RSS per open). No real mail is this large.
export const MAX_DECRYPTED_BYTES = 32 * 1024 * 1024
/** fingerprint -> { key: decrypted PrivateKey, expiresAt } */
const unlocked = new Map()

if (fs.existsSync(path.join(DATA_DIR, 'pgp_passphrase.txt'))) {
  console.warn('pgp_passphrase.txt is no longer used; delete it')
}

const PGP_ARMOR_RE = /-----BEGIN PGP (?:MESSAGE|SIGNED MESSAGE|ENCRYPTED MESSAGE)[\s\S]*?-----END PGP (?:MESSAGE|SIGNED MESSAGE|ENCRYPTED MESSAGE)[\s\S]*?-----/

/** The key file of an account. Ids that are not plain file names are hashed. */
export function keyFileFor(acct) {
  const id = String((acct && (acct.id || acct.email)) || '')
  const safe = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(id)
    ? id
    : crypto.createHash('sha256').update(id).digest('hex')
  return path.join(PGP_KEY_DIR, `${safe}.asc`)
}

function writePrivate(file, armored) {
  fs.mkdirSync(PGP_KEY_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, armored, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * Migration from the single global key (pgp_private.asc). That key used to
 * decrypt the mail of every account, so it is copied to every account that
 * has no key of its own yet: nothing that could be read before becomes
 * unreadable. (Giving it only to the account whose address is in the key
 * would lock users out of mail sent to an alias or forwarded into another
 * account.) The user can remove it from accounts it does not belong to.
 * The legacy file is deleted only after every copy was written and read
 * back. Without any account yet, the file stays until the first one exists.
 */
export function migrateLegacyKey(accounts = state.accounts) {
  if (!accounts.length || !fs.existsSync(LEGACY_PRIVATE_FILE)) return 0
  try {
    const armored = fs.readFileSync(LEGACY_PRIVATE_FILE, 'utf-8')
    let copied = 0
    for (const a of accounts) {
      const f = keyFileFor(a)
      if (fs.existsSync(f)) continue
      writePrivate(f, armored)
      if (fs.readFileSync(f, 'utf-8') !== armored) throw new Error(`could not write ${f}`)
      copied++
    }
    fs.unlinkSync(LEGACY_PRIVATE_FILE)
    console.log(`[pgp] moved the PGP private key to ${copied} account(s): ${accounts.map(a => a.email).join(', ')}`)
    return copied
  } catch (err) {
    console.error('[pgp] could not move the PGP private key to the accounts:', err && err.message)
    return 0
  }
}

async function readOwnKey(acct) {
  migrateLegacyKey()
  if (!acct) return null
  const f = keyFileFor(acct)
  if (!fs.existsSync(f)) return null
  return openpgp.readPrivateKey({ armoredKey: fs.readFileSync(f, 'utf-8') })
}

export function hasOwnKey(acct) {
  migrateLegacyKey()
  return !!acct && fs.existsSync(keyFileFor(acct))
}

function unlockedFor(privateKey) {
  if (!privateKey) return null
  const fp = privateKey.getFingerprint()
  const u = unlocked.get(fp)
  if (!u) return null
  if (Date.now() > u.expiresAt) { unlocked.delete(fp); return null }
  u.expiresAt = Date.now() + KEY_TTL_MS
  return u.key
}

function remember(key) {
  unlocked.set(key.getFingerprint(), { key, expiresAt: Date.now() + KEY_TTL_MS })
}

/**
 * The account's private key ready for signing/decryption: the unprotected
 * key itself, the unlocked copy of a protected one, or null (no key, or
 * locked). `{ key, locked }` tells the two null cases apart.
 */
export async function usableOwnKey(acct) {
  const k = await readOwnKey(acct)
  if (!k) return { key: null, locked: false, own: null }
  if (k.isDecrypted()) return { key: k, locked: false, own: k }
  const u = unlockedFor(k)
  return { key: u, locked: !u, own: k }
}

/** Lock the key of `acct` (every account holding the same key), or all keys. */
export async function pgpLock(acct) {
  if (acct === undefined) { unlocked.clear(); return }
  const k = await readOwnKey(acct).catch(() => null)
  if (k) unlocked.delete(k.getFingerprint())
}

function userIdsOf(key) {
  return key.users.map(u => u.userID).filter(Boolean).map(u => ({ name: u.name || '', email: (u.email || '').toLowerCase() }))
}

export async function pgpState(acct) {
  let k = null
  try { k = await readOwnKey(acct) } catch {}
  return {
    account: (acct && acct.email) || null,
    hasPrivateKey: !!k,
    hasPublicKey: (await readPublicKeys()).length > 0,
    hasPassphrase: !!k && !k.isDecrypted(),
    unlocked: !!k && !k.isDecrypted() && !!unlockedFor(k),
    fingerprint: k ? k.getFingerprint().toUpperCase() : null,
    userIds: k ? userIdsOf(k) : []
  }
}

/** openpgp's "Incorrect key passphrase" etc. → one message a user understands. */
export class BadPassphraseError extends Error {
  constructor() { super('Wrong passphrase for this private key'); this.code = 'bad_passphrase' }
}

async function decryptWithPassphrase(privateKey, passphrase) {
  try {
    return await openpgp.decryptKey({ privateKey, passphrase })
  } catch {
    throw new BadPassphraseError()
  }
}

/**
 * Store the private key of `acct` and/or add a public key to the shared
 * keyring. Everything is validated first: a key that does not parse, a
 * public key pasted as private key, or a protected key with a wrong
 * passphrase leaves the stored files untouched. The passphrase only unlocks
 * the key in memory; it is never written anywhere.
 */
export async function savePgp(acct, { privateAsc, publicAsc, passphrase }) {
  let key = null
  let unlockedKey = null
  if (privateAsc) {
    if (!acct) throw new Error('No account configured: add an account before its PGP key')
    try {
      key = await openpgp.readPrivateKey({ armoredKey: privateAsc })
    } catch (e) {
      throw new Error(`Not a valid OpenPGP private key (${e.message})`)
    }
    if (!key.isDecrypted() && typeof passphrase === 'string' && passphrase.length) {
      unlockedKey = await decryptWithPassphrase(key, passphrase)
    } else if (key.isDecrypted()) {
      unlockedKey = key
    }
  }
  let pubs = null
  if (publicAsc) {
    try {
      pubs = await readArmoredKeys(publicAsc)
    } catch (e) {
      throw new Error(`Not a valid OpenPGP public key (${e.message})`)
    }
  }
  if (key) {
    writePrivate(keyFileFor(acct), privateAsc.trim() + '\n')
    if (unlockedKey && !key.isDecrypted()) remember(unlockedKey)
  }
  if (pubs) {
    const known = await readPublicKeys()
    const byFp = new Map(known.map(k => [k.getFingerprint(), k]))
    for (const p of pubs) {
      const fp = p.getFingerprint()
      // A newer copy of a known key (new user ID, extended expiry) is merged in.
      byFp.set(fp, byFp.has(fp) ? await byFp.get(fp).update(p.toPublic()).catch(() => byFp.get(fp)) : p.toPublic())
    }
    writePublicKeys([...byFp.values()])
  }
  return pgpState(acct)
}

function writePublicKeys(keys) {
  if (!keys.length) { try { fs.unlinkSync(PGP_PUBLIC_FILE) } catch {} ; return }
  fs.writeFileSync(PGP_PUBLIC_FILE, keys.map(k => k.armor().trim()).join('\n\n') + '\n', { mode: 0o600 })
}

/** Remove the private key of `acct` (other accounts keep theirs). */
export async function deletePgp(acct) {
  if (acct) {
    const k = await readOwnKey(acct).catch(() => null)
    try { fs.unlinkSync(keyFileFor(acct)) } catch {}
    if (k && !(await fingerprintsInUse()).has(k.getFingerprint())) unlocked.delete(k.getFingerprint())
  }
  return pgpState(acct)
}

async function fingerprintsInUse() {
  const fps = new Set()
  for (const a of state.accounts) {
    const k = await readOwnKey(a).catch(() => null)
    if (k) fps.add(k.getFingerprint())
  }
  return fps
}

/** Account removed: its key goes with it. */
export async function removeAccountKey(acct) {
  return deletePgp(acct)
}

/** The shared keyring: one entry per key, for Settings. */
export async function listPublicKeys() {
  const out = []
  for (const k of await readPublicKeys()) {
    out.push({
      fingerprint: k.getFingerprint().toUpperCase(),
      userIds: userIdsOf(k),
      canEncrypt: !!(await k.getEncryptionKey().catch(() => null))
    })
  }
  return out
}

/** Remove one key (by fingerprint) from the keyring, or all of them. */
export async function deletePublicKeys(fingerprint) {
  if (!fingerprint) { try { fs.unlinkSync(PGP_PUBLIC_FILE) } catch {} ; return true }
  const keys = await readPublicKeys()
  const left = keys.filter(k => k.getFingerprint().toUpperCase() !== String(fingerprint).toUpperCase())
  if (left.length === keys.length) return false
  writePublicKeys(left)
  return true
}

export async function unlockFromPassphrase(acct, passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('bad_passphrase')
  const privateKey = await readOwnKey(acct)
  if (!privateKey) throw new Error('no_private_key')
  if (privateKey.isDecrypted()) return
  remember(await decryptWithPassphrase(privateKey, passphrase))
}

const ARMORED_MESSAGE_RE = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/
const CLEARSIGNED_RE = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/

/**
 * Where the OpenPGP payload of a parsed message is (mailparser result):
 *   PGP/MIME (RFC 3156 multipart/encrypted): the application/octet-stream
 *     part next to the application/pgp-encrypted "Version: 1" part; both are
 *     internal and not shown as attachments (`hide` = their indexes).
 *   PGP/MIME signed (RFC 3156 multipart/signed): needs the raw `source`,
 *     as the signature covers the exact bytes of the first body part;
 *     returns { signed: { data, signature }, hide: [signature.asc] }.
 *   inline: an armored block inside the text/plain body.
 * Returns { armored, mime, hide } / { signed, hide } or null.
 */
export function findPgpPayload(parsed, source) {
  const ct = parsed && parsed.headers && parsed.headers.get && parsed.headers.get('content-type')
  const atts = (parsed && parsed.attachments) || []
  const isPgpMime = ct && ct.value === 'multipart/encrypted' && /application\/pgp-encrypted/i.test(String(ct.params && ct.params.protocol))
  const ctlIdx = atts.findIndex(a => /application\/pgp-encrypted/i.test(a.contentType || ''))
  if (isPgpMime || ctlIdx !== -1) {
    const dataIdx = atts.findIndex(a => a.content && ARMORED_MESSAGE_RE.test(a.content.toString('utf-8')))
    if (dataIdx !== -1) {
      const armored = atts[dataIdx].content.toString('utf-8').match(ARMORED_MESSAGE_RE)[0]
      return { armored, mime: true, hide: [ctlIdx, dataIdx].filter(i => i >= 0) }
    }
  }
  const isSigned = ct && ct.value === 'multipart/signed' && /application\/pgp-signature/i.test(String(ct.params && ct.params.protocol))
  if (isSigned && source) {
    const sigIdx = atts.findIndex(a => /application\/pgp-signature/i.test(a.contentType || ''))
    const data = signedPart(source, ct.params.boundary)
    if (sigIdx !== -1 && data !== null) {
      return { signed: { data, signature: atts[sigIdx].content.toString('utf-8') }, hide: [sigIdx] }
    }
  }
  const text = (parsed && parsed.text) || ''
  const m = text.match(ARMORED_MESSAGE_RE)
  if (m) return { armored: m[0], mime: false, hide: [], text }
  return null
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The first body part of a top-level multipart (headers + body, exactly as
 * in the source): from after the first delimiter line up to, not including,
 * the line break before the next delimiter (RFC 3156 section 5).
 */
export function signedPart(source, boundary) {
  if (!boundary) return null
  const raw = Buffer.isBuffer(source) ? source.toString('utf-8') : String(source)
  const headEnd = raw.search(/\r?\n\r?\n/)
  if (headEnd === -1) return null
  const body = raw.slice(headEnd)
  const b = escapeRe(boundary)
  const open = new RegExp(`(?:^|\\r?\\n)--${b}[ \\t]*\\r?\\n`).exec(body)
  if (!open) return null
  const start = open.index + open[0].length
  const close = new RegExp(`\\r?\\n--${b}(?:--)?[ \\t]*(?:\\r?\\n|$)`).exec(body.slice(start))
  if (!close) return null
  return body.slice(start, start + close.index)
}

/** Keys that can verify a signature: the keyring and every account's own key. */
async function verificationKeys() {
  const own = []
  for (const a of state.accounts) {
    const k = await readOwnKey(a).catch(() => null)
    if (k) own.push(k.toPublic())
  }
  return [...own, ...await readPublicKeys()]
}

/** All public keys a mail can be encrypted to: keyring + accounts' own keys. */
export async function encryptionCandidates() {
  return verificationKeys()
}

/** RFC 3156 multipart/signed: check the detached signature over the part. */
async function verifyDetached({ data, signature }) {
  try {
    const res = await openpgp.verify({
      message: await openpgp.createMessage({ text: data }),
      signature: await openpgp.readSignature({ armoredSignature: signature }),
      verificationKeys: await verificationKeys()
    })
    return { encrypted: false, signed: true, ...await signatureStatus(res.signatures) }
  } catch {
    return { encrypted: false, signed: true, verified: false, signer: null }
  }
}

const PUBLIC_BEGIN = '-----BEGIN PGP PUBLIC KEY BLOCK-----'
const PUBLIC_END = '-----END PGP PUBLIC KEY BLOCK-----'

/** The armored public key blocks in a text, by index scans: a lazy regex
 * rescans to the end from every BEGIN without an END (quadratic on a paste
 * of many BEGIN lines). null when there is none, like String#match. */
export function publicBlocks(text) {
  const blocks = []
  let from = 0
  for (;;) {
    const start = text.indexOf(PUBLIC_BEGIN, from)
    if (start < 0) break
    const end = text.indexOf(PUBLIC_END, start + PUBLIC_BEGIN.length)
    if (end < 0) break // no END after this BEGIN: none after any later one either
    blocks.push(text.slice(start, end + PUBLIC_END.length))
    from = end + PUBLIC_END.length
  }
  return blocks.length ? blocks : null
}

/** Every key in a text with one or more armored public key blocks (one
 * armor block may hold several keys; openpgp reads one block per call). */
async function readArmoredKeys(text, { lenient = false } = {}) {
  const blocks = publicBlocks(String(text))
  if (!blocks) {
    if (lenient) return []
    throw new Error('no -----BEGIN PGP PUBLIC KEY BLOCK----- found')
  }
  const keys = []
  for (const b of blocks) {
    try {
      keys.push(...await openpgp.readKeys({ armoredKeys: b }))
    } catch (e) {
      // One damaged entry in the stored keyring must not hide the others.
      if (!lenient) throw e
    }
  }
  return keys
}

function readPublicKeys() {
  if (!fs.existsSync(PGP_PUBLIC_FILE)) return Promise.resolve([])
  return readArmoredKeys(fs.readFileSync(PGP_PUBLIC_FILE, 'utf-8'), { lenient: true }).catch(() => [])
}

// RFC 3156 decrypted payload is a MIME entity; an inline message is just text.
function looksLikeMime(s) {
  return /^(?:[\w-]+:[^\r\n]*\r?\n(?:[ \t][^\r\n]*\r?\n)*)*content-type:/i.test(s.trimStart())
}

/** One signature's outcome: true (good), false (bad), null (unknown key). */
async function signatureStatus(signatures) {
  let verified = null
  let signer = null
  for (const s of signatures || []) {
    signer = signer || (s.keyID && s.keyID.toHex && s.keyID.toHex()) || null
    try {
      await s.verified
      return { verified: true, signer: (s.keyID && s.keyID.toHex && s.keyID.toHex()) || signer }
    } catch (e) {
      if (!/could not find signing key/i.test(String(e && e.message))) verified = false
    }
  }
  return { verified, signer }
}

/**
 * Decrypt a message. `input` is either a string that contains an armored
 * PGP MESSAGE (an inline body, or a raw source) or a payload from
 * findPgpPayload. Returns null when there is nothing to decrypt; otherwise
 *   { encrypted: true, decrypted: true, text, html, attachments, parts, signed, verified, signer }
 *   { encrypted: true, decrypted: false, armored, error }   error: 'pgp_locked'
 *     (protected key, not unlocked) | 'pgp_no_key' | a decryption error.
 * `parts` holds the decrypted attachment bytes (index-aligned with
 * `attachments`); routes must never serialize it.
 */
export async function processPgp(input, acct) {
  let payload = input
  if (typeof input === 'string') {
    if (!input || !PGP_ARMOR_RE.test(input)) return null
    const armoredAny = input.match(PGP_ARMOR_RE)[0]
    if (/BEGIN PGP (?:PUBLIC|PRIVATE) KEY/.test(armoredAny)) return { encrypted: false, isKey: true, armored: armoredAny }
    const m = input.match(ARMORED_MESSAGE_RE)
    if (!m) {
      const cs = input.match(CLEARSIGNED_RE)
      if (!cs) return null
      try {
        const msg = await openpgp.readCleartextMessage({ cleartextMessage: cs[0] })
        const res = await openpgp.verify({ message: msg, verificationKeys: await verificationKeys() })
        return { encrypted: false, signed: true, ...await signatureStatus(res.signatures) }
      } catch { return { encrypted: false, signed: true, verified: false, signer: null } }
    }
    payload = { armored: m[0], mime: undefined, hide: [], text: input }
  }
  if (payload && payload.signed) return verifyDetached(payload.signed)
  if (!payload || !payload.armored) return null
  const armored = payload.armored
  try {
    // The key of the account the message belongs to; no other account's.
    const { key: decryptedKey, locked, own } = await usableOwnKey(acct)
    if (!own) return { encrypted: true, decrypted: false, armored, error: 'pgp_no_key' }
    if (locked) return { encrypted: true, decrypted: false, armored, error: 'pgp_locked' }
    const msg = await openpgp.readMessage({ armoredMessage: armored })
    const { data, signatures } = await openpgp.decrypt({ message: msg, decryptionKeys: [decryptedKey], verificationKeys: await verificationKeys(), expectSigned: false, config: { maxDecompressedMessageSize: MAX_DECRYPTED_BYTES } })
    const plain = typeof data === 'string' ? data : new TextDecoder().decode(data)
    let text = '', html = ''
    const attachments = []
    const parts = []
    const mime = payload.mime === undefined ? looksLikeMime(plain) : payload.mime
    if (mime) {
      try {
        const parsed = await simpleParser(Buffer.from(plain, 'utf-8'))
        text = (parsed.text || '').replace(/[\u200C\u200D\u200B-\u200F\uFEFF]/g, '')
        html = parsed.html || ''
        for (const att of parsed.attachments || []) {
          parts.push(att.content)
          attachments.push({
            filename: att.filename || `attachment-${attachments.length + 1}`,
            contentType: att.contentType || att.mimeType || '',
            size: att.content?.length || 0,
            contentId: att.contentId || undefined
          })
        }
      } catch {}
      if (!text && !html && !attachments.length) text = plain.trim()
    } else {
      // Inline: put the plaintext where the armored block was.
      const around = payload.text || armored
      text = around.replace(armored, plain.trimEnd())
    }
    const { verified, signer } = await signatureStatus(signatures)
    return { encrypted: true, decrypted: true, text, html, attachments, parts, signed: !!(signatures && signatures.length), verified, signer }
  } catch (err) {
    return { encrypted: true, decrypted: false, armored, error: err.message }
  }
}

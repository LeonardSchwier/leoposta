import fs from 'node:fs'
import path from 'node:path'
import * as openpgp from 'openpgp'
import { simpleParser } from 'mailparser'
import { DATA_DIR } from './state.js'

// Passphrase is never persisted. The unlocked key lives in memory only,
// with a 15-minute sliding TTL.
const PGP_PRIVATE_FILE = path.join(DATA_DIR, 'pgp_private.asc')
const PGP_PUBLIC_FILE = path.join(DATA_DIR, 'pgp_publics.asc')
const KEY_TTL_MS = 15 * 60 * 1000
// A sender can compress a huge plaintext into a tiny encrypted message
// (622 KB -> 450 MB, ~2 GB RSS per open). No real mail is this large.
export const MAX_DECRYPTED_BYTES = 32 * 1024 * 1024
let unlocked = null

if (fs.existsSync(path.join(DATA_DIR, 'pgp_passphrase.txt'))) {
  console.warn('pgp_passphrase.txt is no longer used; delete it')
}

const PGP_ARMOR_RE = /-----BEGIN PGP (?:MESSAGE|SIGNED MESSAGE|ENCRYPTED MESSAGE)[\s\S]*?-----END PGP (?:MESSAGE|SIGNED MESSAGE|ENCRYPTED MESSAGE)[\s\S]*?-----/

export function getUnlockedKey() {
  if (!unlocked) return null
  if (Date.now() > unlocked.expiresAt) { unlocked = null; return null }
  unlocked.expiresAt = Date.now() + KEY_TTL_MS
  return unlocked.key
}

export function pgpLock() {
  unlocked = null
}

export async function pgpState() {
  let hasPassphrase = false
  if (fs.existsSync(PGP_PRIVATE_FILE)) {
    try {
      const k = await openpgp.readPrivateKey({ armoredKey: fs.readFileSync(PGP_PRIVATE_FILE, 'utf-8') })
      hasPassphrase = !k.isDecrypted()
    } catch {}
  }
  return {
    hasPrivateKey: fs.existsSync(PGP_PRIVATE_FILE),
    hasPublicKey: fs.existsSync(PGP_PUBLIC_FILE),
    hasPassphrase,
    unlocked: !!getUnlockedKey()
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
 * Store the private and/or public key. Everything is validated first — a
 * key that does not parse, or a protected key with a wrong passphrase,
 * leaves the stored files untouched. The passphrase only unlocks the key in
 * memory; it is never written anywhere.
 */
export async function savePgp({ privateAsc, publicAsc, passphrase }) {
  let key = null
  let unlockedKey = null
  if (privateAsc) {
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
  let pub = null
  if (publicAsc) {
    try {
      pub = await openpgp.readKey({ armoredKey: publicAsc })
    } catch (e) {
      throw new Error(`Not a valid OpenPGP public key (${e.message})`)
    }
  }
  if (key) {
    fs.writeFileSync(PGP_PRIVATE_FILE, privateAsc.trim() + '\n', { mode: 0o600 })
    unlocked = unlockedKey ? { key: unlockedKey, expiresAt: Date.now() + KEY_TTL_MS } : null
  }
  if (pub) {
    const trimmed = publicAsc.trim()
    const existing = fs.existsSync(PGP_PUBLIC_FILE) ? fs.readFileSync(PGP_PUBLIC_FILE, 'utf-8') : ''
    if (!existing.includes(trimmed)) {
      fs.writeFileSync(PGP_PUBLIC_FILE, (existing ? existing.replace(/\s+$/, '') + '\n\n' : '') + trimmed + '\n', { mode: 0o600 })
    }
  }
  return pgpState()
}

export function deletePgp() {
  unlocked = null
  for (const f of [PGP_PRIVATE_FILE, PGP_PUBLIC_FILE]) {
    try { fs.unlinkSync(f) } catch {}
  }
  return pgpState()
}

export async function unlockFromPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('bad_passphrase')
  if (!fs.existsSync(PGP_PRIVATE_FILE)) throw new Error('no_private_key')
  const privateKey = await openpgp.readPrivateKey({ armoredKey: fs.readFileSync(PGP_PRIVATE_FILE, 'utf-8') })
  const key = privateKey.isDecrypted() ? privateKey : await decryptWithPassphrase(privateKey, passphrase)
  unlocked = { key, expiresAt: Date.now() + KEY_TTL_MS }
}

const ARMORED_MESSAGE_RE = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/
const CLEARSIGNED_RE = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/

/**
 * Where the encrypted payload of a parsed message is (mailparser result):
 *   PGP/MIME (RFC 3156 multipart/encrypted): the application/octet-stream
 *     part next to the application/pgp-encrypted "Version: 1" part; both are
 *     internal and not shown as attachments (`hide` = their indexes).
 *   inline: an armored block inside the text/plain body.
 * Returns { armored, mime, hide } or null.
 */
export function findPgpPayload(parsed) {
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
  const text = (parsed && parsed.text) || ''
  const m = text.match(ARMORED_MESSAGE_RE)
  if (m) return { armored: m[0], mime: false, hide: [], text }
  return null
}

function readPublicKeys() {
  if (!fs.existsSync(PGP_PUBLIC_FILE)) return Promise.resolve([])
  return openpgp.readKeys({ armoredKeys: fs.readFileSync(PGP_PUBLIC_FILE, 'utf-8') }).catch(() => [])
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
export async function processPgp(input) {
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
        const own = fs.existsSync(PGP_PRIVATE_FILE) ? [(await openpgp.readPrivateKey({ armoredKey: fs.readFileSync(PGP_PRIVATE_FILE, 'utf-8') })).toPublic()] : []
        const res = await openpgp.verify({ message: msg, verificationKeys: [...own, ...await readPublicKeys()] })
        return { encrypted: false, signed: true, ...await signatureStatus(res.signatures) }
      } catch { return { encrypted: false, signed: true, verified: false, signer: null } }
    }
    payload = { armored: m[0], mime: undefined, hide: [], text: input }
  }
  if (!payload || !payload.armored) return null
  const armored = payload.armored
  if (!fs.existsSync(PGP_PRIVATE_FILE)) {
    return { encrypted: true, decrypted: false, armored, error: 'pgp_no_key' }
  }
  try {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: fs.readFileSync(PGP_PRIVATE_FILE, 'utf-8') })
    let decryptedKey = privateKey
    if (!privateKey.isDecrypted()) {
      decryptedKey = getUnlockedKey()
      if (!decryptedKey) return { encrypted: true, decrypted: false, armored, error: 'pgp_locked' }
    }
    const msg = await openpgp.readMessage({ armoredMessage: armored })
    const verificationKeys = [privateKey.toPublic(), ...await readPublicKeys()]
    const { data, signatures } = await openpgp.decrypt({ message: msg, decryptionKeys: [decryptedKey], verificationKeys, expectSigned: false, config: { maxDecompressedMessageSize: MAX_DECRYPTED_BYTES } })
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
      text = around.replace(armored, plain.replace(/\s+$/, ''))
    }
    const { verified, signer } = await signatureStatus(signatures)
    return { encrypted: true, decrypted: true, text, html, attachments, parts, signed: !!(signatures && signatures.length), verified, signer }
  } catch (err) {
    return { encrypted: true, decrypted: false, armored, error: err.message }
  }
}

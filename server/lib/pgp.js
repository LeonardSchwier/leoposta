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

export async function savePgp({ privateAsc, publicAsc, passphrase }) {
  if (privateAsc) {
    await openpgp.readPrivateKey({ armoredKey: privateAsc })
    fs.writeFileSync(PGP_PRIVATE_FILE, privateAsc.trim() + '\n', { mode: 0o600 })
    unlocked = null
  }
  if (publicAsc) {
    await openpgp.readKey({ armoredKey: publicAsc })
    const trimmed = publicAsc.trim()
    const existing = fs.existsSync(PGP_PUBLIC_FILE) ? fs.readFileSync(PGP_PUBLIC_FILE, 'utf-8') : ''
    if (!existing.includes(trimmed)) {
      fs.writeFileSync(PGP_PUBLIC_FILE, (existing ? existing.replace(/\s+$/, '') + '\n\n' : '') + trimmed + '\n')
    }
  }
  // `passphrase` is accepted for backward compat but never stored.
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
  const key = privateKey.isDecrypted() ? privateKey : await openpgp.decryptKey({ privateKey, passphrase })
  unlocked = { key, expiresAt: Date.now() + KEY_TTL_MS }
}

// Returns null if body has no PGP armor; otherwise a status object.
export async function processPgp(plainBody) {
  if (!plainBody || !PGP_ARMOR_RE.test(plainBody)) return null
  const armored = plainBody.match(PGP_ARMOR_RE)[0]
  if (/BEGIN PGP (?:PUBLIC|PRIVATE) KEY/.test(armored)) {
    return { encrypted: false, isKey: true, armored }
  }
  if (!fs.existsSync(PGP_PRIVATE_FILE)) {
    return { encrypted: true, decrypted: false, armored, error: 'No PGP private key configured' }
  }
  try {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: fs.readFileSync(PGP_PRIVATE_FILE, 'utf-8') })
    let decryptedKey = privateKey
    if (!privateKey.isDecrypted()) {
      decryptedKey = getUnlockedKey()
      if (!decryptedKey) return { encrypted: true, decrypted: false, armored, error: 'pgp_locked' }
    }
    const msg = await openpgp.readMessage({ armoredMessage: armored })
    const { data } = await openpgp.decrypt({ message: msg, decryptionKeys: [decryptedKey] })
    const mime = await data.toString()
    let text = '', html = ''
    const attachments = []
    try {
      const parsed = await simpleParser(mime)
      text = (parsed.text || '').replace(/[\u200C\u200D\u200B-\u200F\uFEFF]/g, '')
      html = parsed.html || ''
      for (const att of parsed.attachments || []) {
        attachments.push({
          id: att.filename || 'attachment',
          filename: att.filename,
          contentType: att.contentType || att.mimeType || '',
          size: att.content?.length || 0,
          contentId: att.contentId || undefined
        })
      }
    } catch {}
    if (!text && !html) { text = mime.trim() }
    let signed = false, verified = null, signer = null
    try {
      const sigs = msg.getSigningKeyIDs()
      if (sigs && sigs.length) {
        signed = true
        signer = (sigs[0].toHex && sigs[0].toHex()) || null
      }
      const pub = await privateKey.getPublicKey()
      const v = await msg.verify({ publicKeys: [pub] })
      if (v.length) verified = v.every(s => s.verified)
    } catch {}
    return { encrypted: true, decrypted: true, text, html, attachments, signed, verified, signer }
  } catch (err) {
    return { encrypted: true, decrypted: false, armored, error: err.message }
  }
}

import { apiFetch, MailAPI } from '../api'
import { getState, updateMessage } from '../store'

/** The PGP state of one account (its own private key; the keyring is shared). */
export interface PgpStatus {
  account?: string | null
  hasPrivateKey: boolean
  hasPublicKey: boolean
  hasPassphrase: boolean
  unlocked: boolean
  fingerprint?: string | null
  userIds?: { name: string, email: string }[]
}

/** A key in the shared keyring (public keys of other people). */
export interface PgpPublicKey { fingerprint: string, userIds: { name: string, email: string }[], canEncrypt: boolean }

export interface PgpSendOptions { sign: boolean, encrypt: boolean }

const API_BASE = import.meta.env.VITE_API_URL || ''

/** Headers that point a PGP call at `account` (else the active account). */
function forAccount(account?: string | null): Record<string, string> {
  return account ? { 'x-account': account } : {}
}

export async function pgpStatus(account?: string | null): Promise<PgpStatus> {
  const r = await apiFetch(`${API_BASE}/api/pgp/status`, { headers: forAccount(account) })
  if (!r.ok) throw new Error(`PGP status failed (${r.status})`)
  return r.json()
}

/** Unlock the stored private key (of `account`) in the server's memory.
 * Throws a message the user can act on ("Wrong passphrase" etc.). */
export async function pgpUnlock(passphrase: string, account?: string | null): Promise<void> {
  if (!passphrase) throw new Error('Enter the passphrase of your private key')
  const r = await apiFetch(`${API_BASE}/api/pgp/unlock`, { method: 'POST', headers: forAccount(account), body: JSON.stringify({ passphrase }) })
  if (r.ok) return
  const body = await r.json().catch(() => ({} as { error?: string }))
  if (r.status === 401) throw new Error('Wrong passphrase. The key stays locked.')
  if (r.status === 429) throw new Error('Too many wrong passphrases. Wait a minute and try again.')
  if (r.status === 404) throw new Error('No private key is stored for this account. Add it in Settings → PGP.')
  throw new Error(body.error || `Unlock failed (${r.status})`)
}

/** Forget the unlocked key on the server and every decrypted body on screen. */
export async function pgpLock(account?: string | null): Promise<void> {
  const r = await apiFetch(`${API_BASE}/api/pgp/lock`, { method: 'POST', headers: forAccount(account) })
  if (!r.ok) throw new Error(`Lock failed (${r.status})`)
  for (const m of getState().messages) {
    if (m.pgp?.decrypted) {
      updateMessage(m.id, { body: '', bodyHtml: '', attachments: [], pgp: { encrypted: true, decrypted: false, error: 'pgp_locked' } })
    }
  }
}

export async function pgpPublicKeys(): Promise<PgpPublicKey[]> {
  const r = await apiFetch(`${API_BASE}/api/pgp/publics`)
  if (!r.ok) throw new Error(`Listing public keys failed (${r.status})`)
  return (await r.json()).keys || []
}

export async function pgpRemovePublicKey(fingerprint: string): Promise<void> {
  const r = await apiFetch(`${API_BASE}/api/pgp/publics/${encodeURIComponent(fingerprint)}`, { method: 'DELETE' })
  if (!r.ok && r.status !== 404) throw new Error(`Removing the key failed (${r.status})`)
}

/** Which recipients have a usable public key (keyring or one of the accounts). */
export async function pgpLookup(recipients: string[]): Promise<{ found: string[], missing: string[] }> {
  const r = await apiFetch(`${API_BASE}/api/pgp/lookup`, { method: 'POST', body: JSON.stringify({ recipients }) })
  if (!r.ok) throw new Error(`Looking up PGP keys failed (${r.status})`)
  return r.json()
}

/**
 * What stops a signed/encrypted send before it is tried, as a message for
 * the compose window; 'locked' when only the passphrase is missing (Compose
 * then asks for it); null when the send can go ahead.
 */
export function pgpSendProblem(
  opts: PgpSendOptions,
  status: PgpStatus | null,
  missing: string[],
  { scheduled = false, accountEmail = '' }: { scheduled?: boolean, accountEmail?: string } = {}
): string | 'locked' | null {
  if (!opts.sign && !opts.encrypt) return null
  if (scheduled) return 'Signed or encrypted mail cannot be scheduled yet. Send it now, or turn off Sign/Encrypt.'
  if (!status?.hasPrivateKey) {
    return `No PGP key is set up for ${accountEmail || 'this account'}. Add it in Settings → PGP${opts.encrypt && !opts.sign ? ' (mail is also encrypted to your own key so the copy in Sent stays readable)' : ''}.`
  }
  if (opts.encrypt && missing.length) {
    return `No PGP public key for ${missing.join(', ')}. Import their key in Settings → PGP, or turn off Encrypt.`
  }
  if (opts.sign && status.hasPassphrase && !status.unlocked) return 'locked'
  return null
}

/** Fetch a message again (after unlocking) and put the result in the store. */
export async function reloadMessage(id: string, folder: string): Promise<void> {
  const data = await MailAPI.message(id, folder)
  if (data) updateMessage(id, { body: data.body, bodyHtml: data.bodyHtml, pgp: data.pgp, attachments: data.attachments, cc: data.cc, bcc: data.bcc })
}

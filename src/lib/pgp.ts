import { apiFetch, MailAPI } from '../api'
import { getState, updateMessage } from '../store'

export interface PgpStatus { hasPrivateKey: boolean; hasPublicKey: boolean; hasPassphrase: boolean; unlocked: boolean }

const API_BASE = import.meta.env.VITE_API_URL || ''

export async function pgpStatus(): Promise<PgpStatus> {
  const r = await apiFetch(`${API_BASE}/api/pgp/status`)
  if (!r.ok) throw new Error(`PGP status failed (${r.status})`)
  return r.json()
}

/** Unlock the stored private key in the server's memory. Throws a message
 * the user can act on ("Wrong passphrase" etc.). */
export async function pgpUnlock(passphrase: string): Promise<void> {
  if (!passphrase) throw new Error('Enter the passphrase of your private key')
  const r = await apiFetch(`${API_BASE}/api/pgp/unlock`, { method: 'POST', body: JSON.stringify({ passphrase }) })
  if (r.ok) return
  const body = await r.json().catch(() => ({} as { error?: string }))
  if (r.status === 401) throw new Error('Wrong passphrase. The key stays locked.')
  if (r.status === 429) throw new Error('Too many wrong passphrases. Wait a minute and try again.')
  if (r.status === 404) throw new Error('No private key is stored. Add it in Settings → PGP.')
  throw new Error(body.error || `Unlock failed (${r.status})`)
}

/** Forget the unlocked key on the server and every decrypted body on screen. */
export async function pgpLock(): Promise<void> {
  const r = await apiFetch(`${API_BASE}/api/pgp/lock`, { method: 'POST' })
  if (!r.ok) throw new Error(`Lock failed (${r.status})`)
  for (const m of getState().messages) {
    if (m.pgp?.decrypted) {
      updateMessage(m.id, { body: '', bodyHtml: '', attachments: [], pgp: { encrypted: true, decrypted: false, error: 'pgp_locked' } })
    }
  }
}

/** Fetch a message again (after unlocking) and put the result in the store. */
export async function reloadMessage(id: string, folder: string): Promise<void> {
  const data = await MailAPI.message(id, folder)
  if (data) updateMessage(id, { body: data.body, bodyHtml: data.bodyHtml, pgp: data.pgp, attachments: data.attachments, cc: data.cc, bcc: data.bcc })
}

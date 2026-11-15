/**
 * Remembers which account the user chose, so a reload opens it again
 * instead of the first one.
 *
 * Two places: localStorage (per browser, the PWA) and the server
 * (GET/PUT /api/active-account). The server copy is what the desktop app
 * uses: the Tauri shell serves the app on a new random port per launch, so
 * every launch is a new origin with an empty localStorage.
 *
 * Kept by id and email: the id is what the store uses, the email is what the
 * server knows and survives an account being removed and added again.
 */
import type { MailAccount } from '../store'

export const ACTIVE_ACCOUNT_KEY = 'leoposta:activeAccount'

export interface RememberedAccount { id?: string; email?: string }

export interface AccountMemoryServer {
  get: () => Promise<{ email: string | null }>
  put: (email: string) => Promise<unknown>
}

function defaultStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

export function readLocal(storage: Storage | null = defaultStorage()): RememberedAccount | null {
  try {
    const raw = storage?.getItem(ACTIVE_ACCOUNT_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const out: RememberedAccount = {}
    if (typeof v.id === 'string' && v.id) out.id = v.id
    if (typeof v.email === 'string' && v.email) out.email = v.email
    return out.id || out.email ? out : null
  } catch { return null }
}

/** The id of the remembered account in `accounts`, or null when it no longer exists. */
export function pickRemembered(accounts: Pick<MailAccount, 'id' | 'email'>[], r: RememberedAccount | null): string | null {
  if (!r) return null
  if (r.id) {
    const byId = accounts.find((a) => a.id === r.id)
    if (byId) return byId.id
  }
  if (r.email) {
    const e = r.email.toLowerCase()
    const byEmail = accounts.find((a) => (a.email || '').toLowerCase() === e)
    if (byEmail) return byEmail.id
  }
  return null
}

/** Which account to open on start: the browser's choice, else the server's,
 * else null (the caller falls back to the first account). */
export async function rememberedAccountId(
  accounts: Pick<MailAccount, 'id' | 'email'>[],
  server: AccountMemoryServer | null,
  storage: Storage | null = defaultStorage()
): Promise<string | null> {
  const local = pickRemembered(accounts, readLocal(storage))
  if (local) return local
  if (!server || accounts.length < 2) return null
  try {
    const { email } = await server.get()
    return email ? pickRemembered(accounts, { email }) : null
  } catch { return null }
}

/** Store the user's choice in both places (the server write is best effort). */
export function rememberAccount(
  account: Pick<MailAccount, 'id' | 'email'>,
  server: AccountMemoryServer | null,
  storage: Storage | null = defaultStorage()
): void {
  const prev = readLocal(storage)
  if (prev?.id === account.id && prev?.email === account.email) return
  try { storage?.setItem(ACTIVE_ACCOUNT_KEY, JSON.stringify({ id: account.id, email: account.email })) } catch { /* private mode, quota */ }
  server?.put(account.email).catch(() => {})
}

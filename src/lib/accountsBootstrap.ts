import { AccountAPI } from '../api'
import { setAccounts, store, type MailAccount } from '../store'
import { rememberAccount, rememberedAccountId, type AccountMemoryServer } from './activeAccountMemory'

type AccountsApi = Pick<typeof AccountAPI, 'list'> & Partial<Pick<typeof AccountAPI, 'getActive' | 'setActive'>>

function memoryServer(api: AccountsApi): AccountMemoryServer | null {
  return api.getActive && api.setActive ? { get: api.getActive, put: api.setActive } : null
}

/**
 * Load the configured accounts into the store before anything account-scoped
 * runs, so every API call carries the active account (x-account) and the
 * refresh controller starts. The account the user chose last time is active
 * again (falls back to the first one when it no longer exists).
 * `reachable: false` when the backend could not be asked (offline PWA,
 * server down): that is not "no account", so the app keeps serving its
 * offline cache instead of the first-run screen.
 */
export async function loadAccounts(api: AccountsApi = AccountAPI, storage?: Storage | null): Promise<{ accounts: MailAccount[], reachable: boolean }> {
  try {
    const list = await api.list()
    const accounts: MailAccount[] = Array.isArray(list) ? list : []
    setAccounts(accounts, await rememberedAccountId(accounts, memoryServer(api), storage))
    return { accounts, reachable: true }
  } catch {
    return { accounts: [], reachable: false }
  }
}

/** The account list ([] when none, or when the backend cannot be reached). */
export async function loadAccountsIntoStore(api: AccountsApi = AccountAPI): Promise<MailAccount[]> {
  return (await loadAccounts(api)).accounts
}

/** From now on, remember every change of the active account (switcher,
 * a newly added account, the fallback after a removal). Returns the unsubscribe. */
export function rememberActiveAccount(api: AccountsApi = AccountAPI, storage?: Storage | null): () => void {
  const server = memoryServer(api)
  let last = ''
  // The store changes all the time (messages, flags): act on account changes only.
  return store.subscribe((s) => {
    const active = s.accounts.find((a) => a.id === s.activeAccountId)
    if (!active || `${active.id}\u0000${active.email}` === last) return
    last = `${active.id}\u0000${active.email}`
    rememberAccount(active, server, storage)
  })
}

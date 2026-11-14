import { AccountAPI } from '../api'
import { setAccounts, type MailAccount } from '../store'

/**
 * Load the configured accounts into the store before anything account-scoped
 * runs, so every API call carries the active account (x-account) and the
 * refresh controller starts. `reachable: false` when the backend could not be
 * asked (offline PWA, server down): that is not "no account", so the app
 * keeps serving its offline cache instead of the first-run screen.
 */
export async function loadAccounts(api: Pick<typeof AccountAPI, 'list'> = AccountAPI): Promise<{ accounts: MailAccount[], reachable: boolean }> {
  try {
    const list = await api.list()
    const accounts: MailAccount[] = Array.isArray(list) ? list : []
    setAccounts(accounts)
    return { accounts, reachable: true }
  } catch {
    return { accounts: [], reachable: false }
  }
}

/** The account list ([] when none, or when the backend cannot be reached). */
export async function loadAccountsIntoStore(api: Pick<typeof AccountAPI, 'list'> = AccountAPI): Promise<MailAccount[]> {
  return (await loadAccounts(api)).accounts
}

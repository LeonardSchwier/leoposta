import { AccountAPI } from '../api'
import { setAccounts, type MailAccount } from '../store'

/**
 * Load the configured accounts into the store before anything account-scoped
 * runs, so every API call carries the active account (x-account) and the
 * refresh controller starts. Resolves to the list ([] when none, or when the
 * backend cannot be reached — the app then shows its first-run state).
 */
export async function loadAccountsIntoStore(api: Pick<typeof AccountAPI, 'list'> = AccountAPI): Promise<MailAccount[]> {
  try {
    const list = await api.list()
    const accounts: MailAccount[] = Array.isArray(list) ? list : []
    setAccounts(accounts)
    return accounts
  } catch {
    return []
  }
}

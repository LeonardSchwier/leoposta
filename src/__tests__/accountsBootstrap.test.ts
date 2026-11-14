import { describe, it, expect } from 'vitest'
import { loadAccounts, loadAccountsIntoStore } from '../lib/accountsBootstrap'
import { getState, setAccounts, type MailAccount } from '../store'

describe('loadAccountsIntoStore', () => {
  it('puts the accounts into the store and makes one active (API calls then carry x-account)', async () => {
    setAccounts([])
    const list = [{ id: 'a1', email: 'a@x.test', name: 'A' }] as MailAccount[]
    expect(await loadAccountsIntoStore({ list: async () => list })).toEqual(list)
    expect(getState().accounts).toEqual(list)
    expect(getState().activeAccountId).toBe('a1')
  })
  it('resolves to [] (first-run screen) when there are none or the backend is down', async () => {
    expect(await loadAccountsIntoStore({ list: async () => [] })).toEqual([])
    expect(await loadAccountsIntoStore({ list: async () => { throw new Error('offline') } })).toEqual([])
  })
  it('tells "no account" (reachable) from "backend unreachable" (offline: keep the offline cache, no first-run screen)', async () => {
    expect(await loadAccounts({ list: async () => [] })).toEqual({ accounts: [], reachable: true })
    expect(await loadAccounts({ list: async () => { throw new TypeError('Failed to fetch') } })).toEqual({ accounts: [], reachable: false })
  })
})

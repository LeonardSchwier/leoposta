import { describe, it, expect } from 'vitest'
import { loadAccountsIntoStore } from '../lib/accountsBootstrap'
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
})

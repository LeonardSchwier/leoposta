import { describe, it, expect, vi } from 'vitest'
import { loadAccounts, rememberActiveAccount } from '../lib/accountsBootstrap'
import { ACTIVE_ACCOUNT_KEY, pickRemembered, readLocal } from '../lib/activeAccountMemory'
import { getState, setAccounts, setActiveAccount, type MailAccount } from '../store'

function memStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init))
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k) },
    setItem: (k, v) => { m.set(k, String(v)) }
  }
}
const accts = [{ id: 'a1', email: 'a@x.test', name: 'A' }, { id: 'a2', email: 'b@x.test', name: 'B' }, { id: 'a3', email: 'c@x.test', name: 'C' }] as MailAccount[]

describe('the active account survives a reload', () => {
  it('a reload opens the account chosen last time (localStorage)', async () => {
    const storage = memStorage()
    setAccounts([]); setActiveAccount(null)
    await loadAccounts({ list: async () => accts }, storage)
    const stop = rememberActiveAccount({ list: async () => accts }, storage)
    setActiveAccount('a2')
    stop()
    expect(JSON.parse(storage.getItem(ACTIVE_ACCOUNT_KEY)!)).toEqual({ id: 'a2', email: 'b@x.test' })

    // "Reload": a fresh store, same storage.
    setAccounts([]); setActiveAccount(null)
    await loadAccounts({ list: async () => accts }, storage)
    expect(getState().activeAccountId).toBe('a2')
  })

  it('falls back to the first account when the remembered one no longer exists', async () => {
    const storage = memStorage({ [ACTIVE_ACCOUNT_KEY]: JSON.stringify({ id: 'gone', email: 'gone@x.test' }) })
    setAccounts([]); setActiveAccount(null)
    await loadAccounts({ list: async () => accts }, storage)
    expect(getState().activeAccountId).toBe('a1')
  })

  it('the desktop app (new origin per launch, empty localStorage) gets the choice back from the server', async () => {
    const put = vi.fn(async () => ({}))
    const api = { list: async () => accts, getActive: async () => ({ email: 'C@x.test' }), setActive: put }
    setAccounts([]); setActiveAccount(null)
    await loadAccounts(api, memStorage())
    expect(getState().activeAccountId).toBe('a3')

    const storage = memStorage()
    const stop = rememberActiveAccount(api, storage)
    setActiveAccount('a1')
    stop()
    expect(put).toHaveBeenLastCalledWith('a@x.test')
  })

  it('a server that does not know the account (removed) or is unreachable falls back to the first', async () => {
    for (const getActive of [async () => ({ email: null }), async () => ({ email: 'gone@x.test' }), async () => { throw new Error('down') }]) {
      setAccounts([]); setActiveAccount(null)
      await loadAccounts({ list: async () => accts, getActive, setActive: async () => ({}) }, memStorage())
      expect(getState().activeAccountId).toBe('a1')
    }
  })

  it('the restore does not override the account already on screen (a later reload of the list)', async () => {
    setAccounts(accts); setActiveAccount('a3')
    await loadAccounts({ list: async () => accts }, memStorage({ [ACTIVE_ACCOUNT_KEY]: JSON.stringify({ id: 'a2' }) }))
    expect(getState().activeAccountId).toBe('a3')
  })

  it('matches by email when the id changed (account removed and added again); ignores junk', () => {
    expect(pickRemembered(accts, { id: 'old', email: 'B@X.test' })).toBe('a2')
    expect(readLocal(memStorage({ [ACTIVE_ACCOUNT_KEY]: '{not json' }))).toBeNull()
    expect(readLocal(memStorage({ [ACTIVE_ACCOUNT_KEY]: '42' }))).toBeNull()
    expect(readLocal(null)).toBeNull()
  })
})

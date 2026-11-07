import { describe, it, expect, beforeEach, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  store,
  setAccounts,
  setActiveAccount,
  getActiveAccount,
} from '../store'
import type { MailAccount } from '../store'
import { setActiveAccountEmail } from '../api'

function account(id: string, email: string): MailAccount {
  return {
    id,
    name: id,
    email,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapTls: true,
    imapUser: email,
    imapPass: 'secret',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpTls: true,
    smtpUser: email,
    smtpPass: 'secret',
    signature: { enabled: false, text: '', position: 'standard' }
  }
}

describe('Account switching (store-level)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('setAccounts with a fresh list picks the first account as active', () => {
    setAccounts([account('a1', 'a1@example.com'), account('a2', 'a2@example.com')])
    const s = get(store)
    expect(s.activeAccountId).toBe('a1')
    expect(getActiveAccount()?.id).toBe('a1')
  })

  it('setActiveAccount updates state and resolves getActiveAccount', () => {
    setAccounts([account('a1', 'a1@example.com'), account('a2', 'a2@example.com')])
    setActiveAccount('a2')
    expect(get(store).activeAccountId).toBe('a2')
    expect(getActiveAccount()?.email).toBe('a2@example.com')
  })

  it('setActiveAccount(null) clears active account', () => {
    setAccounts([account('a1', 'a1@example.com')])
    setActiveAccount(null)
    expect(get(store).activeAccountId).toBeNull()
    expect(getActiveAccount()).toBeNull()
  })

  it('setActiveAccount emits a store update subscribers can observe (for the App.svelte switch effect)', () => {
    setAccounts([account('a1', 'a1@example.com'), account('a2', 'a2@example.com')])
    const emissions: (string | null)[] = []
    const unsub = store.subscribe(s => { emissions.push(s.activeAccountId) })
    setActiveAccount('a2')
    setActiveAccount('a1')
    unsub()
    expect(emissions[emissions.length - 1]).toBe('a1')
    expect(emissions).toContain('a2')
  })

  it('setActiveAccount keeps the previous id if a new list still contains it', () => {
    setAccounts([account('a1', 'a1@example.com'), account('a2', 'a2@example.com')])
    setActiveAccount('a2')
    setAccounts([account('a2', 'a2@example.com'), account('a3', 'a3@example.com')])
    expect(get(store).activeAccountId).toBe('a2')
  })
})

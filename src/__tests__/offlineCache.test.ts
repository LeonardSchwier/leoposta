// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { setActiveAccountEmail } from '../api'
import {
  putMessageCache, getMessageCache, cacheFolderList, cachedMessagesForFolder, clearMessageCache, clearAccountCache, cacheKey
} from '../lib/offlineQueue'

const flush = () => new Promise(r => setTimeout(r, 0))

describe('offlineQueue message cache', () => {
  beforeEach(() => {
    const factory = new (fakeIndexedDB.constructor as any)()
    ;(globalThis as any).indexedDB = factory
    // The cache belongs to an account; these tests are about one account at a time.
    setActiveAccountEmail('erika@example.test')
  })

  it('cacheKey composes account, folder and id', () => {
    expect(cacheKey('INBOX', '42', 'erika@example.test')).toBe('erika@example.test\u0000INBOX:42')
  })

  it('putMessageCache then getMessageCache round-trips a full message', async () => {
    const msg = { id: '7', subject: 'Hi', body: 'hello', folder: 'INBOX' }
    await putMessageCache({ folder: 'INBOX', id: '7', message: msg, full: true })
    const hit = await getMessageCache('INBOX', '7')
    expect(hit).toBeDefined()
    expect(hit?.full).toBe(true)
    expect(hit?.message.body).toBe('hello')
  })

  it('getMessageCache returns undefined for missing entries', async () => {
    expect(await getMessageCache('INBOX', 'nope')).toBeUndefined()
  })

  it('cacheFolderList stores list rows and returns them', async () => {
    const msgs = [
      { id: 'a', subject: 'one', flags: [] },
      { id: 'b', subject: 'two', flags: [] }
    ]
    await cacheFolderList('Sent', msgs)
    const out = await cachedMessagesForFolder('Sent')
    expect(out.map((m: any) => m.id).sort()).toEqual(['a', 'b'])
  })

  it('cacheFolderList prunes stale rows for the folder', async () => {
    await cacheFolderList('INBOX', [{ id: 'old', subject: 'x' }])
    await cacheFolderList('INBOX', [{ id: 'new', subject: 'y' }])
    await flush()
    const out = await cachedMessagesForFolder('INBOX')
    expect(out.map((m: any) => m.id)).toEqual(['new'])
  })

  it('cachedMessagesForFolder is scoped per folder', async () => {
    await cacheFolderList('INBOX', [{ id: 'i1' }])
    await cacheFolderList('Sent', [{ id: 's1' }])
    const inbox = await cachedMessagesForFolder('INBOX')
    expect(inbox.map((m: any) => m.id)).toEqual(['i1'])
    const sent = await cachedMessagesForFolder('Sent')
    expect(sent.map((m: any) => m.id)).toEqual(['s1'])
  })

  it('clearMessageCache(folder) removes only that folder', async () => {
    await cacheFolderList('INBOX', [{ id: 'i1' }])
    await cacheFolderList('Sent', [{ id: 's1' }])
    await clearMessageCache('INBOX')
    await flush()
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    expect((await cachedMessagesForFolder('Sent')).map((m: any) => m.id)).toEqual(['s1'])
  })

  it('clearMessageCache() wipes everything', async () => {
    await cacheFolderList('INBOX', [{ id: 'i1' }])
    await cacheFolderList('Sent', [{ id: 's1' }])
    await clearMessageCache()
    await flush()
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    expect(await cachedMessagesForFolder('Sent')).toEqual([])
  })
})

const ERIKA = 'erika@example.test'
const MAX = 'max@example.test'

/** Write an entry the way the cache did before it knew about accounts. */
async function putLegacyEntry(folder: string, id: string, message: unknown) {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open('leoposta-queue', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true })
      req.result.createObjectStore('messages', { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite')
    tx.objectStore('messages').put({ key: `${folder}:${id}`, folder, id, message, full: true, fetchedAt: 1 })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

describe('offline message cache is scoped by account', () => {
  beforeEach(() => {
    ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
    setActiveAccountEmail(ERIKA)
    vi.unstubAllGlobals()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the same folder and uid of two accounts apart', async () => {
    await putMessageCache({ folder: 'INBOX', id: '5', message: { body: 'for Erika' }, full: true })
    setActiveAccountEmail(MAX)
    await putMessageCache({ folder: 'INBOX', id: '5', message: { body: 'for Max' }, full: true })
    expect((await getMessageCache('INBOX', '5'))?.message.body).toBe('for Max')
    setActiveAccountEmail(ERIKA)
    expect((await getMessageCache('INBOX', '5'))?.message.body).toBe('for Erika')
  })

  it('does not serve another account\'s message that has the same uid', async () => {
    setActiveAccountEmail(MAX)
    await putMessageCache({ folder: 'INBOX', id: '5', message: { body: 'for Max' }, full: true })
    setActiveAccountEmail(ERIKA)
    expect(await getMessageCache('INBOX', '5')).toBeUndefined()
  })

  it('listing a folder for one account does not prune the other account\'s rows', async () => {
    await cacheFolderList('Sent', [{ id: 'e1' }, { id: 'e2' }])
    setActiveAccountEmail(MAX)
    await cacheFolderList('Sent', [{ id: 'm1' }])
    expect((await cachedMessagesForFolder('Sent')).map((m: any) => m.id)).toEqual(['m1'])
    setActiveAccountEmail(ERIKA)
    expect((await cachedMessagesForFolder('Sent')).map((m: any) => m.id).sort()).toEqual(['e1', 'e2'])
  })

  it('the offline list shows only the account that is active', async () => {
    await cacheFolderList('Archive', [{ id: 'e1' }])
    setActiveAccountEmail(MAX)
    expect(await cachedMessagesForFolder('Archive')).toEqual([])
  })

  it('an account name matches without regard to case', async () => {
    await cacheFolderList('INBOX', [{ id: 'e1' }])
    setActiveAccountEmail('Erika@Example.Test')
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['e1'])
  })

  it('clearMessageCache(folder) clears that folder of the active account only', async () => {
    await cacheFolderList('INBOX', [{ id: 'e1' }])
    setActiveAccountEmail(MAX)
    await cacheFolderList('INBOX', [{ id: 'm1' }])
    await clearMessageCache('INBOX')
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    setActiveAccountEmail(ERIKA)
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['e1'])
  })

  it('clearAccountCache removes one account\'s entries, full messages included', async () => {
    await cacheFolderList('INBOX', [{ id: 'e1' }])
    await putMessageCache({ folder: 'INBOX', id: 'e1', message: { body: 'x' }, full: true })
    setActiveAccountEmail(MAX)
    await cacheFolderList('INBOX', [{ id: 'm1' }])
    await clearAccountCache('ERIKA@example.test')
    expect(await getMessageCache('INBOX', 'e1')).toBeUndefined()
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['m1'])
    setActiveAccountEmail(ERIKA)
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    expect(await getMessageCache('INBOX', 'e1')).toBeUndefined()
  })

  it('never serves an entry written before the cache knew accounts', async () => {
    await putLegacyEntry('INBOX', 'old', { id: 'old', body: 'unknown owner' })
    expect(await getMessageCache('INBOX', 'old')).toBeUndefined()
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    await cacheFolderList('INBOX', [{ id: 'new' }])
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['new'])
  })

  it('purges an entry written before the cache knew accounts when the list is cached', async () => {
    await putLegacyEntry('Sent', 'old', { id: 'old' })
    await cacheFolderList('INBOX', [{ id: 'e1' }])
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('leoposta-queue', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const keys: string[] = await new Promise((resolve) => {
      const r = db.transaction('messages', 'readonly').objectStore('messages').getAllKeys()
      r.onsuccess = () => resolve(r.result as string[])
    })
    expect(keys).toEqual([cacheKey('INBOX', 'e1', ERIKA)])
    db.close()
  })

  it('reads and writes nothing while no account is known', async () => {
    setActiveAccountEmail(null)
    await cacheFolderList('INBOX', [{ id: 'x' }])
    await putMessageCache({ folder: 'INBOX', id: 'x', message: { body: 'x' }, full: true })
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    expect(await getMessageCache('INBOX', 'x')).toBeUndefined()
    setActiveAccountEmail(ERIKA)
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    expect(await getMessageCache('INBOX', 'x')).toBeUndefined()
  })

  it('an app that starts offline, before the account list loads, uses the remembered account', async () => {
    await cacheFolderList('INBOX', [{ id: 'e1' }])
    setActiveAccountEmail(null) // the account list could not be fetched
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'leoposta:activeAccount' ? JSON.stringify({ id: 'a1', email: ERIKA }) : null)
    })
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['e1'])
  })

  it('writes nothing for the remembered account while no account is active', async () => {
    // No active account means a request carries no account header and the server
    // answers for its first account, which need not be the remembered one.
    setActiveAccountEmail(null)
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'leoposta:activeAccount' ? JSON.stringify({ id: 'a1', email: ERIKA }) : null)
    })
    await cacheFolderList('INBOX', [{ id: 'y1' }])
    await putMessageCache({ folder: 'INBOX', id: 'y1', message: { body: 'x' }, full: true })
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    expect(await getMessageCache('INBOX', 'y1')).toBeUndefined()
  })

  it('an explicit account pins the scope, whatever account is active by the time the answer arrives', async () => {
    await cacheFolderList('INBOX', [{ id: 'e1' }], ERIKA)
    await putMessageCache({ folder: 'INBOX', id: 'e1', message: { body: 'late answer' }, full: true }, ERIKA)
    setActiveAccountEmail(MAX) // the user switched while the request was in flight
    await cacheFolderList('INBOX', [{ id: 'e2' }], ERIKA)
    expect(await cachedMessagesForFolder('INBOX')).toEqual([])
    expect((await cachedMessagesForFolder('INBOX', ERIKA)).map((m: any) => m.id)).toEqual(['e2'])
    expect(await getMessageCache('INBOX', 'e1')).toBeUndefined()
  })

  it('overlapping list writes for different folders both persist', async () => {
    await Promise.all([
      cacheFolderList('INBOX', [{ id: 'i1' }, { id: 'i2' }]),
      cacheFolderList('Sent', [{ id: 's1' }]),
      cacheFolderList('Drafts', [{ id: 'd1' }])
    ])
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id).sort()).toEqual(['i1', 'i2'])
    expect((await cachedMessagesForFolder('Sent')).map((m: any) => m.id)).toEqual(['s1'])
    expect((await cachedMessagesForFolder('Drafts')).map((m: any) => m.id)).toEqual(['d1'])
  })
})

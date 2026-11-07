// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import {
  putMessageCache, getMessageCache, cacheFolderList, cachedMessagesForFolder, clearMessageCache, cacheKey
} from '../lib/offlineQueue'

const flush = () => new Promise(r => setTimeout(r, 0))

describe('offlineQueue message cache', () => {
  beforeEach(() => {
    const factory = new (fakeIndexedDB.constructor as any)()
    ;(globalThis as any).indexedDB = factory
  })

  it('cacheKey composes folder and id', () => {
    expect(cacheKey('INBOX', '42')).toBe('INBOX:42')
  })

  it('putMessageCache then getMessageCache round-trips a full message', async () => {
    const msg = { id: '7', subject: 'Hi', body: 'hello', folder: 'INBOX' }
    await putMessageCache({ key: cacheKey('INBOX', '7'), folder: 'INBOX', id: '7', message: msg, full: true })
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

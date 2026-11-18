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

// An opened message is cached in full (body included) so it can be read offline. The
// folder list that is cached after every refresh has no bodies; it must not replace it.
describe('an opened message keeps its offline body across a list refresh', () => {
  beforeEach(() => {
    const factory = new (fakeIndexedDB.constructor as any)()
    ;(globalThis as any).indexedDB = factory
    setActiveAccountEmail('erika@example.test')
  })

  const full = (id: string, extra: Record<string, unknown> = {}) => ({
    id, folder: 'INBOX', from: 'Max Muster', fromAddress: 'max@example.test', to: ['erika@example.test'],
    cc: ['team@example.test'], bcc: ['hidden@example.test'], subject: 'Plans', date: '2026-11-10T10:00:00.000Z', flags: ['\\Seen'],
    body: 'See you at noon.', bodyHtml: '<p>See you at noon.</p>',
    // What GET /api/messages/:id answers: parsed attachments, each with the id to download it by.
    attachments: [{ id: '0', filename: 'map.pdf', contentType: 'application/pdf', size: 1180 }],
    messageId: '<m1@example.test>', references: '<m0@example.test>', replyTo: 'max@example.test',
    headers: { 'x-spam': 'no' }, ...extra
  })
  // What GET /api/messages answers for the same message: no body, list-only fields.
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id, threadId: '<m0@example.test>', folder: 'INBOX', from: 'Max Muster', fromAddress: 'max@example.test',
    to: ['erika@example.test'], cc: ['team@example.test'], bcc: [], subject: 'Plans', body: '', bodyHtml: '', snippet: 'See you',
    date: '2026-11-10T10:00:00.000Z', flags: ['\\Seen'], hasAttachment: true, attachmentCount: 1,
    attachments: [{ filename: 'map.pdf', size: 1200, part: '2' }], headers: {}, ...extra
  })

  it('keeps the body, html, attachments and headers of an opened message', async () => {
    await putMessageCache({ folder: 'INBOX', id: '7', message: full('7'), full: true })
    await cacheFolderList('INBOX', [row('7')])
    const hit = await getMessageCache('INBOX', '7')
    expect(hit?.full).toBe(true)
    expect(hit?.message.body).toBe('See you at noon.')
    expect(hit?.message.bodyHtml).toBe('<p>See you at noon.</p>')
    expect(hit?.message.attachments).toEqual([{ id: '0', filename: 'map.pdf', contentType: 'application/pdf', size: 1180 }])
    expect(hit?.message.bcc).toEqual(['hidden@example.test'])
    expect(hit?.message.cc).toEqual(['team@example.test'])
    expect(hit?.message.headers).toEqual({ 'x-spam': 'no' })
    expect(hit?.message.messageId).toBe('<m1@example.test>')
    expect(hit?.message.references).toBe('<m0@example.test>')
    expect(hit?.message.replyTo).toBe('max@example.test')
  })

  it('takes the fresh flags and list fields from the row', async () => {
    await putMessageCache({ folder: 'INBOX', id: '7', message: full('7'), full: true })
    await cacheFolderList('INBOX', [row('7', { flags: ['\\Flagged'], snippet: 'Newer snippet', subject: 'Plans (moved)' })])
    const hit = await getMessageCache('INBOX', '7')
    expect(hit?.message.flags).toEqual(['\\Flagged'])
    expect(hit?.message.snippet).toBe('Newer snippet')
    expect(hit?.message.subject).toBe('Plans (moved)')
    expect(hit?.message.threadId).toBe('<m0@example.test>')
    expect(hit?.message.hasAttachment).toBe(true)
  })

  it('a flag removed on the server is removed in the cache, not restored from the old entry', async () => {
    await putMessageCache({ folder: 'INBOX', id: '7', message: full('7', { flags: ['\\Seen', '\\Flagged'] }), full: true })
    await cacheFolderList('INBOX', [row('7', { flags: [] })])
    expect((await getMessageCache('INBOX', '7'))?.message.flags).toEqual([])
  })

  it('the offline list still shows the opened message, with its fresh flags', async () => {
    await putMessageCache({ folder: 'INBOX', id: '7', message: full('7'), full: true })
    await cacheFolderList('INBOX', [row('7', { flags: [] })])
    const list = await cachedMessagesForFolder('INBOX')
    expect(list.map((m: any) => m.id)).toEqual(['7'])
    expect(list[0].flags).toEqual([])
    expect(list[0].snippet).toBe('See you')
  })

  it('still prunes an opened message that is no longer in the list', async () => {
    await putMessageCache({ folder: 'INBOX', id: '7', message: full('7'), full: true })
    await cacheFolderList('INBOX', [row('8')])
    expect(await getMessageCache('INBOX', '7')).toBeUndefined()
  })

  it('leaves the opened messages of another folder and of another account alone', async () => {
    await putMessageCache({ folder: 'Sent', id: '7', message: full('7', { folder: 'Sent' }), full: true })
    await putMessageCache({ folder: 'INBOX', id: '7', message: full('7', { body: 'Other account' }), full: true }, 'max@example.test')
    await cacheFolderList('INBOX', [row('9')])
    expect((await getMessageCache('Sent', '7'))?.message.body).toBe('See you at noon.')
    expect((await getMessageCache('INBOX', '7', 'max@example.test'))?.message.body).toBe('Other account')
  })

  it('does not put a stored body under another message after the server renumbered the folder', async () => {
    await putMessageCache({ folder: 'INBOX', id: '7', message: full('7'), full: true })
    await cacheFolderList('INBOX', [row('7', { fromAddress: 'other@example.test', from: 'Other', subject: 'Invoice' })])
    const hit = await getMessageCache('INBOX', '7')
    expect(hit?.full).toBe(false)
    expect(hit?.message.body).toBe('')
    expect(hit?.message.subject).toBe('Invoice')
    await putMessageCache({ folder: 'INBOX', id: '8', message: full('8'), full: true })
    await cacheFolderList('INBOX', [row('8', { date: '2026-11-12T10:00:00.000Z' })])
    expect((await getMessageCache('INBOX', '8'))?.full).toBe(false)
  })

  it('a list row still replaces a list row (nothing is promoted to full)', async () => {
    await cacheFolderList('INBOX', [row('7', { snippet: 'old' })])
    await cacheFolderList('INBOX', [row('7', { snippet: 'new' })])
    const hit = await getMessageCache('INBOX', '7')
    expect(hit?.full).toBe(false)
    expect(hit?.message.snippet).toBe('new')
    expect(hit?.message.body).toBe('')
  })

  it('survives a refresh of the same list more than once', async () => {
    await putMessageCache({ folder: 'INBOX', id: '7', message: full('7'), full: true })
    await cacheFolderList('INBOX', [row('7')])
    await cacheFolderList('INBOX', [row('7', { flags: [] })])
    await cacheFolderList('INBOX', [row('7', { flags: ['\\Seen'] })])
    const hit = await getMessageCache('INBOX', '7')
    expect(hit?.full).toBe(true)
    expect(hit?.message.body).toBe('See you at noon.')
    expect(hit?.message.flags).toEqual(['\\Seen'])
  })

  it('a stored full entry without a usable message is replaced by the row instead of throwing', async () => {
    await putMessageCache({ folder: 'INBOX', id: '7', message: null as any, full: true })
    await cacheFolderList('INBOX', [row('7')])
    const hit = await getMessageCache('INBOX', '7')
    expect(hit?.full).toBe(false)
    expect(hit?.message.snippet).toBe('See you')
  })
})

// The server answers a folder newest first. Offline the list must come back in that order.
describe('the offline list is newest first, as the server answers', () => {
  beforeEach(() => {
    const factory = new (fakeIndexedDB.constructor as any)()
    ;(globalThis as any).indexedDB = factory
    setActiveAccountEmail('erika@example.test')
  })

  const at = (id: string, date: string | undefined, extra: Record<string, unknown> = {}) => ({ id, date, subject: `m${id}`, flags: [], ...extra })

  it('orders UIDs across a digit boundary by date, not as text', async () => {
    await cacheFolderList('INBOX', [
      at('102', '2026-11-05T10:00:00.000Z'), at('101', '2026-11-04T10:00:00.000Z'), at('100', '2026-11-03T10:00:00.000Z'),
      at('99', '2026-11-02T10:00:00.000Z'), at('98', '2026-11-01T10:00:00.000Z')
    ])
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['102', '101', '100', '99', '98'])
  })

  it('is not changed by opening a message later', async () => {
    await cacheFolderList('INBOX', [at('9', '2026-11-03T10:00:00.000Z'), at('8', '2026-11-02T10:00:00.000Z'), at('7', '2026-11-01T10:00:00.000Z')])
    await putMessageCache({ folder: 'INBOX', id: '7', message: at('7', '2026-11-01T10:00:00.000Z', { body: 'x' }), full: true })
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['9', '8', '7'])
  })

  it('orders messages with the same date by UID, higher first', async () => {
    const same = '2026-11-03T10:00:00.000Z'
    await cacheFolderList('INBOX', [at('9', same), at('10', same), at('2', same)])
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['10', '9', '2'])
  })

  it('puts a message with a missing or unparsable date last', async () => {
    await cacheFolderList('INBOX', [at('3', undefined), at('2', 'not a date'), at('1', '2026-11-01T10:00:00.000Z')])
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['1', '3', '2'])
  })

  it('does not throw for a cached message that is not an object', async () => {
    await cacheFolderList('INBOX', [at('1', '2026-11-01T10:00:00.000Z')])
    await putMessageCache({ folder: 'INBOX', id: '5', message: null as any, full: true })
    expect((await cachedMessagesForFolder('INBOX')).map((m: any) => m.id)).toEqual(['1'])
  })
})

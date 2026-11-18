import { apiFetch, getActiveAccountEmail } from '../api'
import { accountHeaders } from './accountHeader'
import { readLocal } from './activeAccountMemory'
const DB_NAME = 'leoposta-queue'
const OUTBOX = 'outbox'
const MSGS = 'messages'
const DB_VERSION = 1

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains(MSGS)) {
        db.createObjectStore(MSGS, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export interface QueuedMessage {
  id?: number
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  bodyHtml?: string
  scheduled?: string | null
  inReplyTo?: string
  references?: string
  attachments?: Array<{ filename: string; content: string; contentType: string }>
  /** Email of the account the message was written under. The outbox is flushed
   * later, possibly after the user switched accounts, and every request is
   * scoped to the active account, so the flush must send this one explicitly
   * (through lib/accountHeader.ts) or the mail leaves from the wrong address. Absent on messages
   * queued before this field existed: those go out under the active account. */
  account?: string
  createdAt: string
}

/** Fired on window whenever the outbox gains or loses messages. */
export const QUEUE_CHANGED = 'leoposta:queue-changed'
function notifyChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_CHANGED))
}

export async function addQueuedMessage(msg: Omit<QueuedMessage, 'id'>): Promise<void> {
  // Pin the account now: it is the one the user was sending from.
  const account = msg.account ?? getActiveAccountEmail() ?? undefined
  if (account) msg = { ...msg, account }
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OUTBOX, 'readwrite')
    tx.objectStore(OUTBOX).add(msg)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  notifyChanged()
}

export async function getQueuedMessages(): Promise<QueuedMessage[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX, 'readonly')
    const req = tx.objectStore(OUTBOX).getAll()
    req.onsuccess = () => resolve(req.result as QueuedMessage[])
    req.onerror = () => reject(req.error)
  })
}

export async function removeQueuedMessage(id: number): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX, 'readwrite')
    tx.objectStore(OUTBOX).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearQueue(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX, 'readwrite')
    tx.objectStore(OUTBOX).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// One flush at a time: two overlapping flushes (an "online" event while one
// runs) would both read the same outbox and send every message twice.
let flushing: Promise<{ sent: number; failed: number }> | null = null

export function flushQueue(): Promise<{ sent: number; failed: number }> {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; notifyChanged() })
  return flushing
}

async function doFlush(): Promise<{ sent: number; failed: number }> {
  const messages = await getQueuedMessages()
  let sent = 0
  let failed = 0

  for (const msg of messages) {
    try {
      const payload = {
        to: msg.to,
        cc: msg.cc,
        bcc: msg.bcc,
        subject: msg.subject,
        body: msg.body,
        bodyHtml: msg.bodyHtml,
        scheduled: msg.scheduled,
        inReplyTo: msg.inReplyTo,
        references: msg.references,
        attachments: msg.attachments ?? undefined
      }
      const res = await apiFetch('/api/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Never let the active account decide: a message queued under an
          // account that has since been removed is refused by the server and
          // stays queued, instead of leaving from another address.
          ...accountHeaders(msg.account)
        },
        body: JSON.stringify(payload)
      })
      const data = await res.json()
      if (data.success) {
        await removeQueuedMessage(msg.id!)
        sent++
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }

  return { sent, failed }
}

export async function queueCount(): Promise<number> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX, 'readonly')
    const req = tx.objectStore(OUTBOX).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// ---- Message cache ----
//
// The offline reading cache. It is shared storage for every configured account, so
// each entry belongs to one account (its address, trimmed and lower-cased) and
// every read, write and clear is scoped to it: the same folder and UID of two
// accounts are two entries, and listing a folder for one account never touches
// another's rows. An entry without an `account` (written before this existed)
// has an unknown owner: it is never served, and the next `cacheFolderList`
// deletes it.

export interface CachedMessage {
  key: string     // `${account}\0${folder}:${id}`, see cacheKey
  account: string
  folder: string
  id: string
  message: any
  full: boolean          // false = list row (no body), true = full message
  fetchedAt: number      // Date.now()
}

function normalizeAccount(account: string | null | undefined): string {
  return typeof account === 'string' ? account.trim().toLowerCase() : ''
}

/**
 * The account a cache WRITE (or a clear) belongs to: the active account, which is
 * the one every request is scoped to. An explicit `account` wins; callers that wait
 * for a response pass the one they asked under, so an answer that arrives after an
 * account switch is cached for the account it was asked for. `''` means no account
 * is active: nothing is written then. The account the browser remembered is not
 * enough here: with no active account a request carries no account header and the
 * server answers for its first account, which need not be the remembered one.
 */
export function cacheScope(account?: string | null): string {
  return account !== undefined ? normalizeAccount(account) : normalizeAccount(getActiveAccountEmail())
}

/**
 * The account a cache READ is for: an explicit `account`, else the active one, else
 * the account the browser remembered (a PWA that starts offline has no account list
 * yet, but must still read its own cache). `''` means no account is known: nothing
 * is shown then, because mail of an unknown owner must not be.
 */
export function cacheReadScope(account?: string | null): string {
  return normalizeAccount(account) || normalizeAccount(getActiveAccountEmail()) || normalizeAccount(readLocal()?.email)
}

export function cacheKey(folder: string, id: string, account: string): string {
  return `${normalizeAccount(account)}\u0000${folder}:${id}`
}

function readAll(db: IDBDatabase): Promise<CachedMessage[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(MSGS, 'readonly').objectStore(MSGS).getAll()
    req.onsuccess = () => resolve(req.result as CachedMessage[])
    req.onerror = () => reject(req.error)
  })
}

export async function putMessageCache(
  entry: Pick<CachedMessage, 'folder' | 'id' | 'message' | 'full'>,
  account?: string | null
): Promise<void> {
  const scope = cacheScope(account)
  if (!scope) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MSGS, 'readwrite')
    tx.objectStore(MSGS).put({
      ...entry, account: scope, key: cacheKey(entry.folder, entry.id, scope), fetchedAt: Date.now()
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getMessageCache(folder: string, id: string, account?: string | null): Promise<CachedMessage | undefined> {
  const scope = cacheReadScope(account)
  if (!scope) return undefined
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction(MSGS, 'readonly').objectStore(MSGS).get(cacheKey(folder, id, scope))
    req.onsuccess = () => {
      const hit = req.result as CachedMessage | undefined
      resolve(hit && hit.account === scope ? hit : undefined)
    }
    req.onerror = () => reject(req.error)
  })
}

/** Delete, in one transaction, every entry `doomed` selects. */
function deleteEntries(db: IDBDatabase, doomed: (e: CachedMessage) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MSGS, 'readwrite')
    const store = tx.objectStore(MSGS)
    const req = store.getAll()
    req.onsuccess = () => {
      for (const e of req.result as CachedMessage[]) if (doomed(e)) store.delete(e.key)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** With a folder: that folder of one account. Without: everything, every account. */
export async function clearMessageCache(folder?: string, account?: string | null): Promise<void> {
  const db = await openDB()
  if (folder === undefined) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MSGS, 'readwrite')
      tx.objectStore(MSGS).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
  const scope = cacheScope(account)
  if (!scope) return
  return deleteEntries(db, e => e.account === scope && e.folder === folder)
}

/** Everything cached for one account (it was removed). */
export async function clearAccountCache(account: string): Promise<void> {
  const scope = normalizeAccount(account)
  if (!scope) return
  return deleteEntries(await openDB(), e => e.account === scope)
}

// What a body load fills in (the same set as `LoadedFields` in openMessage.ts, plus
// the headers). The list row has an empty placeholder for each of these, or a
// different shape: its `attachments` come from the IMAP body structure and have no
// `id` to download by, and its `bcc` misses the envelope fallback. So for a stored
// full message the stored value always wins.
const FULL_ONLY_FIELDS = ['body', 'bodyHtml', 'pgp', 'attachments', 'cc', 'bcc', 'headers']

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The entry to write for a list row. A list row has no body, so writing it over a
 * message the user opened (stored `full`) would take the body away and the message
 * could no longer be read offline. The stored full message is kept instead: the row
 * supplies what the server can change since (flags, subject, date, thread, snippet,
 * ...), the stored message supplies what the row does not have properly (the fields
 * above, and every key the row lacks: message id, references, reply-to, ...). The
 * flags are the row's even when it has none: a flag removed on the server must not
 * come back from the cache.
 *
 * The cache does not know the folder's UIDVALIDITY. If the server renumbered the
 * folder, the same UID is another message, and the stored body must not be put under
 * its envelope: the merge only happens when sender and date are the same.
 */
function mergeStoredFull(prev: Partial<CachedMessage> | undefined, row: CachedMessage, scope: string): CachedMessage {
  if (!prev || prev.account !== scope || prev.full !== true || !isPlainObject(prev.message) || !isPlainObject(row.message)) return row
  if (prev.message.fromAddress !== row.message.fromAddress || prev.message.date !== row.message.date) return row
  const message: Record<string, any> = { ...row.message }
  for (const [k, v] of Object.entries(prev.message)) {
    if (FULL_ONLY_FIELDS.includes(k) || !(k in message)) message[k] = v
  }
  return { ...row, message, full: true }
}

export async function cacheFolderList(folder: string, messages: any[], account?: string | null): Promise<void> {
  const scope = cacheScope(account)
  if (!scope) return
  const db = await openDB()
  const now = Date.now()
  const rows: CachedMessage[] = messages.map(m => ({
    key: cacheKey(folder, m.id, scope),
    account: scope,
    folder,
    id: m.id,
    message: m,
    full: false,
    fetchedAt: now
  }))
  const fresh = new Set(rows.map(r => r.key))
  // One transaction for the read and the writes, and deletes by key instead of
  // clear-and-rewrite: two overlapping calls (a refresh and a folder switch) used
  // to rewrite from a stale snapshot and drop each other's rows.
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MSGS, 'readwrite')
    const store = tx.objectStore(MSGS)
    const req = store.getAll()
    req.onsuccess = () => {
      const stored = new Map<string, Partial<CachedMessage>>()
      for (const e of req.result as Partial<CachedMessage>[]) {
        const legacy = typeof e.account !== 'string'
        const stale = e.account === scope && e.folder === folder && !fresh.has(e.key as string)
        if (legacy || stale) store.delete(e.key as string)
        else if (typeof e.key === 'string') stored.set(e.key, e)
      }
      for (const r of rows) store.put(mergeStoredFull(stored.get(r.key), r, scope))
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function cachedMessagesForFolder(folder: string, account?: string | null): Promise<any[]> {
  const scope = cacheReadScope(account)
  if (!scope) return []
  const all = await readAll(await openDB())
  return all
    .filter(e => e.account === scope && e.folder === folder && isPlainObject(e.message))
    .sort(newestFirst)
    .map(c => c.message)
}

function messageTime(e: CachedMessage): number {
  const t = typeof e.message.date === 'string' ? Date.parse(e.message.date) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

function uidOf(e: CachedMessage): number {
  const n = Number.parseInt(String(e.id), 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * The order the server answers a folder in: newest message first. Every row of one
 * `cacheFolderList` call has the same `fetchedAt`, and opening a message gives it a
 * later one, so that time says nothing about the position in the folder; the message
 * date does. A message without a usable date comes last. The UID breaks a tie
 * numerically (it is a string, "99" is before "100" as text), `fetchedAt` the rest.
 */
function newestFirst(a: CachedMessage, b: CachedMessage): number {
  const ta = messageTime(a)
  const tb = messageTime(b)
  if (ta !== tb) return ta < tb ? 1 : -1
  return uidOf(b) - uidOf(a) || b.fetchedAt - a.fetchedAt
}

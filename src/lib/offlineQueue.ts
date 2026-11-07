import { apiFetch } from '../api'
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
  attachments?: Array<{ filename: string; content: string; contentType: string }>
  createdAt: string
}

export async function addQueuedMessage(msg: Omit<QueuedMessage, 'id'>): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX, 'readwrite')
    tx.objectStore(OUTBOX).add(msg)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
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

export async function flushQueue(): Promise<{ sent: number; failed: number }> {
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
        attachments: msg.attachments ?? undefined
      }
      const res = await apiFetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

export interface CachedMessage {
  key: string     // `${folder}:${id}`
  folder: string
  id: string
  message: any
  full: boolean          // false = list row (no body), true = full message
  fetchedAt: number      // Date.now()
}

export function cacheKey(folder: string, id: string): string {
  return `${folder}:${id}`
}

export async function putMessageCache(entry: Omit<CachedMessage, 'fetchedAt'>): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MSGS, 'readwrite')
    tx.objectStore(MSGS).put({ ...entry, fetchedAt: Date.now() })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getMessageCache(folder: string, id: string): Promise<CachedMessage | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MSGS, 'readonly')
    const req = tx.objectStore(MSGS).get(cacheKey(folder, id))
    req.onsuccess = () => resolve(req.result as CachedMessage | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function clearMessageCache(folder?: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MSGS, 'readwrite')
    const store = tx.objectStore(MSGS)
    if (!folder) {
      store.clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      return
    }
    const allReq = store.getAll()
    allReq.onsuccess = () => {
      const keep = (allReq.result as CachedMessage[]).filter(e => e.folder !== folder)
      const delTx = db.transaction(MSGS, 'readwrite')
      const delStore = delTx.objectStore(MSGS)
      delStore.clear()
      for (const e of keep) delStore.put(e)
      delTx.oncomplete = () => resolve()
      delTx.onerror = () => reject(delTx.error)
    }
    allReq.onerror = () => reject(allReq.error)
  })
}

export async function cacheFolderList(folder: string, messages: any[]): Promise<void> {
  const db = await openDB()
  const now = Date.now()
  const newEntries: CachedMessage[] = messages.map(m => ({
    key: cacheKey(folder, m.id),
    folder,
    id: m.id,
    message: m,
    full: false,
    fetchedAt: now
  }))
  const keySet = new Set(newEntries.map(e => e.key))

  // Keep only non-folder entries + this folder's fresh entries, then rewrite.
  const all = await new Promise<CachedMessage[]>((resolve, reject) => {
    const tx = db.transaction(MSGS, 'readonly')
    const req = tx.objectStore(MSGS).getAll()
    req.onsuccess = () => resolve(req.result as CachedMessage[])
    req.onerror = () => reject(req.error)
  })
  const kept = all.filter(e => e.folder !== folder || keySet.has(e.key))

  const tx = db.transaction(MSGS, 'readwrite')
  const store = tx.objectStore(MSGS)
  store.clear()
  for (const e of kept) store.put(e)
  for (const e of newEntries) store.put(e)
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function cachedMessagesForFolder(folder: string): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MSGS, 'readonly')
    const req = tx.objectStore(MSGS).getAll()
    req.onsuccess = () => {
      const out = (req.result as CachedMessage[])
        .filter(e => e.folder === folder)
        .sort((a, b) => b.fetchedAt - a.fetchedAt)
      resolve(out.map(c => c.message))
    }
    req.onerror = () => reject(req.error)
  })
}

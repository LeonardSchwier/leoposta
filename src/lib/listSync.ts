// Keeping the message list consistent while several loads are in flight.
//
// Folder loads, searches and background refreshes all write the same list.
// Their responses can arrive in any order (a slow folder, then a quick switch
// to another), so each load takes a ticket and only the newest one may apply.

export interface Latest {
  /** Start a load; the returned check is true while no newer load was started. */
  begin(): () => boolean
}

export function createLatest(): Latest {
  let seq = 0
  return {
    begin() {
      const mine = ++seq
      return () => mine === seq
    }
  }
}

/** Fields only the full message (GET /message/:id) has; the list endpoint sends them empty. */
const LOADED_FIELDS = ['body', 'bodyHtml', 'pgp', 'attachments', 'cc', 'bcc'] as const

interface ListMessage {
  id: string
  body?: string
  bodyHtml?: string
  pgp?: unknown
  attachments?: unknown
  cc?: unknown
  bcc?: unknown
}

function copyField<M, K extends keyof M>(to: M, from: M, k: K) {
  if (from[k] !== undefined) to[k] = from[k]
}

/**
 * The refreshed list of the same folder, keeping what was already loaded for
 * messages still in it (the open message must not lose its body when new
 * mail arrives).
 */
export function mergeRefreshed<M extends ListMessage>(previous: readonly M[], fresh: readonly M[]): M[] {
  const loaded = new Map(previous.filter((m) => m.body || m.bodyHtml).map((m) => [m.id, m]))
  return fresh.map((m) => {
    const old = loaded.get(m.id)
    if (!old) return m
    const merged: M = { ...m }
    for (const k of LOADED_FIELDS) copyField(merged, old, k)
    return merged
  })
}

interface Paged { id: string }

/** The list with the next (older) page appended; a message already shown is not repeated. */
export function appendPage<M extends Paged>(list: readonly M[], page: readonly M[]): M[] {
  const have = new Set(list.map((m) => m.id))
  return [...list, ...page.filter((m) => !have.has(m.id))]
}

/**
 * A refresh only re-reads the newest page. Pages the user already loaded with
 * "load more" stay below it: every shown message older than the refreshed
 * page (lower UID) is kept, unless the refreshed page is the whole folder.
 */
export function keepOlderPages<M extends Paged>(previous: readonly M[], refreshed: readonly M[], total: number): M[] {
  if (refreshed.length === 0 || refreshed.length >= total) return [...refreshed]
  const oldest = Math.min(...refreshed.map((m) => Number(m.id)))
  const have = new Set(refreshed.map((m) => m.id))
  return [...refreshed, ...previous.filter((m) => !have.has(m.id) && Number(m.id) < oldest)]
}

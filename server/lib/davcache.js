let _now = () => Date.now()

// Test seam: inject a controllable clock without timers.
export function setNow(fn) { _now = fn }
export function resetClock() { _now = () => Date.now() }

export const TTL_SHORT = 60_000
export const TTL_LONG = 10 * 60 * 1000

// Generic in-memory TTL map, no timers. FIFO-ish eviction once over maxEntries
// (Map preserves insertion order; a refresh re-inserts the key so it moves to
// the back). Lazy expiry happens on read.
export function createCache(maxEntries = 500) {
  const store = new Map()
  function evictToLimit() {
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value
      store.delete(oldest)
    }
  }
  const cache = {
    get(key) {
      const entry = store.get(key)
      if (!entry) return undefined
      if (_now() > entry.expiresAt) { store.delete(key); return undefined }
      return entry.value
    },
    set(key, value, ttlMs = TTL_LONG) {
      if (store.has(key)) store.delete(key)
      store.set(key, { value, expiresAt: _now() + ttlMs })
      evictToLimit()
    },
    invalidate(key) { store.delete(key) },
    invalidatePrefix(prefix) {
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k)
    },
    clear() { store.clear() },
    size() { return store.size }
  }
  return cache
}

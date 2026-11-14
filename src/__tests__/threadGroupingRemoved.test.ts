// "Group messages by thread" was a setting without any effect (there is no
// conversation view). It is gone from the store and the Settings UI. It was
// never written to storage, but a profile that still carries a stray key
// from an old build must load the persisted settings without errors.
import { describe, it, expect } from 'vitest'
import { get } from 'svelte/store'
import * as storeModule from '../store'
import { loadPersistedRefreshMode } from '../refresh'

function memoryStorage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init))
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, String(v)) }
  }
}

describe('thread grouping setting removed', () => {
  it('is not in the store state and has no setter', () => {
    expect('threadGrouping' in get(storeModule.store)).toBe(false)
    expect('setThreadGrouping' in storeModule).toBe(false)
  })

  it('old persisted settings with a threadGrouping key still load', () => {
    const storage = memoryStorage({
      threadGrouping: 'true',
      'leoposta:threadGrouping': 'false',
      'leoposta:settings': JSON.stringify({ threadGrouping: true, refreshInterval: '5m' }),
      'leoposta:refreshInterval': '5m'
    })
    expect(() => loadPersistedRefreshMode(storage)).not.toThrow()
    expect(loadPersistedRefreshMode(storage)).toBe('5m')
    expect('threadGrouping' in get(storeModule.store)).toBe(false)
  })
})

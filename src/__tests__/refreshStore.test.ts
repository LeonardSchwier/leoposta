// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { store, setRefreshInterval, bootstrapRefreshMode } from '../store'
import type { RefreshMode } from '../refresh'

class MemStorage implements Storage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.get(k) ?? null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, v) }
}

beforeEach(() => { vi.stubGlobal('localStorage', new MemStorage()) })

describe('refreshInterval store', () => {
  it('defaults to instant', () => {
    expect(get(store).refreshInterval).toBe('instant')
  })

  it('setRefreshInterval updates the store and persists', () => {
    setRefreshInterval('15m' as RefreshMode)
    expect(get(store).refreshInterval).toBe('15m')
    expect(globalThis.localStorage.getItem('leoposta:refreshInterval')).toBe('15m')
  })

  it('bootstrapRefreshMode restores the saved mode into the store', () => {
    globalThis.localStorage.setItem('leoposta:refreshInterval', '60m')
    bootstrapRefreshMode()
    expect(get(store).refreshInterval).toBe('60m')
  })

  it('bootstrapRefreshMode falls back to instant when nothing stored', () => {
    bootstrapRefreshMode()
    expect(get(store).refreshInterval).toBe('instant')
  })
})

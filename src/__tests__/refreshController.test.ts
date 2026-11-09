// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startRefresh, stopRefresh, getRefreshMode } from '../refresh'
import { loadPersistedRefreshMode, saveRefreshMode } from '../refresh'

class FakeEs {
  static instances: FakeEs[] = []
  close = vi.fn()
  listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  addEventListener = vi.fn((type: string, fn: (...a: unknown[]) => void) => {
    ;(this.listeners[type] ??= []).push(fn)
  })
  constructor(public url: string) { FakeEs.instances.push(this) }
  emit(type: string) {
    for (const fn of this.listeners[type] ?? []) fn()
  }
}

class MemStorage implements Storage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.get(k) ?? null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, v) }
}

beforeEach(() => {
  FakeEs.instances = []
  vi.stubGlobal('EventSource', FakeEs)
  vi.stubGlobal('localStorage', new MemStorage())
})
afterEach(() => {
  stopRefresh()
  vi.unstubAllGlobals()
})

describe('startRefresh', () => {
  const tick = () => {}

  it('opens one EventSource for instant mode', () => {
    startRefresh('instant', tick)
    expect(FakeEs.instances).toHaveLength(1)
    expect(getRefreshMode()).toBe('instant')
  })

  it('replaces the stream when started again', () => {
    startRefresh('instant', tick)
    const first = FakeEs.instances[0]
    startRefresh('15m', tick)
    expect(first.close).toHaveBeenCalled()
    expect(getRefreshMode()).toBe('15m')
  })

  it('closes the stream on stopRefresh', () => {
    startRefresh('instant', tick)
    const es = FakeEs.instances[0]
    stopRefresh()
    expect(es.close).toHaveBeenCalledTimes(1)
    expect(getRefreshMode()).toBe('off')
  })

  it('does not open a stream for off mode', () => {
    startRefresh('off', tick)
    expect(FakeEs.instances).toHaveLength(0)
  })

  it('skips a timer tick while a text input has focus', async () => {
    vi.useFakeTimers()
    try {
      const onTick = vi.fn()
      startRefresh('5m', onTick)
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      vi.advanceTimersByTime(5 * 60_000)
      expect(onTick).not.toHaveBeenCalled()
      input.blur()
      vi.advanceTimersByTime(5 * 60_000)
      expect(onTick).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs onTick when a mailbox-update event arrives (no typing focus)', () => {
    const onTick = vi.fn()
    startRefresh('instant', onTick)
    expect(onTick).not.toHaveBeenCalled()
    const es = FakeEs.instances[0]
    es.emit('mailbox-update')
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('skips onTick for mailbox-update while a text input has focus', () => {
    const onTick = vi.fn()
    startRefresh('instant', onTick)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const es = FakeEs.instances[0]
    es.emit('mailbox-update')
    expect(onTick).not.toHaveBeenCalled()
    input.blur()
  })
})

describe('persistence', () => {
  it('default is instant when nothing stored', () => {
    expect(loadPersistedRefreshMode()).toBe('instant')
  })

  it('round-trips through storage', () => {
    saveRefreshMode('60m')
    expect(loadPersistedRefreshMode()).toBe('60m')
  })

  it('returns default for unknown values', () => {
    globalThis.localStorage.setItem('leoposta:refreshInterval', 'bogus')
    expect(loadPersistedRefreshMode()).toBe('instant')
  })
})

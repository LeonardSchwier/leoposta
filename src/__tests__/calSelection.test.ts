import { describe, it, expect } from 'vitest'
import {
  defaultSelection,
  loadSelection,
  saveSelection,
  isCalSelected,
  type CalItem,
} from '../lib/calSelection'

const STORAGE_KEY = 'leoposta.calendarSelection'

function makeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
  }
}

const cals: CalItem[] = [
  { uri: 'cal-a' },
  { uri: 'cal-b' },
  { uri: 'cal-c' },
]

describe('defaultSelection', () => {
  it('returns all uris in order', () => {
    expect(defaultSelection(cals)).toEqual(['cal-a', 'cal-b', 'cal-c'])
  })

  it('returns [] for empty input', () => {
    expect(defaultSelection([])).toEqual([])
  })
})

describe('isCalSelected', () => {
  it('true for a member uri', () => {
    expect(isCalSelected(['cal-a', 'cal-b'], 'cal-b')).toBe(true)
  })
  it('false for a non-member uri', () => {
    expect(isCalSelected(['cal-a', 'cal-b'], 'cal-c')).toBe(false)
  })
})

describe('loadSelection / saveSelection round-trip', () => {
  it('first load (no persistence) defaults to all', () => {
    const storage = makeStorage()
    expect(loadSelection(storage, STORAGE_KEY, cals)).toEqual(['cal-a', 'cal-b', 'cal-c'])
  })

  it('persists a subset and reloads it', () => {
    const storage = makeStorage()
    saveSelection(storage, STORAGE_KEY, cals, ['cal-b'])
    expect(loadSelection(storage, STORAGE_KEY, cals)).toEqual(['cal-b'])
  })

  it('drops persisted uris that no longer exist', () => {
    const storage = makeStorage()
    saveSelection(storage, STORAGE_KEY, cals, ['cal-b', 'cal-zombie'])
    const current = cals.filter((c) => c.uri !== 'cal-zombie')
    expect(loadSelection(storage, STORAGE_KEY, current)).toEqual(['cal-b'])
  })

  it('persists and reloads an empty selection (user chose none)', () => {
    const storage = makeStorage()
    saveSelection(storage, STORAGE_KEY, cals, [])
    expect(loadSelection(storage, STORAGE_KEY, cals)).toEqual([])
  })

  it('does not auto-add a newly-appeared calendar to a persisted selection', () => {
    const storage = makeStorage()
    saveSelection(storage, STORAGE_KEY, cals, ['cal-a'])
    const grew = [...cals, { uri: 'cal-new' }]
    expect(loadSelection(storage, STORAGE_KEY, grew)).toEqual(['cal-a'])
  })
})

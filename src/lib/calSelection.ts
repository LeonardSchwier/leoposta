export type CalItem = { uri: string }
export type CalSelection = { selected: string[] }

const STORAGE_KEY = 'leoposta.calendarSelection'

export function defaultSelection(cals: CalItem[]): string[] {
  return cals.map((c) => c.uri)
}

export function isCalSelected(selected: string[], uri: string): boolean {
  return selected.includes(uri)
}

export function saveSelection(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  storageKey: string,
  cals: CalItem[],
  selected: string[],
): void {
  const valid = new Set(cals.map((c) => c.uri))
  const filtered = selected.filter((uri) => valid.has(uri))
  storage.setItem(storageKey, JSON.stringify(filtered))
}

export function loadSelection(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  storageKey: string,
  cals: CalItem[],
): string[] {
  const currentUris = new Set(cals.map((c) => c.uri))
  const raw = storage.getItem(storageKey)
  if (raw === null) {
    return defaultSelection(cals)
  }
  let parsed: string[]
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultSelection(cals)
  }
  if (!Array.isArray(parsed)) {
    return defaultSelection(cals)
  }
  return parsed.filter((uri) => currentUris.has(uri))
}

export { STORAGE_KEY }

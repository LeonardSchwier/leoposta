export type RefreshMode = 'instant' | '5m' | '15m' | '60m' | 'off'

const REFRESH_MS: Record<Exclude<RefreshMode, 'instant' | 'off'>, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '60m': 60 * 60_000,
}

export function intervalMs(mode: RefreshMode): number | null {
  if (mode === 'instant' || mode === 'off') return null
  return REFRESH_MS[mode]
}

const MODES: readonly RefreshMode[] = ['instant', '5m', '15m', '60m', 'off']
const STORAGE_KEY = 'leoposta:refreshInterval'

export function isTypingFocused(): boolean {
  const el = document.activeElement
  if (!el || el === document.body) return false
  const node = el as HTMLElement
  if (
    node.tagName === 'INPUT' ||
    node.tagName === 'TEXTAREA' ||
    node.tagName === 'SELECT' ||
    node.getAttribute('contenteditable') !== null ||
    node.isContentEditable
  ) {
    return true
  }
  const inner = node.querySelector?.('input, textarea, select, [contenteditable="true"]')
  return inner !== null
}

// --- Controller -------------------------------------------------------

export function runRefreshTick(onTick: () => void): void {
  if (!isTypingFocused()) onTick()
}

let eventSource: EventSource | null = null
let timer: ReturnType<typeof setInterval> | null = null
let current: RefreshMode = 'off'

function teardown(): void {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

export function getRefreshMode(): RefreshMode {
  return current
}

import { MailAPI } from './api'

export function startRefresh(
  mode: RefreshMode,
  onTick: () => void,
  idleUrl: string = MailAPI.idle()
): void {
  teardown()
  current = mode
  if (mode === 'off') return
  if (mode === 'instant') {
    const es = new EventSource(idleUrl)
    es.addEventListener('mailbox-update', () => runRefreshTick(onTick))
    eventSource = es
    return
  }
  const ms = intervalMs(mode)
  if (ms !== null) {
    timer = setInterval(() => runRefreshTick(onTick), ms)
  }
}

export function stopRefresh(): void {
  teardown()
  current = 'off'
}

// --- Persistence ------------------------------------------------------

export function loadPersistedRefreshMode(storage: Storage = globalThis.localStorage): RefreshMode {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw && (MODES as readonly string[]).includes(raw)) return raw as RefreshMode
  } catch {
    // ignore — return default below
  }
  return 'instant'
}

export function saveRefreshMode(mode: RefreshMode, storage: Storage = globalThis.localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, mode)
  } catch {
    // ignore — storage unavailable (private mode, jsdom without implementation)
  }
}

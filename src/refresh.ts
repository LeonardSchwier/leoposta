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

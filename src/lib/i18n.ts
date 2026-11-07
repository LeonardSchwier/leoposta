import { writable, get } from 'svelte/store'
import { en } from './locales/en'
import { de } from './locales/de'

export type Lang = 'en' | 'de'
export type LocaleKey = keyof typeof en

const dicts = { en, de } as const
const warned = new Set<string>()

function safeSet(k: string, v: string) {
  try { localStorage.setItem(k, v) } catch { /* private mode / no DOM */ }
}
function safeGet(k: string): string | null {
  try { return localStorage.getItem(k) } catch { return null }
}

export function initialLang(): Lang {
  const stored = safeGet('leoposta.lang')
  if (stored === 'en' || stored === 'de') return stored
  const nav = (typeof navigator !== 'undefined' && navigator.language) || ''
  if (nav.toLowerCase().startsWith('de')) return 'de'
  return 'en'
}

// Reactive store — cross-component by design. In Svelte templates:
//   `$lang` reads, `setLang(next)` writes.
export const lang = writable<Lang>(initialLang())

// Apply the initial value to <html lang> once at import time, so a
// de-default user gets a correct <html lang="de"> on first paint without
// opening Settings.
try { document.documentElement.lang = get(lang) } catch { /* no DOM (unit tests) */ }

function applyDom() {
  try { document.documentElement.lang = get(lang) } catch { /* no DOM */ }
}

export function setLang(next: Lang): void {
  if (!(next in dicts)) return
  lang.set(next)
  safeSet('leoposta.lang', next)
  applyDom()
}

function substitute(s: string, params?: Record<string, string | number>): string {
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  )
}

function warnOnce(key: string) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[i18n] missing key: ${key}`)
}

function _t(active: Lang, key: string, params?: Record<string, string | number>): string {
  const v = dicts[active][key] ?? dicts.en[key]
  if (v === undefined) { warnOnce(key); return key }
  return substitute(v, params)
}

// Overload 1 — classic, works in scripts and Svelte 4 templates:
//   t('settings.title')
// Overload 2 — Svelte 5 runes template helper, pass $lang explicitly
//   to create a tracked reactive dependency:  {t($lang, 'settings.title')}
export function t(key: LocaleKey | string, params?: Record<string, string | number>): string
export function t(active: Lang, key: LocaleKey | string, params?: Record<string, string | number>): string
export function t(a: Lang | LocaleKey | string, b?: LocaleKey | string | Record<string, string | number>, c?: Record<string, string | number>): string {
  if (a === 'en' || a === 'de') return _t(a, b as string, c)
  return _t(get(lang), a as string, b as Record<string, string | number> | undefined)
}

function withFallback(base: string, suffix: '.one' | '.other'): string {
  const full = `${base}${suffix}`
  return (dicts[get(lang)][full] !== undefined || dicts.en[full] !== undefined) ? full : base
}

export function tPl(key: LocaleKey | string, n: number): string {
  const slot = n === 1 ? withFallback(key, '.one') : withFallback(key, '.other')
  return t(slot, { n })
}

// Cross-tab sync — installed at import time. The listener is a no-op in
// SSR / Node envs where window is undefined; jsdom tests can still
// dispatch a StorageEvent to trigger it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === 'leoposta.lang' && (e.newValue === 'en' || e.newValue === 'de')) {
      lang.set(e.newValue)
      try { document.documentElement.lang = e.newValue } catch { /* no DOM */ }
    }
  })
}

export default { lang, t, tPl, setLang, initialLang }

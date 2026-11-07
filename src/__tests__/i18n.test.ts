// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { get } from 'svelte/store'
import en from '../lib/locales/en'
import de from '../lib/locales/de'
import { lang, t, tPl, setLang, initialLang } from '../lib/i18n'

function makeStub() {
  const store = new Map<string, string>()
  const s = {
    store,
    getItem(k: string) { return store.has(k) ? store.get(k)! : null },
    setItem(k: string, v: string) { store.set(k, String(v)) },
    removeItem(k: string) { store.delete(k) },
    clear() { store.clear() },
    key(i: number) { return Array.from(store.keys())[i] ?? null },
    get length() { return store.size }
  }
  for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
    // @ts-expect-error bound method
    s[m] = s[m].bind(s)
  }
  return s
}

const throwOnce = {
  getItem() { throw new Error('denied') },
  setItem() { throw new Error('denied') },
  removeItem() {},
  clear() {},
  key: () => null,
  get length() { return 0 }
}
for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
  ;(throwOnce as any)[m] = (throwOnce as any)[m].bind(throwOnce)
}

const stub = makeStub()
let originalNavigatorLanguage: string

function fresh(env: 'ok' | 'throwing' = 'ok') {
  stub.clear()
  vi.stubGlobal('localStorage', env === 'throwing' ? throwOnce : stub)
  setLang('en')
  stub.clear()
}

beforeEach(() => {
  vi.useFakeTimers()
  fresh('ok')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // @ts-expect-error — jsdom navigator
  originalNavigatorLanguage = navigator.language
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  // Restore the original navigator.language (tests may redefine it).
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'language', {
      value: originalNavigatorLanguage,
      configurable: true
    })
  }
})

describe('t()', () => {
  it('returns the en string for a known key when lang=en', () => {
    expect(get(lang)).toBe('en')
    expect(t('compose.to.label')).toBe('To')
  })

  it('falls back to en when the active dict is missing the key', () => {
    setLang('de')
    expect(get(lang)).toBe('de')
    // 'en-only.key' exists in en.ts but not in de.ts — expect en fallback.
    expect(t('en-only.key' as any)).toBe('EN only')
  })

  it('returns the key verbatim (and warns once) for a key missing in both', () => {
    expect(t('definitely.missing.key')).toBe('definitely.missing.key')
    expect(t('definitely.missing.key')).toBe('definitely.missing.key')
    const warn = vi.mocked(console.warn)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[i18n] missing key: definitely.missing.key')
  })

  it('substitutes {name} params (no re-scan of substituted values)', () => {
    expect(t('greet.user', { user: 'Leo' })).toBe('Hello, Leo!')
    // Curly braces in a substituted value must NOT be re-scanned.
    expect(t('wrap.err', { err: 'boom {oops}' })).toBe('Err: boom {oops}.')
  })
})

describe('tPl()', () => {
  it('picks the one-form when n === 1', () => {
    expect(tPl('misc.count', 1)).toBe('1 item')
    expect(tPl('app.send.success', 1)).toBe('1 queued message sent')
  })

  it('picks the other-form when n !== 1 and fills {n}', () => {
    expect(tPl('misc.count', 5)).toBe('5 items')
    expect(tPl('app.send.success', 5)).toBe('5 queued messages sent')
  })

  it('falls back to the bare key (no .one/.other) when not found', () => {
    expect(tPl('misc.bare' as any, 3)).toBe('3 bare items')
  })
})

describe('setLang()', () => {
  it('sets the store, persists to localStorage, and updates <html lang>', () => {
    setLang('de')
    expect(get(lang)).toBe('de')
    expect(stub.getItem('leoposta.lang')).toBe('de')
    expect(document.documentElement.lang).toBe('de')
  })

  it('is a no-op when the value is not a known lang', () => {
    setLang('de')
    setLang('xx' as any)
    expect(get(lang)).toBe('de')
    expect(stub.getItem('leoposta.lang')).toBe('de')
  })
})

describe('initialLang()', () => {
  it('returns the stored value when valid', () => {
    // Note: initialLang() reads from localStorage; in 'ok' env, `stub` is in play.
    // We need `initialLang` to see the stub value we set.
    const real = (globalThis as any).localStorage
    ;(globalThis as any).localStorage.setItem('leoposta.lang', 'de')
    expect(initialLang()).toBe('de')
  })

  it('returns "de" when navigator.language starts with "de"', () => {
    // Ensure no stored value is in play — clear stub first.
    stub.clear()
    Object.defineProperty(navigator, 'language', { value: 'de-AT', configurable: true })
    expect(initialLang()).toBe('de')
  })

  it('returns "en" when localStorage throws (Safari private mode)', () => {
    // With throwing localStorage, initialLang() cannot read stored; falls to navigator.
    // In jsdom, navigator.language defaults to 'en-US' which does NOT start with 'de'.
    fresh('throwing')
    expect(initialLang()).toBe('en')
  })
})

describe('cross-tab', () => {
  it('flips lang when another tab writes a valid value', () => {
    stub.setItem('leoposta.lang', 'en')
    window.dispatchEvent(new StorageEvent('storage', { key: 'leoposta.lang', newValue: 'de' }))
    expect(get(lang)).toBe('de')
  })

  it('ignores the storage event when newValue is not a valid lang', () => {
    stub.setItem('leoposta.lang', 'en')
    window.dispatchEvent(new StorageEvent('storage', { key: 'leoposta.lang', newValue: 'xx' }))
    expect(get(lang)).toBe('en')
  })
})

describe('Settings language keys (task 2 seed)', () => {
  it('resolves settings.title in en and de', () => {
    expect(t('settings.title')).toBe('Settings')
    setLang('de')
    expect(t('settings.title')).toBe('Einstellungen')
  })

  it('resolves settings.close in en and de', () => {
    setLang('en')
    expect(t('settings.close')).toBe('Close')
    setLang('de')
    expect(t('settings.close')).toBe('Schließen')
  })

  it('resolves settings.language.option.en and .de', () => {
    setLang('en')
    expect(t('settings.language.option.en')).toBe('English')
    expect(t('settings.language.option.de')).toBe('Deutsch')
    setLang('de')
    expect(t('settings.language.option.en')).toBe('Englisch')
    expect(t('settings.language.option.de')).toBe('Deutsch')
  })

  it('resolves settings.language.hint in both locales', () => {
    setLang('en')
    expect(t('settings.language.hint')).toContain('all leoposta screens')
    setLang('de')
    expect(t('settings.language.hint')).toContain('in diesem Browser gespeichert')
  })

  it('resolves settings.tab.language', () => {
    setLang('en')
    expect(t('settings.tab.language')).toBe('Language')
    setLang('de')
    expect(t('settings.tab.language')).toBe('Sprache')
  })
})

describe('Compose locale keys (task 3)', () => {
  it('resolves compose.to.label in en and de', () => {
    expect(t('compose.to.label')).toBe('To')
    setLang('de')
    expect(t('compose.to.label')).toBe('An')
  })

  it('resolves compose.title.new and compose.close.aria', () => {
    setLang('en')
    expect(t('compose.title.new')).toBe('New Message')
    expect(t('compose.close.aria')).toBe('Close compose (Esc)')
    setLang('de')
    expect(t('compose.title.new')).toBe('Neue Nachricht')
    expect(t('compose.close.aria')).toBe('Verfassen schließen (Esc)')
  })

  it('substitutes {err} in compose.send.failed', () => {
    setLang('en')
    expect(t('compose.send.failed', { err: 'no network' })).toBe('Failed to send: no network')
    setLang('de')
    expect(t('compose.send.failed', { err: 'kein Netz' })).toBe('Senden fehlgeschlagen: kein Netz')
  })

  it('substitutes {filename} in compose.attach.remove.aria', () => {
    setLang('en')
    expect(t('compose.attach.remove.aria', { filename: 'x.pdf' })).toBe('Remove x.pdf')
    setLang('de')
    expect(t('compose.attach.remove.aria', { filename: 'x.pdf' })).toBe('x.pdf entfernen')
  })

  it('resolves compose.saveDraft in en and de', () => {
    setLang('en')
    expect(t('compose.saveDraft')).toBe('Save Draft')
    setLang('de')
    expect(t('compose.saveDraft')).toBe('Entwurf speichern')
  })

  it('substitutes {name} and {err} in compose.attach.failed', () => {
    setLang('en')
    const out = t('compose.attach.failed', { name: 'a.txt', err: 'too big' })
    expect(out).toContain('a.txt')
    expect(out).toContain('too big')
  })
})


describe('MessageList locale keys (task 4)', () => {
  it('resolves list.star.star and list.star.unstar in en and de', () => {
    expect(t('list.star.star')).toBe('Star')
    expect(t('list.star.unstar')).toBe('Unstar')
    setLang('de')
    expect(t('list.star.star')).toBe('Markieren')
    expect(t('list.star.unstar')).toBe('Markierung entfernen')
  })

  it('picks list.attachments.one at n=1', () => {
    expect(tPl('list.attachments', 1)).toBe('📎 1 attachment')
    setLang('de')
    expect(tPl('list.attachments', 1)).toBe('📎 1 Anhang')
  })

  it('picks list.attachments.other at n=5 and fills {n}', () => {
    setLang('en')
    expect(tPl('list.attachments', 5)).toBe('📎 5 attachments')
    setLang('de')
    expect(tPl('list.attachments', 5)).toBe('📎 5 Anhänge')
  })

  it('resolves list.actions.reply and list.actions.delete', () => {
    setLang('en')
    expect(t('list.actions.reply')).toBe('Reply')
    expect(t('list.actions.delete')).toBe('Delete')
    setLang('de')
    expect(t('list.actions.reply')).toBe('Antworten')
    expect(t('list.actions.delete')).toBe('Löschen')
  })

  it('resolves list.date.yesterday', () => {
    expect(t('list.date.yesterday')).toBe('Yesterday')
    setLang('de')
    expect(t('list.date.yesterday')).toBe('Gestern')
  })

  it('resolves list.empty and list.empty.search', () => {
    setLang('en')
    expect(t('list.empty')).toBe('No messages')
    expect(t('list.empty.search')).toBe('No results')
    setLang('de')
    expect(t('list.empty')).toBe('Keine Nachrichten')
    expect(t('list.empty.search')).toBe('Keine Ergebnisse')
  })
})

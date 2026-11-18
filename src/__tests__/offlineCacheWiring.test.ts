// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, unmount, flushSync } from 'svelte'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { cacheFolderList, cachedMessagesForFolder } from '../lib/offlineQueue'
import { getState, setAccounts, setMessages } from '../store'
import { setActiveAccountEmail } from '../api'

// The offline cache is shared by every account on the device. The app has to ask
// it for the account on screen, or one account's mail shows under another's name
// when the backend cannot be reached.

class FakeEventSource {
  addEventListener() {}
  close() {}
}

const ERIKA = 'erika@example.test'
const MAX = 'max@example.test'

beforeEach(() => {
  ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
  setActiveAccountEmail(null)
  setAccounts([], null)
  setMessages([])
  localStorage.clear()
})
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('offline start with two cached accounts', () => {
  it('shows the cached mail of the remembered account only', async () => {
    // Erika's list was cached first, then Max's: a cache that is not scoped keeps the last one.
    await cacheFolderList('INBOX', [{ id: 'e1', subject: 'For Erika', flags: [] }], ERIKA)
    await cacheFolderList('INBOX', [{ id: 'm1', subject: 'For Max', flags: [] }], MAX)
    localStorage.setItem('leoposta:activeAccount', JSON.stringify({ id: 'a1', email: ERIKA }))

    const calls: string[] = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      calls.push(String(input))
      throw new TypeError('Failed to fetch') // backend unreachable
    }))
    if (!('ResizeObserver' in globalThis)) vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const { default: App } = await import('../App.svelte')
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(App, { target })
    for (let i = 0; i < 40 && getState().messages.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
      flushSync()
    }
    expect(calls.some((u) => u.includes('/api/messages'))).toBe(true)
    expect(getState().messages.map((m) => m.id)).toEqual(['e1'])
    unmount(app)
    target.remove()
  })

  it('does not cache a list under the remembered account when the account list could not be fetched', async () => {
    // The accounts request fails but the list request succeeds: nothing is active, so
    // the request carried no account header and the server answered for its first
    // account. That list must not be cached as the remembered account's.
    localStorage.setItem('leoposta:activeAccount', JSON.stringify({ id: 'a1', email: ERIKA }))
    const calls: string[] = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      calls.push(String(input))
      if (String(input).includes('/api/messages')) {
        return new Response(JSON.stringify({ messages: [{ id: 'y1', subject: 'First account', flags: [] }], total: 1 }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (String(input).includes('/api/folders')) {
        return new Response(JSON.stringify({ folders: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new TypeError('Failed to fetch') // the account list
    }))
    if (!('ResizeObserver' in globalThis)) vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const { default: App } = await import('../App.svelte')
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(App, { target })
    for (let i = 0; i < 40 && getState().messages.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
      flushSync()
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(getState().messages.map((m) => m.id)).toEqual(['y1'])
    expect(await cachedMessagesForFolder('INBOX', ERIKA)).toEqual([])
    unmount(app)
    target.remove()
  })

  it('shows nothing from the cache when the remembered account has none cached', async () => {
    await cacheFolderList('INBOX', [{ id: 'm1', subject: 'For Max', flags: [] }], MAX)
    localStorage.setItem('leoposta:activeAccount', JSON.stringify({ id: 'a1', email: ERIKA }))

    const calls: string[] = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      calls.push(String(input))
      throw new TypeError('Failed to fetch')
    }))
    if (!('ResizeObserver' in globalThis)) vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const { default: App } = await import('../App.svelte')
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(App, { target })
    for (let i = 0; i < 20 && !calls.some((u) => u.includes('/api/messages')); i++) {
      await new Promise((r) => setTimeout(r, 10))
      flushSync()
    }
    await new Promise((r) => setTimeout(r, 50))
    flushSync()
    expect(getState().messages).toEqual([])
    expect(getState().error ?? '').not.toMatch(/cached message/)
    unmount(app)
    target.remove()
  })
})

// The component wiring that needs a browser to exercise (a confirm() dialog, an
// account switch) is pinned at the source level, like the other wiring guards.
describe('cache wiring in the components', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

  it('removing an account deletes its cached mail', () => {
    const settings = read('components/Settings.svelte')
    const remove = settings.slice(settings.indexOf('function handleRemove'))
    const afterRemove = remove.slice(remove.indexOf('AccountAPI.remove(acc.email)'))
    expect(afterRemove).toMatch(/\.then\(async \(\) => \{[^}]*clearAccountCache\(acc\.email\)/)
  })

  it('switching accounts no longer wipes a folder of the account switched to', () => {
    const app = read('App.svelte')
    expect(app).not.toMatch(/clearMessageCache\(/)
  })

  it('every cache call in App.svelte names the account it is for', () => {
    const app = read('App.svelte')
    for (const call of ['cacheFolderList', 'cachedMessagesForFolder', 'putMessageCache', 'getMessageCache']) {
      const uses = [...app.matchAll(new RegExp(`${call}\\(([^\\n]*)`, 'g'))].map((m) => m[1])
      expect(uses.length, call).toBeGreaterThan(0)
      for (const u of uses) expect(u, `${call}(${u}`).toMatch(/cacheAccount/)
    }
  })
})

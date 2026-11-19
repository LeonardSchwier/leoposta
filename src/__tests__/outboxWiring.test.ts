// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { addQueuedMessage, getQueuedMessages } from '../lib/offlineQueue'
import { getState, setAccounts, setMessages } from '../store'
import { setActiveAccountEmail } from '../api'

// Mail written offline is queued in IndexedDB. These tests mount the whole app
// and check what the user gets of that queue: it is sent when the app opens
// online (no `online` event fires then), a stuck message is visible and can be
// discarded, and the offline badge reads as before.

class FakeEventSource {
  addEventListener() {}
  close() {}
}

const ERIKA = 'erika@example.test'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let sends: Array<{ account: string | null; subject: string }>
let sendAnswer: () => Response
// App adds window listeners it never removes (it is mounted once in the real
// app). Each test mounts its own App, so take the previous ones off again or
// their handlers answer the keys of the next test.
const windowListeners: Array<[string, EventListenerOrEventListenerObject]> = []

beforeEach(() => {
  ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
  setActiveAccountEmail(null)
  setAccounts([], null)
  setMessages([])
  localStorage.clear()
  sends = []
  sendAnswer = () => json({ success: true })
  const addWindowListener = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, handler: any, options?: any) => {
    windowListeners.push([type, handler])
    addWindowListener(type, handler, options)
  }) as any)
  vi.stubGlobal('EventSource', FakeEventSource)
  if (!('ResizeObserver' in globalThis)) vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: any) => {
    const url = String(input)
    if (url.includes('/api/send')) {
      sends.push({ account: init?.headers?.['x-account'] ?? null, subject: JSON.parse(init.body).subject })
      return sendAnswer()
    }
    if (url.includes('/api/accounts')) return json([{ id: 'a1', email: ERIKA, name: 'Erika' }])
    if (url.includes('/api/active-account')) return json({ email: ERIKA })
    if (url.includes('/api/folders')) return json({ folders: [] })
    if (url.includes('/api/messages')) return json({ messages: [], total: 0 })
    return json({})
  }))
})
afterEach(() => {
  for (const [type, handler] of windowListeners.splice(0)) window.removeEventListener(type, handler)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

const draft = (subject: string, extra: Record<string, unknown> = {}) => ({
  to: ['anna@example.test'], subject, body: 'b', createdAt: new Date().toISOString(), account: ERIKA, ...extra
})

async function mountApp() {
  const { default: App } = await import('../App.svelte')
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  return { target, dispose: () => { unmount(app); target.remove() } }
}

async function until(check: () => boolean, ms = 1500) {
  for (let i = 0; i < ms / 10 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 10))
    flushSync()
  }
}

const badge = (target: HTMLElement) => target.querySelector<HTMLElement>('.queue-badge')

describe('the outbox when the app opens online', () => {
  it('sends mail that was queued offline, once, from the account it was written under', async () => {
    await addQueuedMessage(draft('written on the train'))
    const { target, dispose } = await mountApp()
    await until(() => sends.length > 0)
    await until(() => false, 150) // give a second, wrong send time to happen
    expect(sends).toEqual([{ account: ERIKA, subject: 'written on the train' }])
    expect(await getQueuedMessages()).toEqual([])
    expect(target.querySelector('[data-testid="toast"]')?.textContent).toContain('1 queued message sent')
    expect(badge(target)).toBeNull()
    dispose()
  })

  it('does not send again when an online event follows the start-up send', async () => {
    await addQueuedMessage(draft('only once'))
    const { dispose } = await mountApp()
    await until(() => sends.length > 0)
    window.dispatchEvent(new Event('online'))
    await until(() => false, 150)
    expect(sends).toHaveLength(1)
    dispose()
  })

  it('does not try to send while the browser is offline, and the badge keeps its text', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await addQueuedMessage(draft('later'))
    const { target, dispose } = await mountApp()
    await until(() => badge(target) !== null)
    await until(() => false, 150)
    expect(sends).toEqual([])
    expect(badge(target)!.textContent!.trim()).toBe('1 queued · will send when online')
    dispose()
  })

  it('shows a message the server refuses as unsent, with the reason, and lets the user discard it', async () => {
    sendAnswer = () => json({ error: 'No account configured' }, 400)
    vi.stubGlobal('confirm', vi.fn(() => true))
    await addQueuedMessage(draft('to a removed account'))
    const { target, dispose } = await mountApp()
    await until(() => (badge(target)?.textContent ?? '').includes('unsent'))
    expect(badge(target)!.tagName).toBe('BUTTON')
    expect(badge(target)!.textContent!.trim()).toBe('1 unsent · Review')
    expect(target.querySelector('[data-testid="toast"]')?.textContent).toContain('1 queued message failed')

    badge(target)!.click()
    await until(() => target.querySelector('[role="dialog"][aria-labelledby="outbox-title"]') !== null)
    await until(() => target.querySelector('[data-testid="outbox-item"]') !== null)
    const item = target.querySelector('[data-testid="outbox-item"]')!
    expect(item.textContent).toContain('to a removed account')
    expect(item.textContent).toContain('No account configured')

    target.querySelector<HTMLButtonElement>('.outbox-discard')!.click()
    await until(() => badge(target) === null)
    expect(badge(target)).toBeNull()
    expect(await getQueuedMessages()).toEqual([])
    expect(sends).toHaveLength(1) // never retried by the discard
    dispose()
  })

  it('says "sending", not "unsent", while the start-up send is still running (also if it hangs)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const realFetch = globalThis.fetch as any
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: any) => {
      if (String(input).includes('/api/send')) await gate
      return realFetch(input, init)
    }))
    await addQueuedMessage(draft('slow'))
    const { target, dispose } = await mountApp()
    await until(() => (badge(target)?.textContent ?? '').includes('sending'))
    expect(badge(target)!.textContent!.trim()).toBe('1 sending…')
    release()
    await until(() => badge(target) === null)
    expect(badge(target)).toBeNull()
    expect(sends).toHaveLength(1)
    dispose()
  })

  it('sends once when an online event arrives while the start-up send is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const realFetch = globalThis.fetch as any
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: any) => {
      if (String(input).includes('/api/send')) await gate
      return realFetch(input, init)
    }))
    await addQueuedMessage(draft('once'))
    const { dispose } = await mountApp()
    await until(() => (globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes('/api/send')))
    window.dispatchEvent(new Event('online'))
    await until(() => false, 100)
    release()
    await until(() => sends.length > 0)
    await until(() => false, 150)
    expect(sends).toHaveLength(1)
    dispose()
  })

  it('keeps the keyboard shortcuts of the message list away from the open panel', async () => {
    sendAnswer = () => json({ error: 'Nope' }, 400)
    await addQueuedMessage(draft('stuck'))
    const { target, dispose } = await mountApp()
    await until(() => badge(target)?.textContent?.includes('unsent') ?? false)
    badge(target)!.click()
    await until(() => target.querySelector('[role="dialog"]') !== null)
    expect(getState().isComposing).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    flushSync()
    expect(getState().isComposing).toBe(false)
    dispose()
  })

  it('gives focus back to the badge when the panel closes', async () => {
    sendAnswer = () => json({ error: 'Nope' }, 400)
    await addQueuedMessage(draft('stuck'))
    const { target, dispose } = await mountApp()
    await until(() => badge(target)?.textContent?.includes('unsent') ?? false)
    badge(target)!.focus()
    badge(target)!.click()
    await until(() => target.querySelector('[role="dialog"]') !== null)
    target.querySelector<HTMLButtonElement>('.actions button:not(.primary)')!.click()
    await until(() => target.querySelector('[role="dialog"]') === null)
    expect(document.activeElement).toBe(badge(target))
    dispose()
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'

// Regression: the app only learned its accounts when the Settings dialog was
// opened, so after a start activeAccountId stayed null and the refresh
// controller never opened the IDLE stream: new mail appeared only on reload.

const opened: string[] = []
class FakeEventSource {
  constructor(readonly url: string) { opened.push(url) }
  addEventListener() {}
  close() {}
}

function respond(url: string): unknown {
  if (url.includes('/api/accounts')) return [{ id: 'a1', email: 'me@example.test', name: 'me' }]
  if (url.includes('/api/folders')) return { folders: [] }
  if (url.includes('/api/messages')) return { messages: [], total: 0 }
  return {}
}

afterEach(() => { vi.unstubAllGlobals(); opened.length = 0 })

describe('app start', () => {
  it('loads the accounts and opens the IDLE stream without visiting Settings', async () => {
    const calls: string[] = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      calls.push(String(input))
      return new Response(JSON.stringify(respond(String(input))), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    if (!('ResizeObserver' in globalThis)) vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const { default: App } = await import('../App.svelte')
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(App, { target })
    for (let i = 0; i < 20 && opened.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
      flushSync()
    }
    expect(calls.some((u) => u.includes('/api/accounts'))).toBe(true)
    expect(opened.length).toBe(1)
    expect(opened[0]).toContain('/api/idle')
    expect(opened[0]).toContain('account=me%40example.test')
    // Adopting the account at start is not an account switch: INBOX loads once.
    expect(calls.filter((u) => u.includes('/api/messages')).length).toBe(1)
    unmount(app)
    target.remove()
  })
})

describe('app start offline', () => {
  it('backend unreachable: no first-run screen, the list is still loaded (offline cache)', async () => {
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
    await new Promise((r) => setTimeout(r, 20))
    flushSync()
    expect(calls.some((u) => u.includes('/api/messages'))).toBe(true)
    expect(target.querySelector('[data-testid="first-run"]')).toBeNull()
    unmount(app)
    target.remove()
  })
})

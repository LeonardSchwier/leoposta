// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import Compose from '../components/Compose.svelte'
import { clearCompose, setComposeTo, setComposeCc, setComposeBcc } from '../store'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stubFetch(): void {
  const handler = (input: any) => {
    const url = String(input)
    if (url.includes('/contacts/calendars')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ addressBooks: [{ uri: 'b1', name: 'B' }] }) })
    }
    if (url.includes('/contacts?book=b1')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ contacts: [{ uid: 'c1', name: 'Jane Doe', email: 'jane@example.com', org: 'Acme' }] }) })
    }
    if (url.includes('/api/account')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ connected: true, signature: { enabled: false, text: '' } }) })
    }
    if (url.includes('/api/send')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }), _sendCalled: true })
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  }
  globalThis.fetch = ((input: any) => handler(input)) as any
}

beforeAll(() => { stubFetch() })

function makeTarget(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

let target: HTMLDivElement
const targets: HTMLDivElement[] = []

beforeEach(() => {
  clearCompose()
  target = makeTarget()
  targets.push(target)
})

afterEach(() => {
  targets.forEach((t) => t.remove())
  targets.length = 0
  vi.restoreAllMocks()
})

function raInputInRow(el: Element | null): HTMLInputElement | null {
  const row = el?.closest('.field-row') || el
  return row ? (row.querySelector('input.ra-input') as HTMLInputElement) : null
}

describe('Compose — shared RecipientAutocomplete in To field', () => {
  it('To field contains a .ra-input input (RecipientAutocomplete mounted)', async () => {
    const c = mount(Compose as any, { target, props: { onClose: () => {} } } as any)
    await sleep(200)
    const labels = Array.from(target.querySelectorAll('label'))
    const toLabel = labels.find((l) => l.textContent?.trim() === 'To')
    expect(toLabel, 'To label should exist').toBeDefined()
    const raInput = raInputInRow(toLabel ?? null)
    expect(raInput, 'To field should contain a .ra-input (RecipientAutocomplete)').not.toBeNull()
    unmount(c)
  })

  it('send includes alice@example.com in the API to-array when seeded via store', async () => {
    setComposeTo(['alice@example.com'])
    const origFetch = globalThis.fetch
    let capturedBody: string | null = null
    globalThis.fetch = ((input: any, init?: any) => {
      const url = String(input)
      if (url.includes('/api/send')) {
        capturedBody = init?.body || null
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
      }
      return origFetch(input)
    }) as any

    const c = mount(Compose as any, { target, props: { onClose: vi.fn() } } as any)
    await sleep(250)
    const sendBtn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Send')
    expect(sendBtn, 'Send button should exist').not.toBeNull()
    sendBtn!.click()
    await sleep(200)
    globalThis.fetch = origFetch

    expect(capturedBody, 'API should be called with a body').not.toBeNull()
    const parsed = JSON.parse(capturedBody!) as any
    expect(parsed.to, 'to-array should include the seeded recipient').toContain('alice@example.com')
    unmount(c)
  })

  it('send with To + Cc + Bcc parses all three fields', async () => {
    setComposeTo(['alice@example.com'])
    setComposeCc(['carol@example.com'])
    setComposeBcc(['bob@example.com'])
    const origFetch = globalThis.fetch
    let capturedBody: string | null = null
    globalThis.fetch = ((input: any, init?: any) => {
      const url = String(input)
      if (url.includes('/api/send')) {
        capturedBody = init?.body || null
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
      }
      return origFetch(input)
    }) as any

    const c = mount(Compose as any, { target, props: { onClose: vi.fn() } } as any)
    await sleep(250)
    const sendBtn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Send')
    expect(sendBtn, 'Send button should exist').not.toBeNull()
    sendBtn!.click()
    await sleep(200)
    globalThis.fetch = origFetch

    expect(capturedBody, 'API should be called with a body').not.toBeNull()
    const parsed = JSON.parse(capturedBody!) as any
    expect(parsed.to, 'to-array should include the seeded recipient').toContain('alice@example.com')
    expect(parsed.cc, 'cc-array should include the seeded CC').toContain('carol@example.com')
    expect(parsed.bcc, 'bcc-array should include the seeded BCC').toContain('bob@example.com')
    unmount(c)
  })

  it('send with no recipients alerts and does not call /api/send', async () => {
    const origFetch = globalThis.fetch
    let sendCalled = false
    globalThis.fetch = ((input: any) => {
      const url = String(input)
      if (url.includes('/api/send')) {
        sendCalled = true
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
      }
      return origFetch(input)
    }) as any

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const c = mount(Compose as any, { target, props: { onClose: () => {} } } as any)
    await sleep(250)
    const sendBtn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Send')
    sendBtn!.click()
    await sleep(200)
    globalThis.fetch = origFetch

    expect(alertSpy, 'alert should fire when no recipients').toHaveBeenCalled()
    expect(sendCalled, '/api/send should not be called').toBe(false)
    unmount(c)
  })
})

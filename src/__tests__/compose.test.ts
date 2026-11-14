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

  it('send with no recipients shows an inline error and does not call /api/send', async () => {
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

    expect(alertSpy, 'no blocking alert').not.toHaveBeenCalled()
    expect(target.querySelector('[role=alert]')?.textContent).toMatch(/at least one recipient/)
    expect(sendCalled, '/api/send should not be called').toBe(false)
    unmount(c)
  })
})

describe('Compose — sending and seeding', () => {
  function stubSend(onSend: (body: any) => Promise<any>, extra: (url: string) => any = () => undefined) {
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: any, init?: any) => {
      const url = String(input)
      if (url.includes('/api/send')) return onSend(JSON.parse(init?.body || '{}'))
      const r = extra(url)
      if (r !== undefined) return Promise.resolve({ ok: true, status: 200, json: async () => r })
      return origFetch(input)
    }) as any
    return () => { globalThis.fetch = origFetch }
  }
  const sendButton = () => Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Send')!

  it('a double click sends the message once', async () => {
    setComposeTo(['alice@example.com'])
    let calls = 0
    let release: (v: any) => void = () => {}
    const restore = stubSend(() => { calls++; return new Promise((r) => { release = r }) })
    const c = mount(Compose as any, { target, props: { onClose: vi.fn() } } as any)
    await sleep(250)
    const btn = sendButton()
    btn.click()
    btn.click()
    await sleep(50)
    expect(calls).toBe(1)
    release({ ok: true, status: 200, json: async () => ({ success: true }) })
    await sleep(50)
    restore()
    unmount(c)
  })

  it('a reply sends In-Reply-To/References of the fetched original and quotes it', async () => {
    const { setComposeOriginalMessage, setComposeReplyTo, setComposeSubject } = await import('../store')
    setComposeTo(['erika@x.test'])
    setComposeSubject('Re: Plan')
    setComposeReplyTo('7')
    setComposeOriginalMessage({ id: '7', from: 'Erika', fromAddress: 'erika@x.test', to: ['me@x.test'], subject: 'Plan', body: '', date: '2026-01-02T03:04:05Z', flags: [], folder: 'INBOX', headers: {} })
    let sent: any = null
    const restore = stubSend(async (b) => { sent = b; return { ok: true, status: 200, json: async () => ({ success: true }) } }, (url) =>
      url.includes('/api/message/7') ? { id: '7', body: 'Original text', messageId: '<m7@x.test>', references: ['<m6@x.test>'], attachments: [] } : undefined)
    const c = mount(Compose as any, { target, props: { onClose: vi.fn() } } as any)
    await sleep(300)
    const ta = target.querySelector('textarea#compose-body') as HTMLTextAreaElement
    expect(ta.dataset.seeded).toBe('true')
    expect(ta.value).toContain('> Original text')
    sendButton().click()
    await sleep(100)
    restore()
    expect(sent.inReplyTo).toBe('<m7@x.test>')
    expect(sent.references).toBe('<m6@x.test> <m7@x.test>')
    unmount(c)
  })

  it('an SMTP failure is shown in the window, which stays open and can retry', async () => {
    setComposeTo(['alice@example.com'])
    const onClose = vi.fn()
    let calls = 0
    const restore = stubSend(async () => {
      calls++
      return calls === 1
        ? { ok: false, status: 500, json: async () => ({ error: 'connect ECONNREFUSED 127.0.0.1:1' }) }
        : { ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new SyntaxError('not json') } }
    })
    const c = mount(Compose as any, { target, props: { onClose } } as any)
    await sleep(250)
    sendButton().click()
    await sleep(100)
    expect(target.querySelector('[role=alert]')?.textContent).toMatch(/Could not send: connect ECONNREFUSED/)
    expect(onClose).not.toHaveBeenCalled()
    sendButton().click()
    await sleep(100)
    expect(target.querySelector('[role=alert]')?.textContent).toMatch(/502 Bad Gateway/)
    expect(calls).toBe(2)
    restore()
    unmount(c)
  })

  it('Escape that closes the recipient suggestions does not close the window', async () => {
    const onClose = vi.fn()
    const c = mount(Compose as any, { target, props: { onClose } } as any)
    await sleep(250)
    const input = target.querySelector('#compose-to') as HTMLInputElement
    input.value = 'j'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(250)
    expect(target.querySelector('.suggestions')).not.toBeNull()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await sleep(30)
    expect(target.querySelector('.suggestions')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount(c)
  })

  it('an invalid address is refused before sending', async () => {
    setComposeTo(['alice@example.com', 'bob'])
    let calls = 0
    const restore = stubSend(async () => { calls++; return { ok: true, status: 200, json: async () => ({ success: true }) } })
    const c = mount(Compose as any, { target, props: { onClose: vi.fn() } } as any)
    await sleep(250)
    sendButton().click()
    await sleep(100)
    expect(target.querySelector('[role=alert]')?.textContent).toMatch(/Not a valid email address: bob/)
    expect(calls).toBe(0)
    restore()
    unmount(c)
  })

  it('text typed before the signature loads is kept', async () => {
    let answer: (v: any) => void = () => {}
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: any) => {
      if (String(input).includes('/api/account')) return new Promise((r) => { answer = r })
      return origFetch(input)
    }) as any
    const c = mount(Compose as any, { target, props: { onClose: vi.fn() } } as any)
    await sleep(50)
    const ta = target.querySelector('textarea#compose-body') as HTMLTextAreaElement
    ta.value = 'Typed early'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    answer({ ok: true, status: 200, json: async () => ({ connected: true, signature: { enabled: true, text: '-- Leo', position: 'standard' } }) })
    await sleep(100)
    globalThis.fetch = origFetch
    expect(ta.value).toBe('Typed early\n\n-- Leo')
    unmount(c)
  })
})

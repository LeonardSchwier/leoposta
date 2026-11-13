// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import Compose from '../components/Compose.svelte'
import { clearCompose, setComposeTo, setComposeSubject, setComposeBody } from '../store'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Call = { url: string, init: any }
let calls: Call[] = []
let draftResponse: { ok: boolean, status: number, body: any }

beforeEach(() => {
  clearCompose()
  calls = []
  draftResponse = { ok: true, status: 200, body: { success: true, folder: 'INBOX.Entwürfe', uid: 42 } }
  globalThis.fetch = ((input: any, init?: any) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('/api/drafts')) {
      return Promise.resolve({ ok: draftResponse.ok, status: draftResponse.status, statusText: 'x', json: async () => draftResponse.body })
    }
    if (url.includes('/api/account')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ connected: true, signature: { enabled: false, text: '' } }) })
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  }) as any
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function saveButton(target: HTMLElement): HTMLButtonElement {
  const btn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save Draft')
  expect(btn, 'Save Draft button should exist').toBeDefined()
  return btn as HTMLButtonElement
}

function mountCompose(props: Record<string, unknown>) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const c = mount(Compose as any, { target, props } as any)
  return { c, target }
}

describe('Compose — Save Draft', () => {
  it('POSTs the draft to /api/drafts instead of only closing the window', async () => {
    setComposeTo(['alice@example.com'])
    setComposeSubject('Plan')
    setComposeBody('half-written')
    const onClose = vi.fn()
    const onDraftSaved = vi.fn()
    const { c, target } = mountCompose({ onClose, onDraftSaved })
    await sleep(100)
    saveButton(target).click()
    await sleep(100)

    const draft = calls.find((x) => x.url.includes('/api/drafts'))
    expect(draft, 'Save Draft must call the drafts API').toBeDefined()
    expect(draft!.init.method).toBe('POST')
    const body = JSON.parse(draft!.init.body)
    expect(body.to).toEqual(['alice@example.com'])
    expect(body.subject).toBe('Plan')
    expect(body.body).toBe('half-written')
    unmount(c)
  })

  it('sends exactly one Content-Type so express.json() parses the body', async () => {
    const { c, target } = mountCompose({ onClose: vi.fn(), onDraftSaved: vi.fn() })
    await sleep(100)
    saveButton(target).click()
    await sleep(100)
    const draft = calls.find((x) => x.url.includes('/api/drafts'))!
    const ct = new Headers(draft.init.headers).get('content-type')
    expect(ct).toBe('application/json')
    unmount(c)
  })

  it('on success reports the Drafts folder it was saved to and closes', async () => {
    const onClose = vi.fn()
    const onDraftSaved = vi.fn()
    const { c, target } = mountCompose({ onClose, onDraftSaved })
    await sleep(100)
    saveButton(target).click()
    await sleep(100)
    expect(onDraftSaved).toHaveBeenCalledWith('INBOX.Entwürfe')
    expect(onClose).toHaveBeenCalled()
    unmount(c)
  })

  it('on failure keeps the window open (nothing is lost) and shows the error', async () => {
    draftResponse = { ok: false, status: 500, body: { error: 'Over quota' } }
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const onClose = vi.fn()
    const onDraftSaved = vi.fn()
    const { c, target } = mountCompose({ onClose, onDraftSaved })
    await sleep(100)
    saveButton(target).click()
    await sleep(100)
    expect(onClose).not.toHaveBeenCalled()
    expect(onDraftSaved).not.toHaveBeenCalled()
    expect(alertSpy).toHaveBeenCalled()
    expect(String(alertSpy.mock.calls[0][0])).toMatch(/Over quota/)
    unmount(c)
  })
})

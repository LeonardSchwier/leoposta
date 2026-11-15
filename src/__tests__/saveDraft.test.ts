// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import Compose from '../components/Compose.svelte'
import { clearCompose, setComposeTo, setComposeCc, setComposeBcc, setComposeSubject, setComposeBody, setComposeDraft } from '../store'

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
    if (url.includes('/api/send')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, messageId: '<x@y>' }) })
    }
    if (url.includes('/api/drafts/') && init?.method === 'DELETE') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, discarded: true }) })
    }
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

describe('Compose — a reopened draft', () => {
  const attachment = { filename: 'notes.txt', content: btoa('notes'), contentType: 'text/plain' }
  function reopen() {
    setComposeTo(['alice@example.com'])
    setComposeCc(['carol@example.com'])
    setComposeBcc(['bob@example.com'])
    setComposeSubject('Quarterly')
    setComposeBody('first version')
    setComposeDraft({ uid: '17', attachments: [attachment] })
  }
  const button = (target: HTMLElement, text: string) =>
    Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement

  it('shows its Cc/Bcc and attachment and keeps its body (the signature is not seeded again)', async () => {
    reopen()
    const { c, target } = mountCompose({ onClose: vi.fn() })
    await sleep(100)
    expect((target.querySelector('#compose-cc') as HTMLInputElement).value).toBe('carol@example.com')
    expect((target.querySelector('#compose-bcc') as HTMLInputElement).value).toBe('bob@example.com')
    expect((target.querySelector('#compose-body') as HTMLTextAreaElement).value).toBe('first version')
    expect(target.querySelector('.attachment-chip')?.textContent).toContain('notes.txt')
    expect(calls.some((x) => x.url.includes('/api/account'))).toBe(false)
    unmount(c)
  })

  it('Save Draft sends replaceUid so the server replaces the old copy, with the attachment', async () => {
    reopen()
    const { c, target } = mountCompose({ onClose: vi.fn(), onDraftSaved: vi.fn() })
    await sleep(100)
    saveButton(target).click()
    await sleep(100)
    const body = JSON.parse(calls.find((x) => x.url.includes('/api/drafts'))!.init.body)
    expect(body.replaceUid).toBe('17')
    expect(body.bcc).toEqual(['bob@example.com'])
    expect(body.attachments).toEqual([attachment])
    unmount(c)
  })

  it('a new message never sends replaceUid', async () => {
    const { c, target } = mountCompose({ onClose: vi.fn(), onDraftSaved: vi.fn() })
    await sleep(100)
    saveButton(target).click()
    await sleep(100)
    expect(JSON.parse(calls.find((x) => x.url.includes('/api/drafts'))!.init.body).replaceUid).toBeUndefined()
    unmount(c)
  })

  it('sending it removes the draft from Drafts, then reports onSent and closes', async () => {
    reopen()
    const onClose = vi.fn()
    const onSent = vi.fn()
    const { c, target } = mountCompose({ onClose, onSent })
    await sleep(100)
    button(target, 'Send').click()
    await sleep(150)
    const del = calls.find((x) => x.url.includes('/api/drafts/17'))
    expect(del?.init.method).toBe('DELETE')
    expect(calls.findIndex((x) => x.url.includes('/api/send'))).toBeLessThan(calls.indexOf(del!))
    expect(onSent).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    unmount(c)
  })
})

describe('Compose — closing with unsaved changes', () => {
  const button = (target: HTMLElement, text: string) =>
    Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement
  const closeX = (target: HTMLElement) => target.querySelector('button.close-btn') as HTMLButtonElement

  it('an untouched window closes at once', async () => {
    const onClose = vi.fn()
    const { c, target } = mountCompose({ onClose })
    await sleep(100)
    closeX(target).click()
    expect(onClose).toHaveBeenCalled()
    unmount(c)
  })

  it('typed text asks first: Keep Editing keeps it, Discard closes without saving', async () => {
    const onClose = vi.fn()
    const { c, target } = mountCompose({ onClose })
    await sleep(100)
    const subject = target.querySelector('#compose-subject') as HTMLInputElement
    subject.value = 'Unsaved idea'
    subject.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(10)
    closeX(target).click()
    await sleep(10)
    expect(onClose).not.toHaveBeenCalled()
    expect(target.querySelector('[role=alertdialog]')).not.toBeNull()
    button(target, 'Keep Editing').click()
    await sleep(10)
    expect(target.querySelector('[role=alertdialog]')).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await sleep(10)
    button(target, 'Discard').click()
    expect(onClose).toHaveBeenCalled()
    expect(calls.some((x) => x.url.includes('/api/drafts'))).toBe(false)
    unmount(c)
  })

  it('Save Draft from the prompt stores the draft and closes', async () => {
    const onClose = vi.fn()
    const { c, target } = mountCompose({ onClose, onDraftSaved: vi.fn() })
    await sleep(100)
    const body = target.querySelector('#compose-body') as HTMLTextAreaElement
    body.value = 'keep me'
    body.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(10)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await sleep(10)
    Array.from(target.querySelectorAll('[role=alertdialog] button')).find((b) => b.textContent?.trim() === 'Save Draft')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(100)
    expect(JSON.parse(calls.find((x) => x.url.includes('/api/drafts'))!.init.body).body).toBe('keep me')
    expect(onClose).toHaveBeenCalled()
    unmount(c)
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import Outbox from '../components/Outbox.svelte'
import { addQueuedMessage, getQueuedMessages, flushQueue } from '../lib/offlineQueue'
import { setActiveAccountEmail } from '../api'

// The panel behind the "unsent" badge: what the user sees of mail that is stuck
// in the offline outbox, and the way out of it.

let target: HTMLDivElement
let mounted: ReturnType<typeof mount> | null = null

beforeEach(() => {
  ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
  setActiveAccountEmail(null)
  target = document.createElement('div')
  document.body.appendChild(target)
})
afterEach(() => {
  if (mounted) unmount(mounted)
  mounted = null
  target.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const draft = (extra: Record<string, unknown> = {}) => ({
  to: ['anna@example.test'], subject: 'Lunch?', body: 'hi', createdAt: '2026-11-18T09:30:00.000Z', ...extra
})

async function settle() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0))
    flushSync()
  }
}

function open(props: { online?: boolean; onClose?: () => void } = {}) {
  mounted = mount(Outbox, { target, props: { online: true, onClose: () => {}, ...props } })
  flushSync()
}

const items = () => [...target.querySelectorAll<HTMLElement>('[data-testid="outbox-item"]')]
const button = (name: RegExp) =>
  [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => name.test(b.getAttribute('aria-label') || b.textContent || ''))

describe('Outbox panel', () => {
  it('is a labelled dialog that lists each unsent message with its recipients, account and error', async () => {
    await addQueuedMessage(draft({
      to: ['anna@example.test', 'ben@example.test'], account: 'erika@example.test',
      lastError: 'No account configured', attachments: [{ filename: 'a.txt', content: 'eA==', contentType: 'text/plain' }]
    }))
    open()
    await settle()
    const dialog = target.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label') || dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(items()).toHaveLength(1)
    const text = items()[0]!.textContent!
    expect(text).toContain('Lunch?')
    expect(text).toContain('anna@example.test')
    expect(text).toContain('ben@example.test')
    expect(text).toContain('erika@example.test')
    expect(text).toContain('No account configured')
    expect(text).toMatch(/1 attachment\b/)
  })

  it('names a message that has no subject, and shows a message that was never tried without an error line', async () => {
    await addQueuedMessage(draft({ subject: '' }))
    open()
    await settle()
    expect(items()[0]!.textContent).toContain('(no subject)')
    expect(items()[0]!.querySelector('.outbox-error')).toBeNull()
  })

  it('shows text as text: a subject or error that looks like markup is not interpreted', async () => {
    await addQueuedMessage(draft({ subject: '<img src=x onerror=alert(1)>', lastError: '<b>boom</b>' }))
    open()
    await settle()
    expect(target.querySelector('img')).toBeNull()
    expect(target.querySelector('.outbox-error b')).toBeNull()
    expect(items()[0]!.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('says there is nothing to send when the outbox is empty', async () => {
    open()
    await settle()
    expect(items()).toHaveLength(0)
    expect(target.textContent).toMatch(/no unsent messages/i)
  })

  it('discards a message after asking, and only that one', async () => {
    await addQueuedMessage(draft({ subject: 'keep me' }))
    await addQueuedMessage(draft({ subject: 'drop me' }))
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    open()
    await settle()
    expect(items()).toHaveLength(2)
    button(/Discard "drop me"/)!.click()
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(String((confirm.mock.calls as any)[0][0])).toContain('drop me')
    expect(items().map((i) => i.textContent)).toEqual([expect.stringContaining('keep me')])
    expect((await getQueuedMessages()).map((m) => m.subject)).toEqual(['keep me'])
  })

  it('keeps the message when the user declines the confirmation', async () => {
    await addQueuedMessage(draft())
    vi.stubGlobal('confirm', vi.fn(() => false))
    open()
    await settle()
    button(/Discard/)!.click()
    await settle()
    expect(items()).toHaveLength(1)
    expect(await getQueuedMessages()).toHaveLength(1)
  })

  it('shows why a discard failed instead of pretending it worked', async () => {
    await addQueuedMessage(draft())
    vi.stubGlobal('confirm', vi.fn(() => true))
    const offline = await import('../lib/offlineQueue')
    open()
    await settle()
    const realOpen = (globalThis as any).indexedDB.open.bind((globalThis as any).indexedDB)
    ;(globalThis as any).indexedDB.open = () => { throw new Error('storage is blocked') }
    try {
      button(/Discard/)!.click()
      await settle()
    } finally {
      ;(globalThis as any).indexedDB.open = realOpen
    }
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('storage is blocked')
    expect(await offline.getQueuedMessages()).toHaveLength(1)
  })

  it('Retry now sends the outbox again and clears what went out', async () => {
    await addQueuedMessage(draft({ lastError: 'Temporary failure' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })))
    open()
    await settle()
    button(/Retry now/)!.click()
    await settle()
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1)
    expect(items()).toHaveLength(0)
    expect(await getQueuedMessages()).toEqual([])
  })

  // Removing the focused row drops focus to the page; Escape and the Tab trap
  // listen on the panel, so they stopped working until the user clicked into it.
  it('keeps focus inside the panel after the focused message is gone, so Escape and Tab still work', async () => {
    await addQueuedMessage(draft())
    vi.stubGlobal('confirm', vi.fn(() => true))
    const onClose = vi.fn()
    open({ onClose })
    await settle()
    const discard = button(/Discard/)!
    discard.focus()
    discard.click()
    await settle()
    expect(items()).toHaveLength(0)
    const dialog = target.querySelector('[role="dialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps focus inside the panel after Retry now sent everything', async () => {
    await addQueuedMessage(draft())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })))
    open()
    await settle()
    button(/Retry now/)!.focus()
    button(/Retry now/)!.click()
    await settle()
    expect(items()).toHaveLength(0)
    expect(target.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  it('does not take focus from another dialog opened over it', async () => {
    await addQueuedMessage(draft())
    open()
    await settle()
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    window.dispatchEvent(new Event('leoposta:queue-changed'))
    await settle()
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('Retry now shows the new error of a message that fails again', async () => {
    await addQueuedMessage(draft())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Mailbox full' }), { status: 552 })))
    open()
    await settle()
    button(/Retry now/)!.click()
    await settle()
    expect(items()).toHaveLength(1)
    expect(items()[0]!.textContent).toContain('Mailbox full')
  })

  it('cannot retry while offline, but can still discard', async () => {
    await addQueuedMessage(draft())
    vi.stubGlobal('confirm', vi.fn(() => true))
    open({ online: false })
    await settle()
    expect(button(/Retry now/)!.disabled).toBe(true)
    button(/Discard/)!.click()
    await settle()
    expect(items()).toHaveLength(0)
  })

  it('does not start a second retry while one is running', async () => {
    await addQueuedMessage(draft())
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return new Response(JSON.stringify({ success: true }), { status: 200 }) }))
    open()
    await settle()
    const retry = button(/Retry now/)!
    retry.click()
    flushSync()
    expect(retry.disabled).toBe(true)
    retry.click()
    release()
    await settle()
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1)
  })

  it('follows the outbox when it changes while open (a flush elsewhere sends the message)', async () => {
    await addQueuedMessage(draft())
    open()
    await settle()
    expect(items()).toHaveLength(1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })))
    await flushQueue()
    await settle()
    expect(items()).toHaveLength(0)
  })

  it('closes with the Close button and with Escape, and Escape does not reach the app shortcuts', async () => {
    const onClose = vi.fn()
    const appKeys = vi.fn()
    window.addEventListener('keydown', appKeys)
    try {
      open({ onClose })
      await settle()
      button(/^Close$/)!.click()
      expect(onClose).toHaveBeenCalledTimes(1)
      target.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
      expect(onClose).toHaveBeenCalledTimes(2)
      expect(appKeys).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', appKeys)
    }
  })

  it('closes when the backdrop is clicked, not when the panel is', async () => {
    const onClose = vi.fn()
    open({ onClose })
    await settle()
    target.querySelector<HTMLElement>('[role="dialog"]')!.click()
    expect(onClose).not.toHaveBeenCalled()
    target.querySelector<HTMLElement>('.modal-back')!.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the panel', async () => {
    open()
    await settle()
    expect(target.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  it('keeps Tab inside the panel', async () => {
    await addQueuedMessage(draft())
    open()
    await settle()
    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')!
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')]
    focusable[focusable.length - 1]!.focus()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    dialog.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(focusable[0])
  })
})

// @vitest-environment jsdom
// Regression tests for runtime bugs surfaced by svelte-check.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import Contacts from '../components/Contacts.svelte'
import Sidebar from '../components/Sidebar.svelte'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let target: HTMLDivElement
beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
})
afterEach(() => {
  target.remove()
})

describe('Contacts Retry button', () => {
  it('reloads without passing the click event as a search query, and clears the error', async () => {
    const contactUrls: string[] = []
    let failContacts = true
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      let body: any = null
      let ok = true
      if (url.includes('/contacts/calendars')) {
        body = { addressBooks: [{ uri: 'b1', name: 'B' }] }
      } else if (url.includes('/contacts?book=')) {
        contactUrls.push(url)
        if (failContacts) { ok = false; body = { error: 'boom' } }
        else body = { contacts: [{ uid: 'c1', name: 'Jane Doe', email: 'jane@example.com' }] }
      } else {
        ok = false
      }
      return { ok, status: ok ? 200 : 500, json: async () => body } as any
    }) as any

    const c = mount(Contacts as any, { target, props: { showToast: () => {} } } as any)
    await sleep(100)
    const retry = target.querySelector('.c-err button') as HTMLButtonElement
    expect(retry, 'error banner with Retry should be shown').not.toBeNull()

    failContacts = false
    retry.click()
    await sleep(100)

    const last = contactUrls[contactUrls.length - 1]
    expect(last).not.toContain('q=')
    expect(last).not.toContain('MouseEvent')
    expect(target.querySelector('.c-err')).toBeNull()
    expect(target.textContent).toContain('Jane Doe')
    unmount(c)
  })
})

describe('Sidebar folder expansion', () => {
  it('re-renders children when a parent folder is expanded', () => {
    const folders = [
      { id: 'Projects', name: 'Projects' },
      { id: 'Projects/Alpha', name: 'Alpha', parentId: 'Projects' },
    ]
    const c = mount(Sidebar as any, {
      target,
      props: {
        onFolderSelect: () => {},
        onCompose: () => {},
        onSettings: () => {},
        onNewFolder: () => {},
        folders,
        activeView: 'INBOX',
      },
    } as any)
    flushSync()
    expect(target.textContent).not.toContain('Alpha')
    // The chevron expands; clicking the folder name opens the folder instead.
    const chevron = target.querySelector('[aria-label="Expand Projects"]') as HTMLElement
    expect(chevron).toBeTruthy()
    chevron.click()
    flushSync()
    expect(target.textContent).toContain('Alpha')
    unmount(c)
  })
})

// @vitest-environment jsdom
// Keyboard reachability of controls that used to be mouse-only (the
// svelte-check a11y warnings pointed at them).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import Sidebar from '../components/Sidebar.svelte'
import MessageList from '../components/MessageList.svelte'
import { setMessages, selectMessage, getState } from '../store'

// jsdom has no ResizeObserver (MessageList measures its viewport with one).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

// ...and no layout: give the virtual list a viewport so it renders rows.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 })

let target: HTMLDivElement
beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
})
afterEach(() => target.remove())

const noop = () => {}

describe('Sidebar "New folder"', () => {
  it('is a real button, present even before any custom folder exists', () => {
    let calls = 0
    const c = mount(Sidebar, {
      target,
      props: {
        onFolderSelect: noop, onCompose: noop, onSettings: noop,
        onNewFolder: () => { calls++ }, onNewSubFolder: noop, onRenameFolder: noop, onDeleteFolder: noop,
        folders: [{ id: 'INBOX', name: 'INBOX', parentId: null, specialUse: '\\Inbox' }]
      }
    })
    flushSync()
    const btn = target.querySelector('button[aria-label="New folder"]') as HTMLButtonElement | null
    expect(btn, 'New folder button').not.toBeNull()
    btn!.click()
    expect(calls).toBe(1)
    unmount(c)
  })
})

describe('MessageList rows', () => {
  const msgs = ['a', 'b', 'c'].map((id) => ({
    id, from: id, to: [], subject: `Subject ${id}`, body: '', date: new Date().toISOString(),
    flags: ['\\Seen'], folder: 'INBOX', headers: {}
  }))

  it('are reachable with Tab (roving tabindex) and open with Enter / Space', () => {
    setMessages(msgs)
    selectMessage(null)
    const opened: string[] = []
    const c = mount(MessageList, { target, props: {
      onSelectMessage: (id: string) => { opened.push(id) },
      onCompose: () => {}, onDelete: () => {}, onArchive: () => {}, onStar: () => {}, onSearch: () => {}
    } })
    flushSync()
    const rows = () => [...target.querySelectorAll<HTMLElement>('.message-row')]
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1])

    rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    flushSync()
    expect(opened).toEqual(['b'])
    expect(getState().selectedMessageId).toBe('b')
    // The selected row is now the one Tab lands on.
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1])

    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    rows()[2].dispatchEvent(space)
    flushSync()
    expect(opened).toEqual(['b', 'c'])
    expect(space.defaultPrevented, 'Space must not also scroll the list').toBe(true)
    unmount(c)
    selectMessage(null)
    setMessages([])
  })
})

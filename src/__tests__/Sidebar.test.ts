// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import Sidebar from '../components/Sidebar.svelte'

const folders = [
  { id: 'INBOX', name: 'INBOX', parentId: null, specialUse: '\\Inbox' },
  { id: 'Projects', name: 'Projects', parentId: null },
  { id: 'Projects/2026', name: '2026', parentId: 'Projects' },
  { id: 'Projects/2026/Q1', name: 'Q1', parentId: 'Projects/2026' },
  { id: 'INBOX.Clients', name: 'Clients', parentId: 'INBOX', delimiter: '.' },
  { id: 'INBOX.Clients.Acme', name: 'Acme', parentId: 'INBOX.Clients', delimiter: '.' }
]

let target: HTMLDivElement
let app: any
let selected: string[]

function names(): string[] {
  return [...target.querySelectorAll('.folder-tree .folder-name')].map((e) => e.textContent!.trim())
}
function toggleFor(label: string): HTMLButtonElement {
  const t = target.querySelector(`button.folder-toggle[aria-label$=" ${label}"]`)
  if (!t) throw new Error('no toggle for ' + label)
  return t as HTMLButtonElement
}

const noop = () => {}
const handlers = {
  onCompose: noop, onSettings: noop, onNewFolder: noop,
  onNewSubFolder: noop, onRenameFolder: noop, onDeleteFolder: noop
}

beforeEach(() => {
  localStorage.clear()
  selected = []
  target = document.createElement('div')
  document.body.appendChild(target)
  app = mount(Sidebar, {
    target,
    props: { ...handlers, folders, onFolderSelect: (id: string) => selected.push(id) }
  })
  flushSync()
})
afterEach(() => {
  unmount(app)
  target.remove()
})

describe('Sidebar folder tree', () => {
  it('expands and collapses a parent via its toggle without navigating', () => {
    expect(names()).toEqual(['Projects', 'Clients'])
    const t = toggleFor('Projects')
    expect(t.getAttribute('aria-expanded')).toBe('false')
    t.click(); flushSync()
    expect(names()).toEqual(['Projects', '2026', 'Clients'])
    expect(toggleFor('Projects').getAttribute('aria-expanded')).toBe('true')
    expect(selected).toEqual([])

    toggleFor('2026').click(); flushSync()
    expect(names()).toEqual(['Projects', '2026', 'Q1', 'Clients'])

    toggleFor('Projects').click(); flushSync()
    expect(names()).toEqual(['Projects', 'Clients'])
    expect(selected).toEqual([])
  })

  it('shows "." delimiter subfolders of INBOX and expands them', () => {
    toggleFor('Clients').click(); flushSync()
    expect(names()).toContain('Acme')
  })

  it('clicking the folder name opens the folder', () => {
    const row = [...target.querySelectorAll('.folder-tree .folder-open')]
      .find((e) => e.textContent!.includes('Projects')) as HTMLElement
    row.click(); flushSync()
    expect(selected).toEqual(['Projects'])
  })

  it('a \\Noselect parent only expands/collapses and never opens (no SELECT)', () => {
    unmount(app)
    target.innerHTML = ''
    app = mount(Sidebar, {
      target,
      props: {
        ...handlers,
        folders: [
          { id: 'INBOX.Shared', name: 'Shared', parentId: 'INBOX', delimiter: '.', noselect: true },
          { id: 'INBOX.Shared.Team', name: 'Team', parentId: 'INBOX.Shared', delimiter: '.' }
        ],
        onFolderSelect: (id: string) => selected.push(id)
      }
    })
    flushSync()
    const open = () => [...target.querySelectorAll('.folder-tree .folder-open')]
      .find((e) => e.textContent!.includes('Shared')) as HTMLElement
    open().click(); flushSync()
    expect(names()).toEqual(['Shared', 'Team'])
    open().click(); flushSync()
    expect(names()).toEqual(['Shared'])
    expect(selected).toEqual([])
  })

  it('offers "New Folder" even when there are no custom folders yet', () => {
    unmount(app)
    target.innerHTML = ''
    let created = 0
    app = mount(Sidebar, {
      target,
      props: { ...handlers, onNewFolder: () => { created++ }, folders: [folders[0]], onFolderSelect: () => {} }
    })
    flushSync()
    const add = target.querySelector('button[aria-label="New folder"]') as HTMLButtonElement
    expect(add).toBeTruthy()
    add.click(); flushSync()
    expect(created).toBe(1)
    const label = [...target.querySelectorAll('.section-label')].find((e) => e.textContent!.includes('Folders'))!
    label.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    flushSync()
    const item = [...target.querySelectorAll('.context-menu-item')].find((e) => e.textContent!.includes('New Folder')) as HTMLElement
    expect(item).toBeTruthy()
    item.click(); flushSync()
    expect(created).toBe(2)
  })

  it('a renamed folder keeps its children expanded under the new path', async () => {
    unmount(app)
    target.innerHTML = ''
    const before = [
      { id: 'Old', name: 'Old', parentId: null, delimiter: '/' },
      { id: 'Old/Child', name: 'Child', parentId: 'Old', delimiter: '/' }
    ]
    const after = [
      { id: 'New', name: 'New', parentId: null, delimiter: '/' },
      { id: 'New/Child', name: 'Child', parentId: 'New', delimiter: '/' }
    ]
    app = mount(Sidebar, { target, props: { ...handlers, folders: before, onFolderSelect: () => {}, onRenameFolder: async () => 'New' } })
    flushSync()
    toggleFor('Old').click(); flushSync()
    expect(names()).toEqual(['Old', 'Child'])
    const row = target.querySelector('.folder-tree .folder-row') as HTMLElement
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    flushSync()
    ;([...target.querySelectorAll('.context-menu-item')].find((e) => e.textContent!.includes('Rename')) as HTMLElement).click()
    await new Promise((r) => setTimeout(r, 0))
    unmount(app)
    target.innerHTML = ''
    app = mount(Sidebar, { target, props: { ...handlers, folders: after, onFolderSelect: () => {} } })
    flushSync()
    expect(names()).toEqual(['New', 'Child'])
  })

  it('shows each folder\'s own unread count from the folder list', () => {
    unmount(app)
    target.innerHTML = ''
    app = mount(Sidebar, {
      target,
      props: {
        ...handlers, onFolderSelect: () => {},
        folders: [
          { id: 'INBOX', name: 'INBOX', unseen: 3 },
          { id: 'Sent', name: 'Sent', specialUse: '\\Sent', unseen: 0 },
          { id: 'Trash', name: 'Trash', specialUse: '\\Trash', unseen: 1 },
          { id: 'Work', name: 'Work', unseen: 7 }
        ]
      }
    })
    flushSync()
    const badge = (label: string) =>
      [...target.querySelectorAll('.folder-item, .folder-open')]
        .find((e) => e.querySelector('.folder-name')!.textContent!.trim() === label)!
        .querySelector('.badge')?.textContent?.trim() ?? null
    expect(badge('Inbox')).toBe('3')
    expect(badge('Sent')).toBe(null)
    expect(badge('Trash')).toBe('1')
    expect(badge('Work')).toBe('7')
  })

  it('persists expansion state to localStorage', () => {
    toggleFor('Projects').click(); flushSync()
    unmount(app)
    target.innerHTML = ''
    app = mount(Sidebar, { target, props: { ...handlers, folders, onFolderSelect: () => {} } })
    flushSync()
    expect(names()).toContain('2026')
  })
})

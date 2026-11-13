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

beforeEach(() => {
  localStorage.clear()
  selected = []
  target = document.createElement('div')
  document.body.appendChild(target)
  app = mount(Sidebar, {
    target,
    props: { folders, onFolderSelect: (id: string) => selected.push(id) }
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

  it('persists expansion state to localStorage', () => {
    toggleFor('Projects').click(); flushSync()
    unmount(app)
    target.innerHTML = ''
    app = mount(Sidebar, { target, props: { folders, onFolderSelect: () => {} } })
    flushSync()
    expect(names()).toContain('2026')
  })
})

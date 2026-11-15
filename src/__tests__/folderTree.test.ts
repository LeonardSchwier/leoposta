import { describe, it, expect } from 'vitest'
import {
  buildFolderTree,
  toggleExpanded,
  loadExpanded,
  saveExpanded,
  EXPANDED_STORAGE_KEY,
  isSameOrBelow,
  movedPath,
  renameExpanded
} from '../lib/folderTree'

const f = (id: string, name: string, parentId: string | null = null, extra: any = {}) =>
  ({ id, name, parentId, ...extra })

describe('buildFolderTree', () => {
  it('nests children under their parent using parentId ("/" delimiter)', () => {
    const tree = buildFolderTree([
      f('Projects', 'Projects'),
      f('Projects/2026', '2026', 'Projects'),
      f('Projects/2026/Q1', 'Q1', 'Projects/2026'),
      f('Misc', 'Misc')
    ])
    expect(tree.map((n) => n.id)).toEqual(['Projects', 'Misc'])
    expect(tree[0].children.map((n) => n.id)).toEqual(['Projects/2026'])
    expect(tree[0].children[0].children.map((n) => n.id)).toEqual(['Projects/2026/Q1'])
    expect(tree[0].children[0].children[0].depth).toBe(2)
  })

  it('handles "." delimiter and derives the parent when parentId is missing', () => {
    const tree = buildFolderTree([
      { id: 'INBOX.Projects', name: 'Projects', delimiter: '.' },
      { id: 'INBOX.Projects.2026', name: '2026', delimiter: '.' },
      { id: 'INBOX.Projects.2026.Q1', name: 'Q1', delimiter: '.' }
    ] as any)
    // INBOX itself is a special folder rendered elsewhere, so its children
    // must surface as roots instead of disappearing.
    expect(tree.map((n) => n.id)).toEqual(['INBOX.Projects'])
    expect(tree[0].children[0].id).toBe('INBOX.Projects.2026')
    expect(tree[0].children[0].children[0].id).toBe('INBOX.Projects.2026.Q1')
  })

  it('promotes folders whose parent is not in the list to roots', () => {
    const tree = buildFolderTree([
      f('INBOX.Work', 'Work', 'INBOX', { delimiter: '.' }),
      f('INBOX.Work.Old', 'Old', 'INBOX.Work', { delimiter: '.' })
    ])
    expect(tree.map((n) => n.id)).toEqual(['INBOX.Work'])
    expect(tree[0].children.map((n) => n.id)).toEqual(['INBOX.Work.Old'])
  })

  it('supports arbitrary depth', () => {
    const tree = buildFolderTree([
      f('a', 'a'), f('a/b', 'b', 'a'), f('a/b/c', 'c', 'a/b'), f('a/b/c/d', 'd', 'a/b/c')
    ])
    expect(tree[0].children[0].children[0].children[0].id).toBe('a/b/c/d')
  })
})

describe('toggleExpanded', () => {
  it('returns a new Set with the id flipped (immutable for reactivity)', () => {
    const a = new Set<string>()
    const b = toggleExpanded(a, 'x')
    expect(b).not.toBe(a)
    expect(b.has('x')).toBe(true)
    expect(a.has('x')).toBe(false)
    const c = toggleExpanded(b, 'x')
    expect(c.has('x')).toBe(false)
  })
})

describe('expanded persistence', () => {
  it('round-trips through storage and tolerates garbage', () => {
    const mem = new Map<string, string>()
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v)
    }
    saveExpanded(new Set(['a', 'b']), storage)
    expect([...loadExpanded(storage)].sort()).toEqual(['a', 'b'])
    mem.set(EXPANDED_STORAGE_KEY, '{not json')
    expect(loadExpanded(storage).size).toBe(0)
    expect(loadExpanded(null).size).toBe(0)
  })
})

describe('rename/delete path helpers', () => {
  it('isSameOrBelow respects the delimiter and does not match name prefixes', () => {
    expect(isSameOrBelow('Tree', 'Tree', '/')).toBe(true)
    expect(isSameOrBelow('Tree/A/B', 'Tree', '/')).toBe(true)
    expect(isSameOrBelow('Treehouse', 'Tree', '/')).toBe(false)
    expect(isSameOrBelow('INBOX.Tree.A', 'INBOX.Tree', '.')).toBe(true)
    expect(isSameOrBelow('INBOX.Treehouse', 'INBOX.Tree', '.')).toBe(false)
  })
  it('movedPath and renameExpanded carry children along', () => {
    expect(movedPath('INBOX.Old.Child', 'INBOX.Old', 'INBOX.New', '.')).toBe('INBOX.New.Child')
    expect(movedPath('INBOX.Older', 'INBOX.Old', 'INBOX.New', '.')).toBe('INBOX.Older')
    expect([...renameExpanded(new Set(['Old', 'Old/Child', 'Other']), 'Old', 'New', '/')]).toEqual(['New', 'New/Child', 'Other'])
  })
})

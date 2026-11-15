// Pure helpers for the sidebar's custom-folder tree.
//
// The server returns a flat IMAP folder list ({ id: path, name, parentId,
// delimiter }). Servers differ in their hierarchy delimiter ("/" on most,
// "." on Courier/Dovecot-with-namespace, e.g. INBOX.Projects.2026), so the
// tree is built from parentId when present and otherwise derived from the
// path and delimiter. Folders whose parent is not part of the list (typically
// children of INBOX, which is rendered as a special mailbox) become roots so
// they never silently disappear.

export interface FolderLike {
  id: string
  name: string
  parentId?: string | null
  delimiter?: string | null
}

export interface FolderNode<F extends FolderLike = FolderLike> {
  id: string
  folder: F
  children: FolderNode<F>[]
  depth: number
}

export function parentPathOf(f: FolderLike): string | null {
  if (f.parentId) return f.parentId
  const d = f.delimiter
  if (!d) return null
  const i = f.id.lastIndexOf(d)
  return i > 0 ? f.id.slice(0, i) : null
}

export function buildFolderTree<F extends FolderLike>(folders: F[]): FolderNode<F>[] {
  const nodes = new Map<string, FolderNode<F>>()
  for (const f of folders) nodes.set(f.id, { id: f.id, folder: f, children: [], depth: 0 })

  const roots: FolderNode<F>[] = []
  for (const f of folders) {
    const node = nodes.get(f.id)!
    const parent = parentPathOf(f)
    const parentNode = parent != null && parent !== f.id ? nodes.get(parent) : undefined
    if (parentNode) parentNode.children.push(node)
    else roots.push(node)
  }

  const setDepth = (list: FolderNode<F>[], depth: number, seen: Set<string>) => {
    for (const n of list) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      n.depth = depth
      setDepth(n.children, depth + 1, seen)
    }
  }
  setDepth(roots, 0, new Set())
  return roots
}

/** Returns a new Set so `$state` reassignment triggers Svelte reactivity. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** True when `path` is `ancestor` itself or lies below it. */
export function isSameOrBelow(path: string, ancestor: string, delimiter?: string | null): boolean {
  if (path === ancestor) return true
  return path.startsWith(ancestor + (delimiter || '/'))
}

/** `path` with its `from` prefix replaced by `to` (a folder rename moves its children too). */
export function movedPath(path: string, from: string, to: string, delimiter?: string | null): string {
  if (path === from) return to
  return path.startsWith(from + (delimiter || '/')) ? to + path.slice(from.length) : path
}

/** Expansion state after renaming `from` to `to`: the folder and its children stay expanded. */
export function renameExpanded(expanded: ReadonlySet<string>, from: string, to: string, delimiter?: string | null): Set<string> {
  return new Set([...expanded].map((p) => movedPath(p, from, to, delimiter)))
}

export const EXPANDED_STORAGE_KEY = 'leoposta.sidebar.expandedFolders'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function loadExpanded(storage: StorageLike | null = defaultStorage()): Set<string> {
  if (!storage) return new Set()
  try {
    const raw = storage.getItem(EXPANDED_STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveExpanded(
  expanded: ReadonlySet<string>,
  storage: StorageLike | null = defaultStorage()
): void {
  try {
    storage?.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]))
  } catch {
    // Quota or private mode: expansion state is a nicety, not critical.
  }
}

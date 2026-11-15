// The folders a message can be moved to, for the "Move to…" picker.

import type { Folder } from '../store'
import { buildFolderTree, type FolderNode } from './folderTree'

export interface MoveTarget {
  path: string
  label: string
  depth: number
}

const SPECIAL_LABELS: Record<string, string> = {
  '\\Archive': 'Archive', '\\Junk': 'Junk', '\\Trash': 'Trash', '\\Sent': 'Sent', '\\Drafts': 'Drafts'
}
const SPECIAL_ORDER = ['\\Archive', '\\Junk', '\\Trash', '\\Sent', '\\Drafts']

/** Inbox, then the special-use mailboxes, then every custom folder as a tree
 * (nested folders indented under their parent), without \Noselect parents
 * (they cannot hold mail) and without `current`. `filter` matches the label or
 * the full path, case-insensitively. */
export function moveTargets(folders: ReadonlyArray<Folder>, current: string, filter = ''): MoveTarget[] {
  const out: MoveTarget[] = []
  out.push({ path: 'INBOX', label: 'Inbox', depth: 0 })
  const specials = folders
    .filter((f) => f.specialUse && SPECIAL_LABELS[f.specialUse] && !f.noselect)
    .sort((a, b) => SPECIAL_ORDER.indexOf(a.specialUse!) - SPECIAL_ORDER.indexOf(b.specialUse!))
  for (const f of specials) out.push({ path: f.id, label: SPECIAL_LABELS[f.specialUse!], depth: 0 })

  const custom = folders.filter((f) => !f.specialUse && f.id.toUpperCase() !== 'INBOX')
  const walk = (nodes: FolderNode<Folder>[]) => {
    for (const n of nodes) {
      if (!n.folder.noselect) out.push({ path: n.id, label: n.folder.name || n.id, depth: n.depth })
      walk(n.children)
    }
  }
  walk(buildFolderTree<Folder>(custom))

  const q = filter.trim().toLowerCase()
  return out.filter((t) => t.path !== current && (!q || t.label.toLowerCase().includes(q) || t.path.toLowerCase().includes(q)))
}

// Message actions (read/unread, star, delete, archive, junk, move) shared by
// every entry point: list row, context menu, reading-pane toolbar, keyboard.
//
// Each action names the message it acts on by id: an action on a row must act
// on that row, not on whichever message happens to be open. The list updates
// at once (optimistic) and is rolled back if the server refuses. A message
// that is gone on the server (deleted by another client, 404) is dropped from
// the list with a notice. An action that is already running on a message is
// not started a second time, so a double click cannot move it twice.

import { ApiError, MailAPI } from '../api'
import { deleteMessage, getState, restoreMessage, selectMessage, updateMessage, type Folder, type MailMessage } from '../store'
import { specialFolderPath } from './specialFolders'

export type MessageAction =
  | 'read' | 'unread' | 'toggleRead'
  | 'star' | 'unstar' | 'toggleStar'
  | 'delete' | 'archive' | 'junk' | 'notJunk'
  | { moveTo: string }

export interface ActionHooks {
  /** Short confirmation or error for the user. */
  notify: (text: string) => void
  /** The action changed the server: refresh folder counts. */
  changed: () => void
}

const SEEN = '\\Seen'
const FLAGGED = '\\Flagged'

export function hasFlag(m: Pick<MailMessage, 'flags'> | undefined, flag: string): boolean {
  const f = m?.flags || []
  return f.includes(flag) || f.includes(flag.replace(/^\\/, ''))
}

/** The display name of a mailbox path, for "Moved to …". */
export function folderLabel(folders: ReadonlyArray<Folder>, path: string): string {
  if (path.toUpperCase() === 'INBOX') return 'Inbox'
  return folders.find((f) => f.id === path)?.name || path
}

export function isSpecialFolder(folders: ReadonlyArray<Folder>, path: string, use: string, fallback: string): boolean {
  return specialFolderPath(folders, use, fallback) === path
}

const running = new Set<string>()

/** True while an action on this message (in this folder) is in flight. */
export function isBusy(id: string, folder = getState().activeFolder): boolean {
  return running.has(`${folder}\u0000${id}`)
}

type FlagChange = { add: string[]; remove: string[] }

function flagChange(m: MailMessage, action: MessageAction): FlagChange | null {
  const toggle = (flag: string, on: boolean): FlagChange => (on ? { add: [flag], remove: [] } : { add: [], remove: [flag] })
  switch (action) {
    case 'read': return toggle(SEEN, true)
    case 'unread': return toggle(SEEN, false)
    case 'toggleRead': return toggle(SEEN, !hasFlag(m, SEEN))
    case 'star': return toggle(FLAGGED, true)
    case 'unstar': return toggle(FLAGGED, false)
    case 'toggleStar': return toggle(FLAGGED, !hasFlag(m, FLAGGED))
    default: return null
  }
}

function withFlags(flags: string[], { add, remove }: FlagChange): string[] {
  const bare = (f: string) => f.replace(/^\\/, '')
  const removed = new Set([...add, ...remove].map(bare))
  return [...flags.filter((f) => !removed.has(bare(f))), ...add]
}

/** Run `action` on message `id` of the open folder. Resolves true when the
 * server confirmed it, false when it was refused, skipped or the message is gone. */
export async function runMessageAction(id: string, action: MessageAction, hooks: ActionHooks): Promise<boolean> {
  const s = getState()
  const folder = s.activeFolder
  const index = s.messages.findIndex((m) => m.id === id)
  const msg = s.messages[index]
  if (!msg) return false
  const key = `${folder}\u0000${id}`
  if (running.has(key)) return false

  const change = flagChange(msg, action)
  // Already in that state: nothing to send.
  if (change && change.add.every((f) => hasFlag(msg, f)) && change.remove.every((f) => !hasFlag(msg, f))) return true

  running.add(key)
  const before = msg.flags || []
  const wasSelected = s.selectedMessageId === id
  const stillHere = () => getState().activeFolder === folder

  try {
    if (change) {
      updateMessage(id, { flags: withFlags(before, change) })
      await MailAPI.setFlags(id, folder, change.add, change.remove)
      hooks.changed()
      return true
    }

    const folders = s.folders
    deleteMessage(id)
    let note: string
    if (action === 'delete') {
      const r = await MailAPI.delete(id, folder)
      note = r.trashed ? 'Moved to Trash' : 'Deleted permanently'
    } else if (action === 'archive') {
      const r = await MailAPI.moveToSpecial(id, folder, '\\Archive')
      note = `Archived to ${folderLabel(folders, r.folder)}`
    } else if (action === 'junk') {
      await MailAPI.moveToSpecial(id, folder, '\\Junk')
      note = 'Marked as junk'
    } else if (action === 'notJunk') {
      await MailAPI.moveToSpecial(id, folder, '\\Inbox')
      note = 'Moved to Inbox'
    } else if (typeof action === 'object' && action.moveTo) {
      const r = await MailAPI.move(id, folder, action.moveTo)
      note = `Moved to ${folderLabel(folders, r.folder || action.moveTo)}`
    } else {
      throw new Error(`Unknown action ${JSON.stringify(action)}`)
    }
    hooks.notify(note)
    hooks.changed()
    return true
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // Gone on the server (another client deleted or moved it): drop it here too.
      deleteMessage(id)
      hooks.notify('That message no longer exists on the server')
      hooks.changed()
      return false
    }
    if (stillHere()) {
      if (change) updateMessage(id, { flags: before })
      else {
        restoreMessage(msg, index)
        if (wasSelected && getState().selectedMessageId === null) {
          // Put the reading pane back on the message the action failed for.
          selectMessage(id)
        }
      }
    }
    hooks.notify(`Could not ${describe(action)}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    running.delete(key)
  }
}

function describe(action: MessageAction): string {
  if (typeof action === 'object') return 'move the message'
  return {
    read: 'mark the message as read', unread: 'mark the message as unread', toggleRead: 'change the read state',
    star: 'star the message', unstar: 'unstar the message', toggleStar: 'change the star',
    delete: 'delete the message', archive: 'archive the message', junk: 'mark the message as junk',
    notJunk: 'move the message to the Inbox'
  }[action]
}

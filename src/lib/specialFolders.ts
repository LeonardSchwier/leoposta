import type { Folder } from '../store'

/** The real IMAP path of a special-use mailbox (RFC 6154: \Drafts, \Sent,
 * \Trash, \Junk, \Archive), as reported by /api/folders. Servers name these
 * differently ("INBOX.Drafts", "[Gmail]/Drafts", localized names), so the
 * sidebar's fixed entries must not hardcode the path. Falls back to `fallback`
 * when no folder carries the flag (or folders are not loaded yet). */
export function specialFolderPath(
  folders: ReadonlyArray<Folder>,
  specialUse: string,
  fallback: string,
): string {
  return folders.find((f) => f.specialUse === specialUse)?.id ?? fallback
}

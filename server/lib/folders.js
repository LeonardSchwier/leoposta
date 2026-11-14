// Folder helpers shared by the mail routes.

/**
 * Validate a folder (mailbox path) taken from a query string or JSON body.
 *
 * Missing (undefined) means `fallback` (INBOX for the read routes). Anything
 * that is present but not a non-blank string - "" (e.g. a raw "#" in the URL
 * truncated the query), whitespace, a repeated parameter that Express parses
 * into an array, an object - returns null so the route can answer 400 instead
 * of sending SELECT "" to the IMAP server.
 *
 * @param {unknown} value
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
export function folderParam(value, fallback = 'INBOX') {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') return null
  return value
}

export const INVALID_FOLDER = 'folder must be a non-empty mailbox path'

/**
 * Map an ImapFlow list() entry to the shape the UI consumes.
 * parentPath and delimiter come straight from ImapFlow (computed from the
 * server's LIST delimiter, "/" or "." or anything else), so nesting is right
 * for every server and does not depend on the leaf name being unique in the path.
 */
export function toFolderEntry(mb) {
  const flags = mb.flags instanceof Set ? mb.flags : new Set(mb.flags || [])
  return {
    id: mb.path,
    name: mb.name,
    parentId: mb.parentPath || null,
    delimiter: mb.delimiter || null,
    noselect: flags.has('\\Noselect') || flags.has('\\NonExistent'),
    specialUse: mb.specialUse || undefined,
    // From list({ statusQuery }); absent for \\Noselect mailboxes and when the
    // server refused STATUS for that mailbox (status.error).
    exists: typeof mb.status?.messages === 'number' ? mb.status.messages : undefined,
    unseen: typeof mb.status?.unseen === 'number' ? mb.status.unseen : undefined
  }
}

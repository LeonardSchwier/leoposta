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

const num = (v) => (typeof v === 'number' ? v : undefined)

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
    // From list({ statusQuery }) (LIST-STATUS or STATUS); absent for
    // \\Noselect mailboxes and when the server refused STATUS for that
    // mailbox (status.error).
    exists: num(mb.status?.messages) ?? num(mb.exists),
    unseen: num(mb.status?.unseen) ?? num(mb.unseen)
  }
}

/**
 * Path of a child mailbox `name` under `parent` ("" or null = top level),
 * joined with the server's hierarchy delimiter ("/" or "." or anything else).
 */
export function childPath(parent, delimiter, name) {
  return parent ? `${parent}${delimiter || '/'}${name}` : name
}

/**
 * Every mailbox below `path` in an ImapFlow list(), deepest first, so they can
 * be deleted in order (IMAP DELETE of a parent leaves its children behind, as
 * a \Noselect placeholder or with a NO "has children").
 *
 * @param {{ path: string, delimiter?: string }[]} list
 * @param {string} path
 */
export function descendantsDeepestFirst(list, path) {
  const d = list.find((mb) => mb.path === path)?.delimiter || list.find((mb) => mb.delimiter)?.delimiter || '/'
  const prefix = path + d
  return list
    .map((mb) => mb.path)
    .filter((p) => p.startsWith(prefix))
    .sort((a, b) => b.split(d).length - a.split(d).length || b.localeCompare(a))
}

/** The server's refusal text for a failed IMAP command ("Command failed" alone says nothing). */
export function imapErrorText(err) {
  const resp = err && err.responseText ? String(err.responseText).trim() : ''
  return resp || (err && err.message) || String(err)
}

/** True when an IMAP command was answered NO/BAD (a refusal, not a dropped connection). */
export function isImapRefusal(err) {
  return Boolean(err && (err.responseStatus === 'NO' || err.responseStatus === 'BAD'))
}

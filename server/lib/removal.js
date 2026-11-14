// Moving and deleting mail without losing it.
//
// ImapFlow's messageMove, messageCopy and messageDelete resolve to false when the
// server refuses, instead of throwing, so a caller that ignores the result
// reports success for a message that is still there. Without the MOVE extension
// messageMove is COPY followed by messageDelete, and the delete runs even when
// the COPY failed, which destroys the only copy. These helpers check every
// result and never delete as a fallback.

/** A refusal by the mail server. The route answers it with an error but keeps
 * the IMAP connection: nothing is wrong with the connection itself. */
export class MailActionError extends Error {}

export const DEFAULT_TRASH_NAME = 'Trash'

// A mailbox that cannot hold messages (a bare parent folder, or one that does not
// exist): ImapFlow adds \Noselect to \NonExistent entries as well.
const selectable = (m) => !(m.flags && m.flags.has && m.flags.has('\\Noselect'))

/** The mailbox for a special use (RFC 6154: \\Trash, \\Archive, \\Junk, ...):
 * the one the server flags with it (ImapFlow also derives the flag from
 * well-known and localized names such as "Deleted Items" or "Spam"), else a
 * mailbox called `defaultName` in any case, with or without a namespace prefix
 * ("INBOX.Archive"). Null when there is none. The path is the full one that
 * list() reports, namespace prefix included. */
export async function findSpecialUsePath(client, specialUse, defaultName) {
  const mailboxes = (await client.list()).filter(selectable)
  const flagged = mailboxes.find((m) => m.specialUse === specialUse)
  if (flagged) return flagged.path
  const want = String(defaultName).toLowerCase()
  const named = mailboxes.find((m) => String(m.path).toLowerCase() === want)
    || mailboxes.find((m) => m.delimiter && String(m.path).toLowerCase() === `inbox${m.delimiter}${want}`)
  return named ? named.path : null
}

/** The special-use mailbox, created as `defaultName` when the server has none
 * (the path the server reports for the new mailbox is used: it may add a
 * namespace prefix). */
export async function ensureSpecialUsePath(client, specialUse, defaultName) {
  const found = await findSpecialUsePath(client, specialUse, defaultName)
  return found !== null ? found : createMailbox(client, defaultName)
}

async function createMailbox(client, defaultName) {
  try {
    const created = await client.mailboxCreate(defaultName)
    return (created && created.path) || defaultName
  } catch (err) {
    throw new MailActionError(
      `There is no ${defaultName} mailbox and it could not be created: ${(err && err.message) || err}`
    )
  }
}

/** The mailbox deleted mail goes to (see findSpecialUsePath). */
export function findTrashPath(client) {
  return findSpecialUsePath(client, '\\Trash', DEFAULT_TRASH_NAME)
}

/** Special uses a message can be moved to by name, and the mailbox created
 * when the server has none. */
export const MOVE_TARGETS = {
  '\\Archive': 'Archive',
  '\\Junk': 'Junk',
  '\\Trash': DEFAULT_TRASH_NAME,
  '\\Inbox': 'INBOX'
}

/** A message that is not (or no longer) in the selected mailbox, e.g. deleted
 * by another client. Answered with a 404, keeping the IMAP connection. */
export class MessageNotFoundError extends MailActionError {}

/** Throw MessageNotFoundError unless `uid` exists in the selected mailbox. A
 * STORE, MOVE or EXPUNGE on a missing UID is not an error in IMAP: it silently
 * does nothing, and the app would report a move that never happened. */
export async function requireMessage(client, uid) {
  const found = await client.fetchOne(String(uid), { uid: true }, { uid: true })
  if (!found) throw new MessageNotFoundError('message_not_found')
}

/** Move one message (by UID) out of the selected mailbox. Throws a
 * MailActionError unless the server confirms; the original is only removed once
 * the copy is confirmed. MOVE is detected from the advertised capabilities, so a
 * server that only implies it (IMAP4rev2) gets COPY, check, remove: still
 * checked, only not atomic. */
export async function moveChecked(client, uid, destination) {
  const options = { uid: true }
  if (client.capabilities && client.capabilities.has('MOVE')) {
    const moved = await client.messageMove(uid, destination, options)
    if (!moved) throw new MailActionError(`The server refused to move the message to ${destination}`)
    return moved
  }
  const copied = await client.messageCopy(uid, destination, options)
  if (!copied) throw new MailActionError(`The server refused to copy the message to ${destination}`)
  const removed = await client.messageDelete(uid, options)
  if (!removed) {
    throw new MailActionError(`The message was copied to ${destination} but the original could not be removed`)
  }
  return copied
}

/** Delete a message the way mail clients do: move it to Trash, creating Trash
 * when the server has none. Only a message that is already in Trash is removed
 * for good. `mailbox` must be the path the server actually selected (the
 * `path` of the mailbox lock), not the name the client sent: ImapFlow adds the
 * namespace prefix and folds INBOX, so "Trash" is "INBOX.Trash" on some servers,
 * and comparing the raw name would move the Trash into itself and report
 * success. The comparison is exact, so only the real Trash is ever expunged.
 * Returns { trashed, folder }: where the message is now, or where it was
 * permanently removed. */
export async function removeMessage(client, mailbox, uid) {
  const trash = await findTrashPath(client)
  if (trash !== null && trash === mailbox) {
    const removed = await client.messageDelete(uid, { uid: true })
    if (!removed) throw new MailActionError('The server refused to delete the message')
    return { trashed: false, folder: mailbox }
  }

  const target = trash !== null ? trash : await createMailbox(client, DEFAULT_TRASH_NAME)
  await moveChecked(client, uid, target)
  return { trashed: true, folder: target }
}

/** A message UID from a URL parameter: a plain positive integer, or null.
 * Number() alone would accept '0x10', '1e3' and ''. */
export function parseUid(raw) {
  return typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : null
}

// Changing message flags (read, starred, keywords) through ImapFlow.
//
// ImapFlow has messageFlagsAdd / messageFlagsRemove / messageFlagsSet and no
// messageFlags, and they resolve to false (not throw) when the server refuses.

import { MailActionError } from './removal.js'

// A system flag (\Seen) or a keyword ($Work): no spaces, parentheses or quotes,
// so a value cannot add tokens to the STORE command.
const FLAG = /^\\?[A-Za-z0-9$_.-]{1,64}$/
export const MAX_FLAGS = 32

/** An array of flag names, [] when absent, or null when it is not one. */
export function parseFlagList(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_FLAGS) return null
  return value.every((flag) => typeof flag === 'string' && FLAG.test(flag)) ? value : null
}

/** Add and remove flags on a message by UID in the selected mailbox. A refusal by
 * the server is a MailActionError, so the caller can answer it without the pool
 * mistaking it for a broken connection. */
export async function changeFlags(client, uid, { add = [], remove = [] }) {
  if (add.length > 0 && (await client.messageFlagsAdd(uid, add, { uid: true })) === false) {
    throw new MailActionError('The server refused to change the message flags')
  }
  if (remove.length > 0 && (await client.messageFlagsRemove(uid, remove, { uid: true })) === false) {
    throw new MailActionError('The server refused to change the message flags')
  }
}

// Saving a draft: build the MIME message and APPEND it to the account's Drafts
// mailbox, flagged \Draft and \Seen, so it shows in the Drafts folder here and
// in every other mail client.

import MailComposer from 'nodemailer/lib/mail-composer'
import { MailActionError } from './removal.js'

export const DEFAULT_DRAFTS_NAME = 'Drafts'
export const DRAFT_FLAGS = ['\\Draft', '\\Seen']

const selectable = (m) => !(m.flags && m.flags.has && m.flags.has('\\Noselect'))

/** The mailbox drafts go to: the one the server flags \Drafts (ImapFlow also
 * derives that from well-known and localized names), else a mailbox called
 * Drafts in any case. Null when there is none. The path is the full one that
 * list() reports, namespace prefix included (e.g. "INBOX.Drafts"). */
export async function findDraftsPath(client) {
  const mailboxes = (await client.list()).filter(selectable)
  const flagged = mailboxes.find((m) => m.specialUse === '\\Drafts')
  if (flagged) return flagged.path
  const named = mailboxes.find((m) => String(m.path).toLowerCase() === DEFAULT_DRAFTS_NAME.toLowerCase())
  return named ? named.path : null
}

/** The raw RFC 5322 source of a draft. Bcc is kept: the draft is not sent, and
 * finishing it later must not lose the blind recipients. */
export async function buildDraftSource(acct, { to, cc, bcc, subject, body, attachments } = {}) {
  const list = (v) => (Array.isArray(v) ? v.join(', ') : v) || undefined
  const mail = {
    from: { name: acct.name || acct.email, address: acct.email },
    to: list(to),
    cc: list(cc),
    bcc: list(bcc),
    subject: subject || '',
    text: body || ''
  }
  if (Array.isArray(attachments) && attachments.length > 0) {
    // Compose sends attachment bytes as base64 strings (OutboundAttachment).
    mail.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      encoding: 'base64',
      contentType: a.contentType || 'application/octet-stream'
    }))
  }
  const node = new MailComposer(mail).compile()
  node.keepBcc = true
  return node.build()
}

/** The Drafts mailbox path, creating Drafts when the server has none (the path
 * the server reports for the new mailbox is used: it may add a namespace prefix). */
export async function ensureDraftsPath(client) {
  const found = await findDraftsPath(client)
  if (found !== null) return found
  try {
    const created = await client.mailboxCreate(DEFAULT_DRAFTS_NAME)
    return (created && created.path) || DEFAULT_DRAFTS_NAME
  } catch (err) {
    throw new MailActionError(
      `There is no Drafts mailbox and it could not be created: ${(err && err.message) || err}`
    )
  }
}

/** APPEND a draft to `target`, flagged \Draft and \Seen. Returns { folder, uid }
 * (uid only when the server reports it, i.e. with UIDPLUS). A refusal by the
 * server (NO/BAD, which ImapFlow throws as "Command failed" with a responseText)
 * becomes a MailActionError. */
export async function appendDraft(client, target, source) {
  let result
  try {
    result = await client.append(target, source, DRAFT_FLAGS, new Date())
  } catch (err) {
    if (err && err.responseText) {
      throw new MailActionError(`The server refused to save the draft to ${target}: ${err.responseText}`)
    }
    throw err
  }
  if (!result) throw new MailActionError(`The server refused to save the draft to ${target}`)
  return { folder: result.destination || target, uid: result.uid }
}

/** Remove the draft `uid` from the Drafts mailbox for good (it was replaced by
 * a newer save, or sent). Only a message flagged \Draft is removed, so a wrong
 * UID cannot destroy real mail. A draft that is already gone (deleted in
 * another client) is not an error: { discarded: false }. */
export async function discardDraft(client, draftsPath, uid) {
  const lock = await client.getMailboxLock(draftsPath)
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true })
    if (!msg) return { discarded: false }
    const flags = msg.flags instanceof Set ? msg.flags : new Set(msg.flags || [])
    if (!flags.has('\\Draft')) {
      throw new MailActionError(`Message ${uid} in ${draftsPath} is not a draft; it was left alone`)
    }
    if (!(await client.messageDelete(String(uid), { uid: true }))) {
      throw new MailActionError('The server refused to delete the old draft')
    }
    return { discarded: true }
  } finally {
    lock.release()
  }
}

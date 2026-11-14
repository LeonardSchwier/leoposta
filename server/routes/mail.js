import { Router } from 'express'
import { state, resolveAccount, saveRuleCursors } from '../lib/state.js'
import { getPoolFor } from '../lib/imap.js'
import { normalizeFlags, parseFromAddr, toISO, messageDate } from '../lib/address.js'
import { messageRange } from '../lib/mailRange.js'
import { processPgp, findPgpPayload } from '../lib/pgp.js'
import { runRulesOnNewMail } from '../lib/rules.js'
import {
  MailActionError, MessageNotFoundError, MOVE_TARGETS, ensureSpecialUsePath, moveChecked, parseUid,
  removeMessage, requireMessage
} from '../lib/removal.js'
import { addSnippets } from '../lib/snippet.js'
import { changeFlags, parseFlagList } from '../lib/flags.js'
import {
  childPath,
  descendantsDeepestFirst,
  folderParam,
  imapErrorText,
  INVALID_FOLDER,
  isImapRefusal,
  toFolderEntry
} from '../lib/folders.js'
import {
  attachmentAt,
  bodyStructureAttachments,
  contentDispositionHeader,
  listAttachments,
  mergePgpAttachments,
  parseMessageSource,
  safeContentType
} from '../lib/attachments.js'

const router = Router()

// A refusal by the server is returned as a value, not thrown: an error thrown
// inside pool.run makes the pool log the shared IMAP client out. A message that
// is gone (deleted by another client) is a 404.
function asOutcome(err) {
  if (err instanceof MessageNotFoundError) return { status: 404, error: 'message_not_found' }
  if (err instanceof MailActionError) return { status: 500, error: err.message }
  throw err
}
const answer = (res, outcome, ok) =>
  outcome.error ? res.status(outcome.status || 500).json({ error: outcome.error }) : res.json(ok)

// GET /api/messages
router.get('/messages', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query
    const folder = folderParam(req.query.folder)
    if (folder === null) return res.status(400).json({ error: INVALID_FOLDER })
    const limitN = Math.min(Math.max(1, Number(limit) || 100), 200)
    const offsetN = Math.max(0, Number(offset) || 0)

    const acct = resolveAccount(req)
    if (!acct) {
      return res.json({ messages: [], unreadCount: 0 })
    }
    const pool = getPoolFor(acct)

    await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        // Rules act on new Inbox mail on the server (lib/rules.js) before it is listed.
        let ruleActions = 0
        if (String(lock.path || folder).toUpperCase() === 'INBOX') {
          const done = await runRulesOnNewMail(client, {
            key: String(acct.email).toLowerCase(), rules: state.rules,
            cursors: state.ruleCursors, save: saveRuleCursors
          })
          ruleActions = done.length
        }
        const mailbox = client.mailbox
        const exists = mailbox.exists || 0
        const unreadCount = (mailbox.unseen != null) ? mailbox.unseen
                        : (mailbox.exists && mailbox.seen != null) ? Math.max(0, mailbox.exists - mailbox.seen)
                        : (mailbox.recent || 0)
        const range = messageRange(exists, limitN, offsetN)
        if (range.empty) {
          res.json({ messages: [], unreadCount, ruleActions, total: exists })
          return
        }
        const end = range.end
        const start = range.start

        const messages = []
        const previews = []
        const result = client.fetch(
          `${start}:${end}`,
          {
            uid: true, internalDate: true, from: true, to: true, cc: true,
            subject: true, flags: true, envelope: true,
            bodyStructure: true, 'in-reply-to': true, 'references': true
          },
          { op: 'FETCH' }
        )

        for await (const msg of result) {
          const from = parseFromAddr(msg.from?.[0] || msg.envelope?.from?.[0])
          const to = (msg.to || msg.envelope?.to || []).map(t => t.address)
          const cc = (msg.cc || msg.envelope?.cc || []).map(c => c.address)
          const bcc = (msg.bcc || []).map(b => b.address)

          const attachments = bodyStructureAttachments(msg.bodyStructure)

          const inReplyTo = msg['in-reply-to'] || msg['In-Reply-To'] || ''
          const references = msg['references'] || msg['References'] || ''
          const refIds = references.split('<').filter(Boolean)
          const threadId = inReplyTo || (refIds.length > 0 ? '<' + refIds[refIds.length - 1] : '') || (msg.uid?.toString() || Date.now().toString())

          messages.push({
            id: msg.uid?.toString() || Date.now().toString(),
            threadId,
            from: from.name || from.address || '',
            fromAddress: from.address || '',
            to, cc, bcc,
            subject: msg.subject || msg.envelope?.subject || '(No Subject)',
            body: '', bodyHtml: '', snippet: '',
            date: messageDate(msg),
            flags: normalizeFlags(msg.flags),
            hasAttachment: attachments.length > 0,
            attachmentCount: attachments.length,
            attachments, folder, headers: {}
          })
          previews.push({ entry: messages[messages.length - 1], uid: msg.uid, bodyStructure: msg.bodyStructure })
        }
        await addSnippets(client, previews)

        messages.sort((a, b) => new Date(b.date) - new Date(a.date))
        // `total` lets the client offer "load more" for the older messages.
        res.json({ messages, unreadCount, ruleActions, total: exists })
      } finally {
        lock.release()
      }
    })
  } catch (err) {
    console.error('Error fetching messages:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/message/:id
// Only the fetch (and marking the message read) runs under the mailbox lock and
// inside pool.run; parsing a large message there would block the account's other
// IMAP work. A message that is gone is a 404 returned as a value: an error thrown
// inside pool.run makes the pool log the shared IMAP client out.
router.get('/message/:id', async (req, res) => {
  try {
    const uid = parseUid(req.params.id)
    if (uid === null) return res.status(400).json({ error: 'invalid message id' })
    const folder = folderParam(req.query.folder)
    if (folder === null) return res.status(400).json({ error: INVALID_FOLDER })

    const acct = resolveAccount(req)
    if (!acct) {
      return res.status(404).json({ error: 'No account configured' })
    }
    const pool = getPoolFor(acct)

    const fetched = await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const msg = await client.fetchOne(String(uid), {
          uid: true, internalDate: true, flags: true, envelope: true,
          bodyStructure: true, source: true
        }, { uid: true })
        if (!msg) return { status: 404, error: 'message_not_found' }
        const flags = normalizeFlags(msg.flags)
        if (!flags.includes('\\Seen') && !flags.includes('Seen')) {
          // Best effort: the message is shown either way (a read-only mailbox refuses).
          try {
            if (await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })) flags.push('\\Seen')
          } catch (e) { /* see above */ }
        }
        return { msg, flags }
      } finally {
        lock.release()
      }
    })
    if (fetched.error) return res.status(fetched.status).json({ error: fetched.error })
    const { msg, flags } = fetched

    const from = parseFromAddr(msg.from?.[0] || msg.envelope?.from?.[0])
    const to = (msg.to || msg.envelope?.to || []).map(t => t.address)
    const cc = (msg.cc || msg.envelope?.cc || []).map(c => c.address)
    // IMAP envelopes carry Bcc only for messages that kept the header (drafts, sent copies).
    const bcc = (msg.bcc || msg.envelope?.bcc || []).map(b => b.address)

    let body = ''
    let bodyHtml = ''
    let attachments = []
    let pgpPayload = null
    // Threading ids, for replies (In-Reply-To / References).
    let messageId = msg.envelope?.messageId || ''
    let references = []
    let replyTo = []

    if (msg.source) {
      try {
        const parsed = await parseMessageSource(msg.source)
        if (parsed.messageId) messageId = parsed.messageId
        if (parsed.references) references = [].concat(parsed.references)
        if (parsed.replyTo) replyTo = parsed.replyTo.value.filter(a => a.address).map(a => (a.name ? `"${a.name.replace(/(["\\])/g, '\\$1')}" <${a.address}>` : a.address))
        if (parsed.html) bodyHtml = parsed.html
        if (parsed.text) body = parsed.text
        attachments.push(...listAttachments(parsed.attachments))
        pgpPayload = findPgpPayload(parsed)
        // RFC 3156's "Version: 1" control part and the encrypted blob are
        // not attachments the user sent.
        if (pgpPayload && pgpPayload.hide.length) attachments = attachments.filter((_, i) => !pgpPayload.hide.includes(i))
      } catch (parseErr) {
        // Unparseable MIME: show the raw source as text (never as HTML).
        body = msg.source.toString('utf-8')
      }
    }

    const pgpResult = pgpPayload ? await processPgp(pgpPayload) : await processPgp(body)
    // Decrypted attachment bytes stay on the server (served by the
    // attachment route as id "pgp-<n>").
    const { parts: _parts, ...pgp } = pgpResult || {}
    const locked = !!(pgpResult && pgpResult.encrypted && !pgpResult.decrypted)
    // Undecryptable: show no ciphertext as the body (the banner asks for
    // the key or passphrase; the armor is under "show encrypted data").
    const finalBody = pgpResult?.decrypted ? pgp.text : (locked ? '' : body)
    const finalHtml = pgpResult?.decrypted ? (pgp.html || '') : (locked ? '' : bodyHtml)
    const finalAttachments = pgpResult?.decrypted && pgp.attachments?.length
      ? mergePgpAttachments(attachments, pgp.attachments)
      : attachments
    res.json({
      id: msg.uid?.toString() || String(uid),
      from: from.name || from.address || '',
      fromAddress: from.address || '',
      to, cc, bcc,
      subject: msg.subject || msg.envelope?.subject || '(No Subject)',
      body: finalBody, bodyHtml: finalHtml,
      pgp: pgpResult ? pgp : null,
      date: messageDate(msg),
      flags,
      attachments: finalAttachments,
      messageId, references, replyTo,
      folder, headers: {}
    })
  } catch (err) {
    console.error('Error fetching message:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/folders
router.get('/folders', async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) {
      return res.json({ folders: [] })
    }
    const pool = getPoolFor(acct)

    const folders = await pool.run(async (client) => {
      // STATUS per mailbox (LIST-STATUS where the server has it): the sidebar
      // shows each folder's real unread count, not the count of the open list.
      const mailboxes = await client.list({ statusQuery: { messages: true, unseen: true } })
      return mailboxes.map(toFolderEntry)
    })
    res.json({ folders })
  } catch (err) {
    console.error('Error listing folders:', err)
    res.status(500).json({ error: err.message })
  }
})

/** IMAP SEARCH for `q` in the subject, sender, recipients or body. */
export function searchCriteria(q) {
  return { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] }
}

// GET /api/search
router.get('/search', async (req, res) => {
  try {
    const { q, limit = 50 } = req.query
    const folder = folderParam(req.query.folder)
    if (folder === null) return res.status(400).json({ error: INVALID_FOLDER })

    const acct = resolveAccount(req)
    if (!acct || !q) {
      return res.json({ messages: [], total: 0 })
    }
    const pool = getPoolFor(acct)

    await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        // Subject, sender, recipients or body text, not only the subject.
        const found = await client.search(searchCriteria(String(q)), { uid: true })
        const searchUids = Array.isArray(found) ? found : []

        if (searchUids.length === 0) {
          return res.json({ messages: [], total: 0 })
        }

        // The newest matches (highest UIDs), not the oldest ones.
        const limitN = Math.min(Math.max(1, Number(limit) || 50), 200)
        const resultUids = [...searchUids].sort((a, b) => a - b).slice(-limitN)
        const result = client.fetch(resultUids, {
          uid: true, internalDate: true, from: true, to: true,
          subject: true, flags: true, envelope: true
        }, { op: 'FETCH', uid: true })

        const messages = []
        for await (const msg of result) {
          const from = parseFromAddr(msg.from?.[0] || msg.envelope?.from?.[0])
          messages.push({
            id: msg.uid?.toString(),
            from: from.name || from.address || '',
            fromAddress: from.address || '',
            to: (msg.to || msg.envelope?.to || []).map(t => t.address),
            cc: (msg.cc || msg.envelope?.cc || []).map(c => c.address),
            bcc: [],
            subject: msg.subject || msg.envelope?.subject || '(No Subject)',
            body: '', bodyHtml: '', snippet: '',
            date: messageDate(msg),
            flags: normalizeFlags(msg.flags),
            hasAttachment: false, attachmentCount: 0, attachments: [],
            folder, headers: {}
          })
        }

        messages.sort((a, b) => new Date(b.date) - new Date(a.date))
        res.json({ messages, total: searchUids.length })
      } finally {
        lock.release()
      }
    })
  } catch (err) {
    console.error('Error searching:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/message/:id/flags
router.post('/message/:id/flags', async (req, res) => {
  try {
    const uid = parseUid(req.params.id)
    if (uid === null) return res.status(400).json({ error: 'invalid message id' })
    const { folder = 'INBOX' } = req.body || {}
    const add = parseFlagList(req.body?.add)
    const remove = parseFlagList(req.body?.remove)
    if (add === null || remove === null || typeof folder !== 'string' || !folder) {
      return res.status(400).json({ error: 'invalid flags or folder' })
    }
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    if (add.length === 0 && remove.length === 0) return res.json({ success: true })
    const pool = getPoolFor(acct)

    const outcome = await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        await requireMessage(client, uid)
        await changeFlags(client, uid, { add, remove })
        return {}
      } catch (err) {
        return asOutcome(err)
      } finally {
        lock.release()
      }
    })
    answer(res, outcome, { success: true })
  } catch (err) {
    console.error('Error updating flags:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/message/:id
// Moves the message to the server's Trash (creating it if there is none); only a
// message that is already in Trash is removed for good. See lib/removal.js.
router.delete('/message/:id', async (req, res) => {
  try {
    const uid = parseUid(req.params.id)
    if (uid === null) return res.status(400).json({ error: 'invalid message id' })
    const folder = folderParam(req.query.folder)
    if (folder === null) return res.status(400).json({ error: INVALID_FOLDER })
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const pool = getPoolFor(acct)

    const outcome = await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        await requireMessage(client, uid)
        // lock.path is the mailbox the server selected (namespace prefix applied);
        // `folder` is only what the client called it.
        return await removeMessage(client, lock.path || folder, uid)
      } catch (err) {
        return asOutcome(err)
      } finally {
        lock.release()
      }
    })
    answer(res, outcome, { success: true, ...outcome })
  } catch (err) {
    console.error('Error deleting message:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/message/:id/move  { from, to }  or  { from, toSpecialUse: "\\Archive" }
// `toSpecialUse` (\Archive, \Junk, \Trash, \Inbox) moves to the server's
// mailbox with that RFC 6154 flag, whatever it is called ("Archive",
// "INBOX.Archive", "[Gmail]/All Mail"), creating it when there is none.
// Answers { success, folder } with the real destination path.
router.post('/message/:id/move', async (req, res) => {
  try {
    const uid = parseUid(req.params.id)
    if (uid === null) return res.status(400).json({ error: 'invalid message id' })
    const body = req.body || {}
    const from = folderParam(body.from)
    const special = body.toSpecialUse
    if (special !== undefined && !Object.hasOwn(MOVE_TARGETS, special)) {
      return res.status(400).json({ error: `toSpecialUse must be one of ${Object.keys(MOVE_TARGETS).join(', ')}` })
    }
    const to = special !== undefined ? '' : folderParam(body.to, null)
    if (from === null || to === null) return res.status(400).json({ error: `from/to: ${INVALID_FOLDER}` })
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const pool = getPoolFor(acct)

    const outcome = await pool.run(async (client) => {
      const lock = await client.getMailboxLock(from)
      try {
        await requireMessage(client, uid)
        const target = special === '\\Inbox' ? 'INBOX'
          : special !== undefined ? await ensureSpecialUsePath(client, special, MOVE_TARGETS[special])
          : to
        if (target === (lock.path || from)) {
          throw new MailActionError(`The message is already in ${target}`)
        }
        await moveChecked(client, uid, target)
        return { folder: target }
      } catch (err) {
        return asOutcome(err)
      } finally {
        lock.release()
      }
    })
    answer(res, outcome, { success: true, folder: outcome.folder })
  } catch (err) {
    console.error('Error moving message:', err)
    res.status(500).json({ error: err.message })
  }
})

// Folder management. A NO/BAD from the server (name taken, not allowed, ...) is
// returned as a value with the server's own text: thrown inside pool.run, the
// bare "Command failed" counts as transient, so the pool would log the shared
// client out and resend the command four times.
async function folderOp(pool, fn) {
  return pool.run(async (client) => {
    try {
      return { result: await fn(client) }
    } catch (err) {
      if (isImapRefusal(err)) return { error: imapErrorText(err) }
      throw err
    }
  })
}

const nonBlank = (v) => typeof v === 'string' && v.trim() !== ''

// POST /api/folder { name, parentId? }
router.post('/folder', async (req, res) => {
  try {
    const { name, parentId } = req.body || {}
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    if (!nonBlank(name) || (parentId != null && parentId !== '' && !nonBlank(parentId))) {
      return res.status(400).json({ error: 'name required' })
    }
    const pool = getPoolFor(acct)

    const out = await folderOp(pool, async (client) => {
      let p = name.trim()
      if (parentId) {
        // Join with the server's hierarchy delimiter ("." on many servers).
        const parent = (await client.list()).find((mb) => mb.path === parentId)
        p = childPath(parentId, parent?.delimiter, p)
      }
      const created = await client.mailboxCreate(p)
      return (created && created.path) || p
    })
    if (out.error) return res.status(500).json({ error: out.error })
    res.json({ success: true, path: out.result })
  } catch (err) {
    console.error('Error creating folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/folder/rename { from, name } renames in place (same parent);
// { from, to } moves to a full mailbox path. Children move with their parent.
router.post('/folder/rename', async (req, res) => {
  try {
    const { from, to, name } = req.body || {}
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    if (!nonBlank(from) || !(nonBlank(to) || nonBlank(name))) {
      return res.status(400).json({ error: 'from and name (or to) required' })
    }
    const pool = getPoolFor(acct)

    const out = await folderOp(pool, async (client) => {
      let target = nonBlank(to) ? to : null
      if (!target) {
        const mb = (await client.list()).find((m) => m.path === from)
        target = childPath(mb?.parentPath || '', mb?.delimiter, name.trim())
      }
      const renamed = await client.mailboxRename(from, target)
      return (renamed && renamed.newPath) || target
    })
    if (out.error) return res.status(500).json({ error: out.error })
    res.json({ success: true, path: out.result })
  } catch (err) {
    console.error('Error renaming folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/folder?path=P deletes P and everything below it.
router.delete('/folder', async (req, res) => {
  try {
    const folderPath = folderParam(req.query.path, null)
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    if (!folderPath) return res.status(400).json({ error: 'path required' })
    if (folderPath.toUpperCase() === 'INBOX') return res.status(400).json({ error: 'INBOX cannot be deleted' })
    const pool = getPoolFor(acct)

    const out = await folderOp(pool, async (client) => {
      const list = await client.list()
      // Children first: a plain DELETE of a parent leaves its subfolders behind.
      for (const p of descendantsDeepestFirst(list, folderPath)) await client.mailboxDelete(p)
      try {
        await client.mailboxDelete(folderPath)
      } catch (err) {
        // A \Noselect parent disappears by itself once its last child is gone.
        const still = (await client.list()).some((m) => m.path === folderPath)
        if (still) throw err
      }
      return true
    })
    if (out.error) return res.status(500).json({ error: out.error })
    res.json({ success: true })
  } catch (err) {
    console.error('Error deleting folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/message/:id/attachment/:attachmentId?folder=F
// The attachment id is its index among the parsed message's attachments (see
// lib/attachments.js). The message source is fetched by UID and parsed with the
// same helper the message view uses, so the ids match what the user was shown.
router.get('/message/:id/attachment/:attachmentId', async (req, res) => {
  try {
    const uid = parseUid(req.params.id)
    const folder = req.query.folder === undefined ? 'INBOX' : req.query.folder
    if (uid === null || typeof folder !== 'string' || !folder) {
      return res.status(400).json({ error: 'invalid message id or folder' })
    }
    const acct = resolveAccount(req)
    if (!acct) return res.status(404).json({ error: 'No account configured' })
    const pool = getPoolFor(acct)

    // "Not found" is returned as a value, not thrown: an error thrown inside
    // pool.run makes the pool log the shared IMAP client out. Only the fetch runs
    // under the mailbox lock; parsing a large message there would block the
    // account's other IMAP work, and a parser failure must not drop the connection.
    const fetched = await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true })
        if (!msg || !msg.source) return { status: 404, error: 'message_not_found' }
        return { source: msg.source }
      } finally {
        lock.release()
      }
    })
    if (fetched.error) return res.status(fetched.status).json({ error: fetched.error })
    const parsed = await parseMessageSource(fetched.source)
    const pgpMatch = /^pgp-(\d{1,4})$/.exec(String(req.params.attachmentId))
    let att
    if (pgpMatch) {
      // An attachment inside a PGP-encrypted message: decrypt again (the
      // plaintext is never stored) and serve that part.
      const payload = findPgpPayload(parsed)
      const r = payload ? await processPgp(payload) : null
      if (r && r.encrypted && !r.decrypted) return res.status(423).json({ error: r.error === 'pgp_locked' ? 'pgp_locked' : 'pgp_decrypt_failed' })
      const i = Number(pgpMatch[1])
      att = r && r.parts && r.parts[i] ? { ...r.attachments[i], content: r.parts[i] } : null
    } else {
      att = attachmentAt(parsed.attachments, req.params.attachmentId)
    }
    if (!att) return res.status(404).json({ error: 'attachment_not_found' })

    // The bytes come from whoever sent the mail: always a download, never
    // sniffed, and sandboxed if someone opens the URL directly.
    res.set({
      'Content-Type': safeContentType(att.contentType),
      'Content-Disposition': contentDispositionHeader(att.filename),
      'Content-Length': String(att.content.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store'
    })
    res.end(att.content)
  } catch (err) {
    console.error('Error downloading attachment:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    }
  }
})

export default router

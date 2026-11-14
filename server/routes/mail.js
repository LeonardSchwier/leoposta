import { Router } from 'express'
import { state, resolveAccount } from '../lib/state.js'
import { getPoolFor } from '../lib/imap.js'
import { normalizeFlags, parseFromAddr, toISO, messageDate } from '../lib/address.js'
import { messageRange } from '../lib/mailRange.js'
import { processPgp } from '../lib/pgp.js'
import { applyRules } from '../lib/rules.js'
import { MailActionError, moveChecked, parseUid, removeMessage } from '../lib/removal.js'
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
        // The pooled connection may have had this mailbox selected for a while:
        // getMailboxLock does not re-SELECT it, so EXISTS is only as fresh as
        // the last server response. NOOP makes the server report new mail first.
        await client.noop()
        const mailbox = client.mailbox
        const exists = mailbox.exists || 0
        const unreadCount = (mailbox.unseen != null) ? mailbox.unseen
                        : (mailbox.exists && mailbox.seen != null) ? Math.max(0, mailbox.exists - mailbox.seen)
                        : (mailbox.recent || 0)
        const range = messageRange(exists, limitN, offsetN)
        if (range.empty) {
          res.json({ messages: applyRules([], state.rules), unreadCount })
          return
        }
        const end = range.end
        const start = range.start

        const messages = []
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
        }

        messages.sort((a, b) => new Date(b.date) - new Date(a.date))
        res.json({ messages: applyRules(messages, state.rules), unreadCount })
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
router.get('/message/:id', async (req, res) => {
  try {
    const { id } = req.params
    const folder = folderParam(req.query.folder)
    if (folder === null) return res.status(400).json({ error: INVALID_FOLDER })

    const acct = resolveAccount(req)
    if (!acct) {
      return res.status(404).json({ error: 'No account configured' })
    }
    const pool = getPoolFor(acct)

    await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const msg = await (async () => {
          const uidResult = client.fetch('1:*', { uid: true }, { op: 'FETCH' })
          const uidMap = new Map()
          let seq = 0
          for await (const m of uidResult) {
            if (m.uid) uidMap.set(m.uid.toString(), ++seq)
          }
          const seqNum = uidMap.get(id)
          if (!seqNum) throw new Error('Message UID not found in mailbox')

          return client.fetchOne(seqNum.toString(), {
            uid: true, internalDate: true, from: true, to: true, cc: true,
            bcc: true, subject: true, flags: true, envelope: true,
            bodyStructure: true, source: true
          })
        })()

        const from = parseFromAddr(msg.from?.[0] || msg.envelope?.from?.[0])
        const to = (msg.to || msg.envelope?.to || []).map(t => t.address)
        const cc = (msg.cc || msg.envelope?.cc || []).map(c => c.address)
        const bcc = (msg.bcc || []).map(b => b.address)

        let body = ''
        let bodyHtml = ''
        const attachments = []

        if (msg.source) {
          try {
            const parsed = await parseMessageSource(msg.source)
            if (parsed.html) bodyHtml = parsed.html
            if (parsed.text) body = parsed.text
            attachments.push(...listAttachments(parsed.attachments))
          } catch (parseErr) {
            const raw = msg.source.toString('utf-8')
            if (raw.includes('<html') || raw.includes('<div') || raw.includes('<p')) {
              bodyHtml = raw
            } else {
              body = raw
            }
          }
        }

        const flags = normalizeFlags(msg.flags)
        const isRead = flags.includes('\\Seen') || flags.includes('Seen')
        if (!isRead && msg.uid) {
          try {
            await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true })
          } catch (e) { /* the message is shown either way; marking it read is best effort */ }
        }

        const pgp = await processPgp(body || msg.source?.toString('utf-8') || '')
        const finalBody = pgp?.decrypted ? pgp.text : body
        const finalHtml = pgp?.decrypted ? (pgp.html || '') : bodyHtml
        const finalAttachments = pgp?.decrypted && pgp.attachments?.length
          ? mergePgpAttachments(attachments, pgp.attachments)
          : attachments
        res.json({
          id: msg.uid?.toString() || id,
          from: from.name || from.address || '',
          fromAddress: from.address || '',
          to, cc, bcc,
          subject: msg.subject || msg.envelope?.subject || '(No Subject)',
          body: finalBody, bodyHtml: finalHtml,
          pgp: pgp || null,
          date: messageDate(msg),
          flags: normalizeFlags(msg.flags),
          attachments: finalAttachments,
          folder, headers: {}
        })
      } finally {
        lock.release()
      }
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
      // Unread counts per folder for the sidebar badges (LIST-STATUS, or one
      // STATUS per folder on servers without it).
      const mailboxes = await client.list({ statusQuery: { messages: true, unseen: true } })
      return mailboxes.map(toFolderEntry)
    })
    res.json({ folders })
  } catch (err) {
    console.error('Error listing folders:', err)
    res.status(500).json({ error: err.message })
  }
})

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
        const searchCriteria = { SUBJECT: q }
        const uids = await client.search(searchCriteria, { uid: true })
        const searchUids = Array.isArray(uids) ? uids : [uids]

        if (searchUids.length === 0) {
          return res.json({ messages: [], total: 0 })
        }

        const resultUids = searchUids.slice(0, limit)
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

        res.json({ messages: applyRules(messages, state.rules), total: searchUids.length })
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

    // A refusal by the server is returned as a value, not thrown: an error thrown
    // inside pool.run makes the pool log the shared IMAP client out.
    const outcome = await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        await changeFlags(client, uid, { add, remove })
        return {}
      } catch (err) {
        if (err instanceof MailActionError) return { error: err.message }
        throw err
      } finally {
        lock.release()
      }
    })
    if (outcome.error) return res.status(500).json({ error: outcome.error })
    res.json({ success: true })
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

    // A refusal by the server is returned as a value, not thrown: an error thrown
    // inside pool.run makes the pool log the shared IMAP client out.
    const outcome = await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        // lock.path is the mailbox the server selected (namespace prefix applied);
        // `folder` is only what the client called it.
        return await removeMessage(client, lock.path || folder, uid)
      } catch (err) {
        if (err instanceof MailActionError) return { error: err.message }
        throw err
      } finally {
        lock.release()
      }
    })
    if (outcome.error) return res.status(500).json({ error: outcome.error })
    res.json({ success: true, ...outcome })
  } catch (err) {
    console.error('Error deleting message:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/message/:id/move
router.post('/message/:id/move', async (req, res) => {
  try {
    const uid = parseUid(req.params.id)
    if (uid === null) return res.status(400).json({ error: 'invalid message id' })
    const body = req.body || {}
    const from = folderParam(body.from)
    const to = folderParam(body.to, null)
    if (from === null || to === null) return res.status(400).json({ error: `from/to: ${INVALID_FOLDER}` })
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const pool = getPoolFor(acct)

    const outcome = await pool.run(async (client) => {
      const lock = await client.getMailboxLock(from)
      try {
        await moveChecked(client, uid, to)
        return {}
      } catch (err) {
        if (err instanceof MailActionError) return { error: err.message }
        throw err
      } finally {
        lock.release()
      }
    })
    if (outcome.error) return res.status(500).json({ error: outcome.error })
    res.json({ success: true })
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
    const att = attachmentAt(parsed.attachments, req.params.attachmentId)
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

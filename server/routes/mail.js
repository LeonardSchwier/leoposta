import { Router } from 'express'
import { simpleParser } from 'mailparser'
import { state, resolveAccount } from '../lib/state.js'
import { getPoolFor } from '../lib/imap.js'
import { normalizeFlags, parseFromAddr, toISO, messageDate } from '../lib/address.js'
import { messageRange } from '../lib/mailRange.js'
import { processPgp } from '../lib/pgp.js'
import { applyRules } from '../lib/rules.js'
import { MailActionError, moveChecked, parseUid, removeMessage } from '../lib/removal.js'
import { changeFlags, parseFlagList } from '../lib/flags.js'

const router = Router()

// GET /api/messages
router.get('/messages', async (req, res) => {
  try {
    const { folder = 'INBOX', limit = 100, offset = 0 } = req.query
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

          const attachments = []
          function walkStruct(struct) {
            if (!struct) return
            if (struct.filename) {
              attachments.push({
                id: struct.partSequence?.join('.') || '',
                filename: struct.filename,
                contentType: struct.contentType || struct.type || '',
                size: struct.size || 0,
                contentId: struct.contentId || undefined
              })
            }
            if (struct.parts) struct.parts.forEach(walkStruct)
          }
          walkStruct(msg.bodyStructure)

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
    const { folder = 'INBOX' } = req.query

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
            const parsed = await simpleParser(msg.source.toString('utf-8'))
            if (parsed.html) bodyHtml = parsed.html
            if (parsed.text) body = parsed.text
            if (parsed.attachments) {
              for (const att of parsed.attachments) {
                attachments.push({
                  id: att.filename || 'attachment',
                  filename: att.filename,
                  contentType: att.contentType || att.mimeType || '',
                  size: att.content?.length || 0,
                  contentId: att.contentId || undefined
                })
              }
            }
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
          ? [...attachments, ...pgp.attachments.filter(p => !attachments.some(a => a.filename === p.filename))]
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
      const mailboxes = await client.list()
      return mailboxes.map(mb => ({
        id: mb.path,
        name: mb.name,
        parentId: mb.parentPath ? mb.path.split(mb.name)[0].slice(0, -1) : null,
        specialUse: mb.specialUse || undefined,
        exists: mb.exists,
        unseen: mb.unseen
      }))
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
    const { q, folder = 'INBOX', limit = 50 } = req.query

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
    const { folder = 'INBOX' } = req.query
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
    const { from = 'INBOX', to } = req.body || {}
    const acct = resolveAccount(req)
    if (!acct || !to) return res.status(400).json({ error: 'from/to required' })
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

// POST /api/folder
router.post('/folder', async (req, res) => {
  try {
    const { name, parentId } = req.body
    const acct = resolveAccount(req)
    if (!acct || !name) return res.status(400).json({ error: 'name required' })
    const pool = getPoolFor(acct)

    const folderPath = parentId ? `${parentId}/${name}` : name
    await pool.run(async (client) => { await client.mailboxCreate(folderPath) })
    res.json({ success: true, path: folderPath })
  } catch (err) {
    console.error('Error creating folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/folder/rename
router.post('/folder/rename', async (req, res) => {
  try {
    const { from, to } = req.body || {}
    const acct = resolveAccount(req)
    if (!acct || !from || !to) return res.status(400).json({ error: 'from and to required' })
    const pool = getPoolFor(acct)

    await pool.run(async (client) => { await client.mailboxRename(from, to) })
    res.json({ success: true, path: to })
  } catch (err) {
    console.error('Error renaming folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/folder
router.delete('/folder', async (req, res) => {
  try {
    const { path: folderPath } = req.query
    const acct = resolveAccount(req)
    if (!acct || !folderPath) return res.status(400).json({ error: 'path required' })
    const pool = getPoolFor(acct)

    await pool.run(async (client) => { await client.mailboxDelete(folderPath) })
    res.json({ success: true })
  } catch (err) {
    console.error('Error deleting folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/message/:id/attachment/:partId
router.get('/message/:id/attachment/:partId', async (req, res) => {
  try {
    const { id, partId } = req.params
    const { folder = 'INBOX' } = req.query
    const acct = resolveAccount(req)
    if (!acct) return res.status(404).json({ error: 'No account configured' })
    const pool = getPoolFor(acct)

    await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const part = await client.download(id, partId, { op: 'FETCH' })
        res.setHeader('Content-Type', part.contentType || 'application/octet-stream')
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(part.filename || 'attachment')}"`)
        res.setHeader('Content-Length', part.size || 0)
        part.pipe(res)
      } finally {
        lock.release()
      }
    })
  } catch (err) {
    console.error('Error downloading attachment:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    }
  }
})

export default router

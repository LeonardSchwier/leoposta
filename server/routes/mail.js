import { Router } from 'express'
import { simpleParser } from 'mailparser'
import { state } from '../lib/state.js'
import { pool } from '../lib/imap.js'
import { normalizeFlags, parseFromAddr, toISO } from '../lib/address.js'
import { processPgp } from '../lib/pgp.js'
import { applyRules } from '../lib/rules.js'

const router = Router()

// GET /api/messages
router.get('/messages', async (req, res) => {
  try {
    const { folder = 'INBOX', limit = 100, offset = 0 } = req.query
    const limitN = Math.min(Math.max(1, Number(limit) || 100), 200)
    const offsetN = Math.max(0, Number(offset) || 0)

    if (!state.account) {
      return res.json({ messages: [], unreadCount: 0 })
    }

    await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const mailbox = client.mailbox
        const exists = mailbox.exists || 0
        const unreadCount = (mailbox.unseen != null) ? mailbox.unseen
                        : (mailbox.exists && mailbox.seen != null) ? Math.max(0, mailbox.exists - mailbox.seen)
                        : (mailbox.recent || 0)
        const end = exists
        const start = Math.max(1, end - (limitN + offsetN))

        const messages = []
        const result = client.fetch(
          `${start}:${end}`,
          {
            uid: true, date: true, from: true, to: true, cc: true,
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
            date: toISO(msg.date),
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

    if (!state.account) {
      return res.status(404).json({ error: 'No account configured' })
    }

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
            uid: true, date: true, from: true, to: true, cc: true,
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
            await client.messageFlags(msg.uid, { add: ['\\Seen'], remove: [] }, { uid: true })
          } catch (e) { /* ignore */ }
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
          date: toISO(msg.date),
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
    if (!state.account) {
      return res.json({ folders: [] })
    }

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

    if (!state.account || !q) {
      return res.json({ messages: [], total: 0 })
    }

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
          uid: true, date: true, from: true, to: true,
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
            date: toISO(msg.date),
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
    const { id } = req.params
    const { folder = 'INBOX', add = [], remove = [] } = req.body

    if (!state.account) return res.status(400).json({ error: 'No account configured' })

    await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        if (add.length > 0 || remove.length > 0) {
          await client.messageFlags(Number(id), { add, remove }, { uid: true })
        }
        res.json({ success: true })
      } finally {
        lock.release()
      }
    })
  } catch (err) {
    console.error('Error updating flags:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/message/:id
router.delete('/message/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { folder = 'INBOX' } = req.query
    const { toTrash = false } = req.query

    if (!state.account) return res.status(400).json({ error: 'No account configured' })

    await pool.run(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        if (toTrash) {
          await client.messageMove(Number(id), 'Trash', { uid: true })
        } else {
          await client.messageDelete(Number(id), { uid: true })
        }
        res.json({ success: true })
      } finally {
        lock.release()
      }
    })
  } catch (err) {
    console.error('Error deleting message:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/message/:id/move
router.post('/message/:id/move', async (req, res) => {
  try {
    const { id } = req.params
    const { from = 'INBOX', to } = req.body

    if (!state.account || !to) return res.status(400).json({ error: 'from/to required' })

    await pool.run(async (client) => {
      const lock = await client.getMailboxLock(from)
      try {
        await client.messageMove(Number(id), to, { uid: true })
        res.json({ success: true })
      } finally {
        lock.release()
      }
    })
  } catch (err) {
    console.error('Error moving message:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/folder
router.post('/folder', async (req, res) => {
  try {
    const { name, parentId } = req.body
    if (!state.account || !name) return res.status(400).json({ error: 'name required' })

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
    if (!state.account || !from || !to) return res.status(400).json({ error: 'from and to required' })
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
    if (!state.account || !folderPath) return res.status(400).json({ error: 'path required' })

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

    if (!state.account) return res.status(404).json({ error: 'No account configured' })

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

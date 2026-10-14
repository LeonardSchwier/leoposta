import express from 'express'
import cors from 'cors'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import libmime from 'libmime'
import { simpleParser } from 'mailparser'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

// In-memory storage (for demo)
let account = null
let scheduledMessages = []

// Load account from file if exists
const ACCOUNT_FILE = path.join(__dirname, 'account.json')
if (fs.existsSync(ACCOUNT_FILE)) {
  account = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf-8'))
}

// Load scheduled messages
const SCHEDULED_FILE = path.join(__dirname, 'scheduled.json')
if (fs.existsSync(SCHEDULED_FILE)) {
  scheduledMessages = JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf-8'))
}

function saveAccount() {
  if (account) {
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2))
  }
}

function saveScheduled() {
  fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduledMessages, null, 2))
}

// Parse a single address string → { name, address }
function parseAddr(str) {
  if (!str) return { name: '', address: '' }
  const m = str.match(/^(?:"([^"]*)"|([^<\s]+))?\s*<?([@\w.-]+)>?\s*$/i)
  if (m) {
    return { name: m[1] || m[2] || '', address: m[3] || m[2] || '' }
  }
  // Fallback
  const at = str.split('@')
  return { name: '', address: str }
}

// Helper: extract addresses from IMAP response (varies in shape)
function extractAddrs(field) {
  if (!field) return []
  if (typeof field === 'string') return [field]
  if (Array.isArray(field)) {
    return field.map(f => {
      if (typeof f === 'string') return f
      if (f.address) return f.address
      return f
    }).filter(Boolean)
  }
  if (field.address) return [field.address]
  return [field]
}

// Create IMAP client
function createImapClient() {
  if (!account) throw new Error('No account configured')
  const isIP = /^[0-9.]+$/.test(account.imapHost)
  const servername = isIP ? 'imap.mailbox.org' : account.imapHost
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapTls,
    tls: {
      servername
    },
    auth: {
      user: account.imapUser || account.email,
      pass: account.imapPass
    },
    logger: false
  })
}

// Create SMTP transporter
function createSmtpTransporter() {
  if (!account) throw new Error('No account configured')
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpTls,
    auth: {
      user: account.smtpUser || account.email,
      pass: account.smtpPass
    }
  })
}

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    connected: !!account,
    account: account ? account.email : null,
    version: '0.1.0'
  })
})

// GET /api/account
app.get('/api/account', (req, res) => {
  if (!account) return res.json({ connected: false })
  // Don't leak password
  const safe = { ...account }
  delete safe.imapPass
  delete safe.smtpPass
  res.json(safe)
})

// POST /api/account
app.post('/api/account', (req, res) => {
  try {
    const { email, imapHost, imapPort, imapTls, imapUser, imapPass, smtpHost, smtpPort, smtpTls, smtpUser, smtpPass, name } = req.body
    account = {
      email, name: name || email,
      imapHost, imapPort: Number(imapPort) || 993, imapTls: imapTls !== false,
      imapUser, imapPass,
      smtpHost, smtpPort: Number(smtpPort) || 465, smtpTls: smtpTls !== false,
      smtpUser, smtpPass
    }
    saveAccount()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/account
app.delete('/api/account', (req, res) => {
  account = null
  try { fs.unlinkSync(ACCOUNT_FILE) } catch {}
  res.json({ success: true })
})

// GET /api/messages
app.get('/api/messages', async (req, res) => {
  try {
    const { folder = 'INBOX', limit = 50 } = req.query
    
    if (!account) {
      return res.json({ messages: [], unreadCount: 0 })
    }
    
    const client = createImapClient()
    await client.connect()
    
    const lock = await client.getMailboxLock(folder)
    
    try {
      const mailbox = client.mailbox
      const unreadCount = mailbox.exists - mailbox.seen
      
      const messages = []
      const result = client.fetch(
        `1:${Math.min(limit, mailbox.exists)}`,
        {
          uid: true,
          date: true,
          from: true,
          to: true,
          cc: true,
          bcc: true,
          subject: true,
          flags: true,
          envelope: true,
          bodyStructure: true
        },
        { op: 'FETCH' }
      )
      
      for await (const msg of result) {
        const from = parseAddr(msg.from?.[0]?.name || msg.from?.[0]?.address || msg.envelope?.from?.[0]?.address || '')
        const to = (msg.to || msg.envelope?.to || []).map(t => t.address)
        const cc = (msg.cc || msg.envelope?.cc || []).map(c => c.address)
        const bcc = (msg.bcc || []).map(b => b.address)
        
        // Count attachments from bodyStructure
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
        
        messages.push({
          id: msg.uid?.toString() || Date.now().toString(),
          from: from.name || from.address || '',
          fromAddress: from.address || '',
          to,
          cc,
          bcc,
          subject: msg.subject || msg.envelope?.subject || '(No Subject)',
          body: '',
          bodyHtml: '',
          snippet: '',
          date: msg.date?.toISOString() || new Date().toISOString(),
          flags: Array.isArray(msg.flags) ? msg.flags : (typeof msg.flags === 'object' && msg.flags !== null ? Object.keys(msg.flags).filter(k => msg.flags[k]) : []),
          hasAttachment: attachments.length > 0,
          attachmentCount: attachments.length,
          attachments,
          folder,
          headers: {}
        })
      }
      
      res.json({ messages, unreadCount })
    } finally {
      lock.release()
    }
    
    await client.logout()
  } catch (err) {
    console.error('Error fetching messages:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/message/:id
app.get('/api/message/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { folder = 'INBOX' } = req.query
    
    if (!account) {
      return res.status(404).json({ error: 'No account configured' })
    }
    
    const client = createImapClient()
    await client.connect()
    
    const lock = await client.getMailboxLock(folder)
    
    try {
      const msg = await (async () => {
        // IMAP proxy doesn't support UID in fetch, use sequence numbers
        // First get the UID-to-sequence mapping
        const uidResult = client.fetch('1:*', { uid: true }, { op: 'FETCH' })
        const uidMap = new Map()
        let seq = 0
        for await (const m of uidResult) {
          if (m.uid) uidMap.set(m.uid.toString(), ++seq)
        }
        const seqNum = uidMap.get(id)
        if (!seqNum) throw new Error('Message UID not found in mailbox')
        
        return client.fetchOne(seqNum.toString(), {
          uid: true,
          date: true,
          from: true,
          to: true,
          cc: true,
          bcc: true,
          subject: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          source: true
        })
      })()
      
      const from = parseAddr(msg.from?.[0]?.name || msg.from?.[0]?.address || msg.envelope?.from?.[0]?.address || '')
      const to = (msg.to || msg.envelope?.to || []).map(t => t.address)
      const cc = (msg.cc || msg.envelope?.cc || []).map(c => c.address)
      const bcc = (msg.bcc || []).map(b => b.address)
      
      // Parse body from source using libmime
      let body = ''
      let bodyHtml = ''
      const attachments = []
      
      if (msg.source) {
        try {
          const parsed = await simpleParser(msg.source.toString('utf-8'))
          
          if (parsed.html) {
            bodyHtml = parsed.html
          }
          if (parsed.text) {
            body = parsed.text
          }
          
          // Extract attachments
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
          // Fallback: raw source
          const raw = msg.source.toString('utf-8')
          if (raw.includes('<html') || raw.includes('<div') || raw.includes('<p')) {
            bodyHtml = raw
          } else {
            body = raw
          }
        }
      }
      
      // Mark as read
      const flags = msg.flags || []
      const isRead = Array.isArray(flags) ? flags.includes('\\Seen') || flags.includes('Seen') : false
      if (!isRead && msg.uid) {
        try {
          await client.messageFlagsAdd(msg.uid, ['\\Seen'])
        } catch (e) { /* ignore */ }
      }
      
      res.json({
        id: msg.uid?.toString() || id,
        from: from.name || from.address || '',
        fromAddress: from.address || '',
        to,
        cc,
        bcc,
        subject: msg.subject || msg.envelope?.subject || '(No Subject)',
        body,
        bodyHtml,
        date: msg.date?.toISOString() || new Date().toISOString(),
        flags: Array.isArray(msg.flags) ? msg.flags : (typeof msg.flags === 'object' && msg.flags !== null ? Object.keys(msg.flags).filter(k => msg.flags[k]) : []),
        attachments,
        folder,
        headers: {}
      })
    } finally {
      lock.release()
    }
    
    await client.logout()
  } catch (err) {
    console.error('Error fetching message:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/folders - List all mailboxes
app.get('/api/folders', async (req, res) => {
  try {
    if (!account) {
      return res.json({ folders: [] })
    }
    
    const client = createImapClient()
    await client.connect()
    
    const mailboxes = await client.list()
    const folders = mailboxes.map(mb => ({
      id: mb.path,
      name: mb.name,
      parentId: mb.parentPath ? mb.path.split(mb.name)[0].slice(0, -1) : null,
      specialUse: mb.specialUse || undefined,
      exists: mb.exists,
      unseen: mb.unseen
    }))
    
    await client.logout()
    res.json({ folders })
  } catch (err) {
    console.error('Error listing folders:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/search?q=...&folder=INBOX
app.get('/api/search', async (req, res) => {
  try {
    const { q, folder = 'INBOX', limit = 50 } = req.query
    
    if (!account || !q) {
      return res.json({ messages: [], total: 0 })
    }
    
    const client = createImapClient()
    await client.connect()
    const lock = await client.getMailboxLock(folder)
    
    try {
      // IMAP search: SUBJECT, FROM, TO, BODY
      const searchCriteria = [
        { SUBJECT: q },
      ]
      
      const uids = await client.search(searchCriteria, { uid: true })
      const searchUids = Array.isArray(uids) ? uids : [uids]
      
      if (searchUids.length === 0) {
        return res.json({ messages: [], total: 0 })
      }
      
      const resultUids = searchUids.slice(0, limit)
      const result = client.fetch(resultUids.map(String).join(':'), {
        uid: true,
        date: true,
        from: true,
        to: true,
        subject: true,
        flags: true,
        envelope: true
      }, { op: 'FETCH' })
      
      const messages = []
      for await (const msg of result) {
        const from = parseAddr(msg.from?.[0]?.name || msg.from?.[0]?.address || msg.envelope?.from?.[0]?.address || '')
        messages.push({
          id: msg.uid?.toString(),
          from: from.name || from.address || '',
          fromAddress: from.address || '',
          to: (msg.to || msg.envelope?.to || []).map(t => t.address),
          cc: (msg.cc || msg.envelope?.cc || []).map(c => c.address),
          bcc: [],
          subject: msg.subject || msg.envelope?.subject || '(No Subject)',
          body: '',
          bodyHtml: '',
          snippet: '',
          date: msg.date?.toISOString() || new Date().toISOString(),
          flags: Array.isArray(msg.flags) ? msg.flags : (typeof msg.flags === 'object' && msg.flags !== null ? Object.keys(msg.flags).filter(k => msg.flags[k]) : []),
          hasAttachment: false,
          attachmentCount: 0,
          attachments: [],
          folder,
          headers: {}
        })
      }
      
      res.json({ messages, total: searchUids.length })
    } finally {
      lock.release()
    }
    
    await client.logout()
  } catch (err) {
    console.error('Error searching:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/message/:id/flags
app.post('/api/message/:id/flags', async (req, res) => {
  try {
    const { id } = req.params
    const { folder = 'INBOX', add = [], remove = [] } = req.body
    
    if (!account) return res.status(400).json({ error: 'No account configured' })
    
    const client = createImapClient()
    await client.connect()
    const lock = await client.getMailboxLock(folder)
    
    try {
      if (add.length > 0) {
        await client.messageFlagsAdd(Number(id), add)
      }
      if (remove.length > 0) {
        await client.messageFlagsRemove(Number(id), remove)
      }
      res.json({ success: true })
    } finally {
      lock.release()
    }
    
    await client.logout()
  } catch (err) {
    console.error('Error updating flags:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/message/:id?folder=INBOX
app.delete('/api/message/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { folder = 'INBOX' } = req.query
    const { toTrash = false } = req.query
    
    if (!account) return res.status(400).json({ error: 'No account configured' })
    
    const client = createImapClient()
    await client.connect()
    const lock = await client.getMailboxLock(folder)
    
    try {
      if (toTrash) {
        // Move to Trash
        await client.messageMove(Number(id), 'Trash')
      } else {
        await client.messageDelete(Number(id))
      }
      res.json({ success: true })
    } finally {
      lock.release()
    }
    
    await client.logout()
  } catch (err) {
    console.error('Error deleting message:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/message/:id/move
app.post('/api/message/:id/move', async (req, res) => {
  try {
    const { id } = req.params
    const { from = 'INBOX', to } = req.body
    
    if (!account || !to) return res.status(400).json({ error: 'from/to required' })
    
    const client = createImapClient()
    await client.connect()
    const lock = await client.getMailboxLock(from)
    
    try {
      await client.messageMove(Number(id), to)
      res.json({ success: true })
    } finally {
      lock.release()
    }
    
    await client.logout()
  } catch (err) {
    console.error('Error moving message:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/folder - Create folder
app.post('/api/folder', async (req, res) => {
  try {
    const { name, parentId } = req.body
    if (!account || !name) return res.status(400).json({ error: 'name required' })
    
    const client = createImapClient()
    await client.connect()
    
    const folderPath = parentId ? `${parentId}/${name}` : name
    await client.mailboxCreate(folderPath)
    
    await client.logout()
    res.json({ success: true, path: folderPath })
  } catch (err) {
    console.error('Error creating folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/folder?path=...
app.delete('/api/folder', async (req, res) => {
  try {
    const { path: folderPath } = req.query
    if (!account || !folderPath) return res.status(400).json({ error: 'path required' })
    
    const client = createImapClient()
    await client.connect()
    
    await client.mailboxDelete(folderPath)
    
    await client.logout()
    res.json({ success: true })
  } catch (err) {
    console.error('Error deleting folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/send
app.post('/api/send', async (req, res) => {
  try {
    const { to, cc, bcc, subject, body, bodyHtml, scheduled, attachments } = req.body
    
    if (!account) {
      return res.status(400).json({ error: 'No account configured' })
    }
    
    if (!to || to.length === 0) {
      return res.status(400).json({ error: 'At least one recipient is required' })
    }
    
    const messageData = {
      from: `"${account.name}" <${account.email}>`,
      to: to.join(', '),
      cc: cc?.join(', '),
      bcc: bcc?.join(', '),
      subject: subject || '(No Subject)',
      text: body || '',
      html: bodyHtml || body || ''
    }
    
    // Attachments (base64 data)
    if (attachments && attachments.length > 0) {
      messageData.attachments = attachments.map(a => ({
        filename: a.filename,
        content: a.content, // base64
        contentType: a.contentType || 'application/octet-stream'
      }))
    }
    
    if (scheduled) {
      const msg = {
        id: Date.now().toString(),
        ...messageData,
        scheduled: new Date(scheduled).toISOString(),
        status: 'pending'
      }
      scheduledMessages.push(msg)
      saveScheduled()
      res.json({ success: true, scheduled: true })
    } else {
      const transporter = createSmtpTransporter()
      const info = await transporter.sendMail(messageData)
      res.json({ success: true, messageId: info.messageId })
    }
  } catch (err) {
    console.error('Error sending message:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/idle - SSE stream for real-time inbox updates
app.get('/api/idle', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  })
  res.write('event: connected\ndata: {"status":"connected"}\n\n')
  
  if (!account) {
    res.write('event: error\ndata: {"error":"No account configured"}\n\n')
    res.end()
    return
  }
  
  let client
  let lock
  try {
    client = createImapClient()
    await client.connect()
    lock = await client.getMailboxLock('INBOX')
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`)
    res.end()
    return
  }
  
  client.on('mailbox', () => {
    res.write('event: mailbox-update\ndata: {"type":"new-messages"}\n\n')
  })
  client.on('expunge', () => {
    res.write('event: mailbox-update\ndata: {"type":"expunge"}\n\n')
  })
  client.on('fetch', () => {
    res.write('event: mailbox-update\ndata: {"type":"fetch"}\n\n')
  })
  
  try {
    await client.idle({ maxTimeout: 29 * 60 * 1000 })
  } catch (err) {
    res.write(`event: idle-end\ndata: ${JSON.stringify({ reason: err.message })}\n\n`)
  }
  
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch (e) {}
  }, 25000)
  
  req.on('close', () => {
    clearInterval(heartbeat)
    try { client.idle.stop() } catch (e) {}
    if (lock) lock.release()
    client.logout().catch(() => {})
  })
})

// GET /api/message/:id/attachment/:partId?folder=INBOX
app.get('/api/message/:id/attachment/:partId', async (req, res) => {
  try {
    const { id, partId } = req.params
    const { folder = 'INBOX' } = req.query
    
    if (!account) return res.status(404).json({ error: 'No account configured' })
    
    const client = createImapClient()
    await client.connect()
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
    await client.logout()
  } catch (err) {
    console.error('Error downloading attachment:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    }
  }
})

// GET /api/scheduled
app.get('/api/scheduled', (req, res) => {
  res.json({ messages: scheduledMessages })
})

// DELETE /api/scheduled/:id
app.delete('/api/scheduled/:id', (req, res) => {
  const idx = scheduledMessages.findIndex(m => m.id === req.params.id)
  if (idx !== -1) {
    scheduledMessages.splice(idx, 1)
    saveScheduled()
    res.json({ success: true })
  } else {
    res.status(404).json({ error: 'Message not found' })
  }
})

// Scheduled message processor
function processScheduledMessages() {
  const now = new Date()
  const dueMessages = scheduledMessages.filter(m => m.status === 'pending' && new Date(m.scheduled) <= now)
  
  for (const msg of dueMessages) {
    sendScheduledMessage(msg).then(() => {
      msg.status = 'sent'
      saveScheduled()
    }).catch(err => {
      console.error('Error sending scheduled message:', err)
      msg.status = 'failed'
      saveScheduled()
    })
  }
}

async function sendScheduledMessage(msg) {
  if (!account) throw new Error('No account configured')
  
  const messageData = {
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    text: msg.text,
    html: msg.html
  }
  
  const transporter = createSmtpTransporter()
  await transporter.sendMail(messageData)
}

// Process scheduled messages every 30 seconds
setInterval(processScheduledMessages, 30000)

// Start server
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Mail server running on port ${PORT}`)
  console.log(`Account: ${account ? account.email : 'not configured'}`)
  console.log(`Scheduled messages: ${scheduledMessages.length}`)
})

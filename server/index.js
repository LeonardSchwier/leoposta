import express from 'express'
import cors from 'cors'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import libmime from 'libmime'
import { simpleParser } from 'mailparser'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as openpgp from 'openpgp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Server-side scrub for outbound HTML (defense-in-depth; the client also
// sanitizes on render). Strips <script>/<style>/on*-handlers/executable
// data: URIs so pasted attacker content is not delivered live to recipients.
function scrubOutboundHtml(html) {
  if (typeof html !== 'string' || !html) return html
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<(iframe|object|embed|form|link|meta|base|svg|math)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href)\s*=\s*("|')\s*(?:javascript|vbscript|data)\s*?:[^"']*(")/gi, '$1=$2#$4')
}

const app = express()
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001').split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({ origin: (origin, cb) => { if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true); cb(new Error('Not allowed by CORS'), false) } }))
app.use(express.json({ limit: '50mb' }))

// In-memory storage (for demo)
let account = null
let scheduledMessages = []

// Helper: normalize IMAP flags to an array
function normalizeFlags(flags) {
  if (Array.isArray(flags)) return flags
  if (flags && typeof flags === 'object') return Object.keys(flags).filter(k => flags[k])
  return []
}

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
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 })
  }
}

function saveScheduled() {
  fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduledMessages, null, 2), { mode: 0o600 })
}

// Parse a single address string → { name, address }
function parseAddr(str) {
  if (!str) return { name: '', address: '' }
  // Handle "Display Name <email@domain>" format
  const m = str.match(/^"([^"]*)"?\s*<([^>]+)>/i)
  if (m) {
    return { name: m[1] || '', address: m[2].trim() }
  }
  // Handle plain email@domain (no angle brackets)
  const plain = str.match(/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i)
  if (plain) {
    return { name: '', address: str.trim() }
  }
  // Handle "Name email@domain" (no quotes, no brackets)
  const noBrk = str.match(/^(.*?)\s+([\w.+-]+@[\w.-]+\.[a-z]{2,})$/i)
  if (noBrk) {
    return { name: noBrk[1].trim(), address: noBrk[2].trim() }
  }
  // Fallback: if it contains @, treat as address
  if (str.includes('@')) {
    return { name: '', address: str.trim() }
  }
  // Just a name, no address
  return { name: str.trim(), address: '' }
}

// Helper: parse ImapFlow's from field (object with name/address) or string
function parseFromAddr(fromField) {
  if (!fromField) return { name: '', address: '' }
  if (typeof fromField === 'string') return parseAddr(fromField)
  if (fromField.address) {
    return { name: fromField.name || '', address: fromField.address }
  }
  if (fromField[0]) return parseFromAddr(fromField[0])
  return { name: '', address: '' }
}

// Helper: coerce IMAP date to ISO string (imapflow may give Date or string)
function toISO(d) {
  if (!d) return new Date().toISOString()
  if (d instanceof Date && !isNaN(d.getTime())) return d.toISOString()
  const t = new Date(d).getTime()
  if (!isNaN(t)) return new Date(t).toISOString()
  return new Date().toISOString()
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
  const servername = isIP ? 'imap.example.com' : account.imapHost
  const client = new ImapFlow({
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
  // ImapFlow emits 'error' (e.g. ETIMEOUT / socket reset) as a Node EventEmitter.
  // Without a listener this becomes an uncaughtException and crashes the whole
  // process. Instead: log it, disconnect cleanly so the shared pool can
  // reconnect on the next request. Never rethrow.
  client.on('error', (err) => {
    console.error('ImapFlow error:', err && err.code ? `${err.code} ` : '', (err && err.message) || err)
    if (typeof client.logout === 'function') {
      const p = client.logout()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  })
  // When the socket closes on its own (server-side timeout), drop the pooled
  // client if this is it, so the next request reconnects fresh.
  client.on('close', () => {
    if (pool.client === client) { pool.client = null; pool.connectP = null }
  })
  return client
}

// Shared IMAP client
// example.com (and most shared IMAP providers) rate-limit newly-opened
// sessions. The previous design opened a fresh connection for EVERY API
// request, so bursty UI activity was hitting 'NO' -> "Command failed".
// We now keep ONE authenticated connection for all REST IMAP operations and
// only tear it down + reconnect when it actually breaks. The /api/idle
// endpoint keeps its own dedicated long-lived connection (correct as-is).

function safeLogout(c) {
  const p = c && typeof c.logout === 'function' ? c.logout() : null
  if (p && typeof p.catch === 'function') p.catch(() => {})
}

const pool = {
  client: null,
  connectP: null,
  queue: Promise.resolve(),
  async ensure() {
    if (this.client && this.client.user) return this.client
    if (!this.connectP) {
      this.connectP = (async () => {
        const client = createImapClient()
        try { await client.connect() } catch (e) { safeLogout(client); throw e }
        return client
      })()
    }
    const c = await this.connectP
    this.client = c
    this.connectP = null
    return c
  },
   // Shared connection mailbox is per-connection global, so REST ops must
   // be serialized. Reconnects + retries on transient failures.
   async _exec(fn, retry) {
    let lastErr
    for (let i = 0; i < retry; i++) {
      const c = await this.ensure()
      try {
        return await fn(c)
      } catch (e) {
        lastErr = e
        const resp = e && e.responseText ? String(e.responseText) : ''
        const authThrottled = e && (e.authenticationFailed || /\[UNAVAILABLE\]\s*Temporary authentication failure/i.test(resp))
        const transient = !authThrottled && (
          String(e && e.message || '') === 'Command failed'
          || String(e && e.message || '').includes('socket was closed unexpectedly')
          || String(e && e.message || '').includes('No response to command')
          || !c.user
        )
        if (!transient || authThrottled) {
          // Keep the pool clean even on auth throttle so the next attempt
          // (after the user retries later) doesn't reuse a broken session.
          const wasOurs = this.client === c
          safeLogout(c)
          if (wasOurs) { this.client = null; this.connectP = null }
          throw e
        }
        const wasOurs = this.client === c
        safeLogout(c)
        if (wasOurs) { this.client = null; this.connectP = null }
        await new Promise(r => setTimeout(r, 300 * (i + 1)))
      }
    }
    throw lastErr
  },
  run(fn, retry = 4) {
    const prev = this.queue || Promise.resolve()
    const next = prev.then(() => this._exec(fn, retry))
    // Keep queue alive even if this op rejects; next op still enqueues.
    this.queue = next.catch(() => {})
    return next
  },
  async reset() {
    const c = this.client
    this.client = null
    this.connectP = null
    if (c) safeLogout(c)
  }
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
  const { imapPass, smtpPass, ...safe } = account
  if (!safe.signature) safe.signature = { enabled: false, text: '', position: 'standard' }
  res.json(safe)
})

// POST /api/account
app.post('/api/account', (req, res) => {
  try {
    const { email, imapHost, imapPort, imapTls, imapUser, imapPass, smtpHost, smtpPort, smtpTls, smtpUser, smtpPass, name, signature } = req.body
    account = {
      email, name: name || email,
      imapHost, imapPort: Number(imapPort) || 993, imapTls: imapTls !== false,
      imapUser, imapPass,
      smtpHost, smtpPort: Number(smtpPort) || 465, smtpTls: smtpTls !== false,
      smtpUser, smtpPass,
      signature: signature || { enabled: false, text: '', position: 'standard' }
    }
    saveAccount()
    pool.reset().catch(() => {})
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/account
app.delete('/api/account', (req, res) => {
  account = null
  try { fs.unlinkSync(ACCOUNT_FILE) } catch {}
  pool.reset().catch(() => {})
  res.json({ success: true })
})

// GET /api/messages
app.get('/api/messages', async (req, res) => {
  try {
    const { folder = 'INBOX', limit = 100, offset = 0 } = req.query
    const limitN = Math.min(Math.max(1, Number(limit) || 100), 200)
    const offsetN = Math.max(0, Number(offset) || 0)

    if (!account) {
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
          uid: true,
          date: true,
          from: true,
          to: true,
          cc: true,
          subject: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          'in-reply-to': true,
          'references': true
        },
        { op: 'FETCH' }
       )
       
      for await (const msg of result) {
        const from = parseFromAddr(msg.from?.[0] || msg.envelope?.from?.[0])
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
        
        // Derive thread ID from In-Reply-To or References
        const inReplyTo = msg['in-reply-to'] || msg['In-Reply-To'] || ''
        const references = msg['references'] || msg['References'] || ''
        const refIds = references.split('<').filter(Boolean)
        const threadId = inReplyTo || (refIds.length > 0 ? '<' + refIds[refIds.length - 1] : '') || (msg.uid?.toString() || Date.now().toString())
        
        messages.push({
          id: msg.uid?.toString() || Date.now().toString(),
          threadId: threadId,
          from: from.name || from.address || '',
          fromAddress: from.address || '',
          to,
          cc,
          bcc,
           subject: msg.subject || msg.envelope?.subject || '(No Subject)',
           body: '',
           bodyHtml: '',
           snippet: '',
           date: toISO(msg.date),
           flags: normalizeFlags(msg.flags),
           hasAttachment: attachments.length > 0,
           attachmentCount: attachments.length,
           attachments,
           folder,
           headers: {}
        })
      }
      
       messages.sort((a, b) => new Date(b.date) - new Date(a.date))
        res.json({ messages, unreadCount })
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
app.get('/api/message/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { folder = 'INBOX' } = req.query
    
    if (!account) {
      return res.status(404).json({ error: 'No account configured' })
    }
    
 await pool.run(async (client) => {
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
      
      const from = parseFromAddr(msg.from?.[0] || msg.envelope?.from?.[0])
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
        to,
        cc,
        bcc,
        subject: msg.subject || msg.envelope?.subject || '(No Subject)',
        body: finalBody,
        bodyHtml: finalHtml,
        pgp: pgp || null,
        date: toISO(msg.date),
        flags: normalizeFlags(msg.flags),
        attachments: finalAttachments,
        folder,
        headers: {}
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

// GET /api/folders - List all mailboxes
app.get('/api/folders', async (req, res) => {
  try {
    if (!account) {
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

// GET /api/search?q=...&folder=INBOX
app.get('/api/search', async (req, res) => {
  try {
    const { q, folder = 'INBOX', limit = 50 } = req.query
    
    if (!account || !q) {
      return res.json({ messages: [], total: 0 })
    }
    
 await pool.run(async (client) => {
    const lock = await client.getMailboxLock(folder)
    try {
      // IMAP search: SUBJECT
      const searchCriteria = { SUBJECT: q }
      
      const uids = await client.search(searchCriteria, { uid: true })
      const searchUids = Array.isArray(uids) ? uids : [uids]
      
      if (searchUids.length === 0) {
        return res.json({ messages: [], total: 0 })
      }
      
      const resultUids = searchUids.slice(0, limit)
      const result = client.fetch(resultUids, {
        uid: true,
        date: true,
        from: true,
        to: true,
        subject: true,
        flags: true,
        envelope: true
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
          body: '',
          bodyHtml: '',
           snippet: '',
           date: toISO(msg.date),
           flags: normalizeFlags(msg.flags),
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
  })
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

// DELETE /api/message/:id?folder=INBOX
app.delete('/api/message/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { folder = 'INBOX' } = req.query
    const { toTrash = false } = req.query
    
    if (!account) return res.status(400).json({ error: 'No account configured' })
    
 await pool.run(async (client) => {
    const lock = await client.getMailboxLock(folder)
    try {
      if (toTrash) {
        // Move to Trash
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
app.post('/api/message/:id/move', async (req, res) => {
  try {
    const { id } = req.params
    const { from = 'INBOX', to } = req.body
    
    if (!account || !to) return res.status(400).json({ error: 'from/to required' })
    
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

// POST /api/folder - Create folder
app.post('/api/folder', async (req, res) => {
  try {
    const { name, parentId } = req.body
    if (!account || !name) return res.status(400).json({ error: 'name required' })
    
    const folderPath = parentId ? `${parentId}/${name}` : name
    await pool.run(async (client) => { await client.mailboxCreate(folderPath) })
    res.json({ success: true, path: folderPath })
  } catch (err) {
    console.error('Error creating folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/folder/rename - Rename folder
app.post('/api/folder/rename', async (req, res) => {
  try {
    const { from, to } = req.body || {}
    if (!account || !from || !to) return res.status(400).json({ error: 'from and to required' })
    await pool.run(async (client) => { await client.mailboxRename(from, to) })
    res.json({ success: true, path: to })
  } catch (err) {
    console.error('Error renaming folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/folder?path=...
app.delete('/api/folder', async (req, res) => {
  try {
    const { path: folderPath } = req.query
    if (!account || !folderPath) return res.status(400).json({ error: 'path required' })
    
    await pool.run(async (client) => { await client.mailboxDelete(folderPath) })
    res.json({ success: true })
  } catch (err) {
    console.error('Error deleting folder:', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------- WebDAV/CalDAV/CardDAV client (https, Basic auth) ----------
import https from 'https'
import http from 'http'

const DAV_HOST = process.env.DAV_HOST || 'dav.example.com'
const DAV_PORT = parseInt(process.env.DAV_PORT || '443', 10)
const DAV_TLS = (process.env.DAV_TLS || (process.env.DAV_HOST ? 'true' : 'false')) === 'true'
const DAV_PATH_PREFIX = (user) => (process.env.DAV_PREFIX || '/dav/' + user)

function davRequest(method, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const user = account && account.imapUser ? account.imapUser : ''
    const pass = account && account.imapPass ? account.imapPass : ''
    const token = Buffer.from(`${user}:${pass}`).toString('base64')
    const opts = {
      hostname: DAV_HOST,
      port: DAV_PORT,
      path: urlPath,
      method,
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': contentType || 'application/xml; charset="utf-8"',
        'Depth': '1'
      }
    }
    if (contentType === 'text/xml') opts.headers['Content-Type'] = contentType
    const lib = DAV_TLS ? https : http
    const req = lib.request(opts, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data, headers: res.headers })
        } else {
          reject(new Error(`DAV ${method} ${urlPath} → ${res.statusCode}: ${data.slice(0, 300)}`))
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// Parse a simple XML response to extract text nodes by tag
function xmlParseNodes(xml, parentTag, childTag) {
  const results = []
  const re = new RegExp(`<${parentTag}[\\s>][\\s\\S]*?<${childTag}[^>]*>([\\s\\S]*?)</${childTag}>`, 'g')
  let m
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim())
  if (results.length) return results
  // try simpler: <parentTag> ... <childTag>text</childTag> ... </parentTag>
  const re2 = new RegExp(`<${parentTag}[^>]*>([\\s\\S]*?)</${parentTag}>`, 'g')
  while ((m = re2.exec(xml)) !== null) {
    const inner = m[1]
    const cm = inner.match(new RegExp(`<${childTag}[^>]*>([\\s\\S]*?)</${childTag}>`))
    if (cm) results.push(cm[1].trim())
  }
  return results
}

function extractResponseSet(xml) {
  // Extract <response> blocks: href, displayname, calendar-timezone, etag
  const responses = []
  const respRe = /<response>([\s\S]*?)<\/response>/g
  let m
  while ((m = respRe.exec(xml)) !== null) {
    const inner = m[1]
    const href = (inner.match(/<href>([\s\S]*?)<\/href>/) || [])[1] || ''
    const displayname = (inner.match(/<displayname[^>]*>([\s\S]*?)<\/displayname>/) || [])[1] || ''
    const etag = (inner.match(/<etag>([\s\S]*?)<\/etag>/) || [])[1] || ''
    if (href) responses.push({ href: href.trim(), displayname: displayname.trim(), etag: (etag.trim() || '').replace(/"/g, '') })
  }
  return responses
}

// ===== CalDAV endpoints =====

// GET /api/calendar/calendars
app.get('/api/calendar/calendars', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    const profindXml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:calendar-timezone/>
  </d:prop>
</d:propfind>`
    const r = await davRequest('PROPFIND', basePath, profindXml)
    const entries = extractResponseSet(r.body).filter(e => e.displayname || /\/calendars\//.test(e.href))
    // Filter to only calendar resources (skip root)
    const calendars = entries.filter(e => e.displayname)
    res.json({ calendars })
  } catch (err) {
    console.error('CalDAV calendars error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/calendar/events?calendar=<id>&start=<ISO>&end=<ISO>
app.get('/api/calendar/events', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const { calendar, start, end } = req.query
    if (!calendar) return res.status(400).json({ error: 'calendar param required' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    const startTz = '20260101T000000Z'
    const endTz = '20261231T235959Z'
    const reportXml = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <d:getcontenttype/>
    <d:getcontentlength/>
  </d:prop>
  <d:prop>
    <c:calendar-data/>
  </d:prop>
</c:calendar-multiget>`
    // Use REPORT to query
    const report = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <d:getcontenttype/>
  </d:prop>
  <c:filter>
    <c:time-range start="${start || ''}" end="${end || ''}"/>
  </c:filter>
</c:calendar-query>`
    const urlPath = `${basePath}/${calendar.replace(/^\/+|\/+$/g, '')}`
    const r = await davRequest('REPORT', urlPath, report)
    const resources = extractResponseSet(r.body).filter(e => /ics/i.test(e.href))
    // Fetch each event's ICS content
    const events = []
    for (const ev of resources) {
      const evPath = ev.href.startsWith('/') ? ev.href : `/${ev.href}`
      try {
        const evRes = await davRequest('GET', evPath, null, null)
        const ics = evRes.body
        // Parse minimal VEVENT: SUMMARY, DTSTART, DTEND, UID
        const uid = (ics.match(/UID:(.+)/) || [])[1] || evPath
        const summary = (ics.match(/SUMMARY:(.+)/) || [])[1] || '(no subject)'
        const dtstart = (ics.match(/DTSTART[;TZID=[^;]*;?[^:]*:(.+)/) || [])[1] || ''
        const dtend = (ics.match(/DTEND[;TZID=[^;]*;?[^:]*:(.+)/) || [])[1] || ''
        const location = (ics.match(/LOCATION:(.+)/) || [])[1] || ''
        const description = (ics.match(/DESCRIPTION:(.+)/) || [])[1] || ''
        events.push({ uid: uid.trim(), summary: summary.trim(), start: dtstart.trim(), end: dtend.trim(), location: location.trim(), description: description.trim(), etag: evRes.headers.etag || '', href: ev.href, ics })
      } catch {}
    }
    res.json({ events })
  } catch (err) {
    console.error('CalDAV events error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/calendar/event  (create or update)
app.put('/api/calendar/event', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const { calendar, ics, uid } = req.body || {}
    if (!calendar || !ics) return res.status(400).json({ error: 'calendar and ics required' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    const urlPath = `${basePath}/${calendar.replace(/^\/+|\/+$/g, '')}/${uid || Date.now()}.ics`
    const r = await davRequest('PUT', urlPath, ics, 'text/calendar; charset=utf-8')
    res.json({ success: true, uid: uid || urlPath.split('/').pop().replace('.ics',''), etag: r.headers.etag || '' })
  } catch (err) {
    console.error('CalDAV event PUT error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/calendar/event  (delete)
app.delete('/api/calendar/event', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const { calendar, uid } = req.query
    if (!calendar || !uid) return res.status(400).json({ error: 'calendar and uid required' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    const urlPath = `${basePath}/${calendar.replace(/^\/+|\/+$/g, '')}/${uid}.ics`
    await davRequest('DELETE', urlPath, null, null)
    res.json({ success: true })
  } catch (err) {
    console.error('CalDAV event DELETE error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/calendar/import  (ICS import)
app.post('/api/calendar/import', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const { calendar, ics } = req.body || {}
    if (!calendar || !ics) return res.status(400).json({ error: 'calendar and ics required' })
    // Parse VEVENTs from ICS
    const lines = ics.replace(/\r\n/g, '\n').replace(/\\n/g, '\n').split('\n')
    const events = []
    let current = null
    for (const line of lines) {
      if (line.startsWith('BEGIN:VEVENT')) current = { lines: [] }
      else if (line.startsWith('END:VEVENT')) { if (current) { events.push(current.lines.join('\n')); current = null } }
      else if (current) current.lines.push(line)
    }
    if (!events.length) return res.status(400).json({ error: 'No VEVENT found in ICS' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    let imported = 0
    for (const ev of events) {
      const uidMatch = ev.match(/UID:(.+)/)
      const uid = uidMatch ? uidMatch[1].trim() : Date.now() + imported
      const urlPath = `${basePath}/${calendar.replace(/^\/+|\/+$/g, '')}/${uid}.ics`
      // Wrap in full VCALENDAR if not present
      let full = ev
      if (!ev.includes('BEGIN:VCALENDAR')) {
        full = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//leoposta//EN\r\n${ev}\r\nEND:VCALENDAR`
      }
      try {
        await davRequest('PUT', urlPath, full, 'text/calendar; charset=utf-8')
        imported++
      } catch {}
    }
    res.json({ success: true, imported, total: events.length })
  } catch (err) {
    console.error('CalDAV import error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ===== CardDAV endpoints =====

// GET /api/contacts/calendars  (list address books)
app.get('/api/contacts/calendars', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    const profindXml = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:crd="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`
    const r = await davRequest('PROPFIND', basePath, profindXml)
    const entries = extractResponseSet(r.body)
    const books = entries.filter(e => /addressbooks/i.test(e.href) && e.displayname)
    res.json({ addressBooks: books })
  } catch (err) {
    console.error('CardDAV calendars error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/contacts?book=<id>&q=<query>
app.get('/api/contacts', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const { book, q } = req.query
    if (!book) return res.status(400).json({ error: 'book param required' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    // PROPFIND to list all .vcf files
    const profind = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getetag/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>`
    const urlPath = `${basePath}/${book.replace(/^\/+|\/+$/g, '')}`
    const r = await davRequest('PROPFIND', urlPath, profind)
    const entries = extractResponseSet(r.body).filter(e => /\.vcf/i.test(e.href))
    // Fetch each contact
    const contacts = []
    for (const c of entries) {
      try {
        const vcfPath = c.href.startsWith('/') ? c.href : `/${c.href}`
        const vres = await davRequest('GET', vcfPath, null, null)
        const vcf = vres.body
        const fn = (vcf.match(/FN:(.+)/) || [])[1] || c.displayname || '(unknown)'
        const email = (vcf.match(/EMAIL[^:]*:(.+)/) || [])[1] || ''
        const phone = (vcf.match(/TEL[^:]*:(.+)/) || [])[1] || ''
        const uid = (vcf.match(/UID:(.+)/) || [])[1] || c.href.split('/').pop()
        const org = (vcf.match(/ORG:(.+)/) || [])[1] || ''
        contacts.push({ uid: uid.trim(), name: fn.trim(), email: email.trim(), phone: phone.trim(), org: org.trim().split(';')[0], vcf, href: c.href, etag: vres.headers.etag || '' })
      } catch {}
    }
    // Filter
    let filtered = contacts
    if (q) {
      const lq = q.toLowerCase()
      filtered = contacts.filter(c => c.name.toLowerCase().includes(lq) || c.email.toLowerCase().includes(lq))
    }
    filtered.sort((a, b) => a.name.localeCompare(b.name))
    res.json({ contacts: filtered, total: contacts.length })
  } catch (err) {
    console.error('CardDAV contacts error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/contact  (create or update a contact)
app.put('/api/contact', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const { book, vcf } = req.body || {}
    if (!book || !vcf) return res.status(400).json({ error: 'book and vcf required' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    const uidMatch = vcf.match(/UID:(.+)/)
    const uid = uidMatch ? uidMatch[1].trim() : ('leoposta_' + Date.now())
    const urlPath = `${basePath}/${book.replace(/^\/+|\/+$/g, '')}/${uid}.vcf`
    const r = await davRequest('PUT', urlPath, vcf, 'text/vcard; charset=utf-8')
    res.json({ success: true, uid, etag: r.headers.etag || '' })
  } catch (err) {
    console.error('CardDAV contact PUT error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/contact?book=<id>&uid=<uid>
app.delete('/api/contact', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const { book, uid } = req.query
    if (!book || !uid) return res.status(400).json({ error: 'book and uid required' })
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    const urlPath = `${basePath}/${book.replace(/^\/+|\/+$/g, '')}/${uid}.vcf`
    await davRequest('DELETE', urlPath, null, null)
    res.json({ success: true })
  } catch (err) {
    console.error('CardDAV contact DELETE error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/contacts/import  (VCF import)
app.post('/api/contacts/import', async (req, res) => {
  try {
    if (!account) return res.status(400).json({ error: 'No account configured' })
    const { book, vcf } = req.body || {}
    if (!book || !vcf) return res.status(400).json({ error: 'book and vcf required' })
    // Split vCard by BEGIN:VCARD
    const parts = vcf.split(/BEGIN:VCARD/).filter(p => p.includes('VERSION:'))
    const basePath = DAV_PATH_PREFIX(account.imapUser)
    let imported = 0
    for (const part of parts) {
      const card = 'BEGIN:VCARD' + part
      const uidMatch = card.match(/UID:(.+)/)
      const uid = uidMatch ? uidMatch[1].trim() : ('leoposta_' + Date.now() + imported)
      const urlPath = `${basePath}/${book.replace(/^\/+|\/+$/g, '')}/${uid}.vcf`
      try {
        await davRequest('PUT', urlPath, card, 'text/vcard; charset=utf-8')
        imported++
      } catch {}
    }
    res.json({ success: true, imported, total: parts.length })
  } catch (err) {
    console.error('CardDAV import error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ---------- PGP: key storage + per-message decryption ----------
const PGP_PRIVATE_FILE = path.join(__dirname, 'pgp_private.asc')
const PGP_PUBLIC_FILE  = path.join(__dirname, 'pgp_publics.asc')
const PGP_PASS_FILE    = path.join(__dirname, 'pgp_passphrase.txt')
const PGP_ARMOR_RE     = /-----BEGIN PGP (?:MESSAGE|SIGNED MESSAGE|ENCRYPTED MESSAGE)[\s\S]*?-----END PGP (?:MESSAGE|SIGNED MESSAGE|ENCRYPTED MESSAGE)[\s\S]*?-----/

function pgpState() {
  return {
    hasPrivateKey: fs.existsSync(PGP_PRIVATE_FILE),
    hasPublicKey:  fs.existsSync(PGP_PUBLIC_FILE),
    hasPassphrase: fs.existsSync(PGP_PASS_FILE)
  }
}

async function savePgp({ privateAsc, publicAsc, passphrase }) {
  if (privateAsc) {
    await openpgp.readPrivateKey({ armoredKey: privateAsc })
    fs.writeFileSync(PGP_PRIVATE_FILE, privateAsc.trim() + '\n', { mode: 0o600 })
  }
  if (publicAsc) {
    await openpgp.readKey({ armoredKey: publicAsc })
    const trimmed = publicAsc.trim()
    const existing = fs.existsSync(PGP_PUBLIC_FILE) ? fs.readFileSync(PGP_PUBLIC_FILE, 'utf-8') : ''
    if (!existing.includes(trimmed)) {
      fs.writeFileSync(PGP_PUBLIC_FILE, (existing ? existing.replace(/\s+$/, '') + '\n\n' : '') + trimmed + '\n')
    }
  }
  if (passphrase !== undefined) {
    if (passphrase) fs.writeFileSync(PGP_PASS_FILE, passphrase, { mode: 0o600 })
    else if (fs.existsSync(PGP_PASS_FILE)) fs.unlinkSync(PGP_PASS_FILE)
  }
  return pgpState()
}

function deletePgp() {
  for (const f of [PGP_PRIVATE_FILE, PGP_PUBLIC_FILE, PGP_PASS_FILE]) {
    try { fs.unlinkSync(f) } catch {}
  }
  return pgpState()
}

// Returns null if body has no PGP armor; otherwise a status object.
async function processPgp(plainBody) {
  if (!plainBody || !PGP_ARMOR_RE.test(plainBody)) return null
  const armored = plainBody.match(PGP_ARMOR_RE)[0]
  if (/BEGIN PGP (?:PUBLIC|PRIVATE) KEY/.test(armored)) {
    return { encrypted: false, isKey: true, armored }
  }
  if (!fs.existsSync(PGP_PRIVATE_FILE)) {
    return { encrypted: true, decrypted: false, armored, error: 'No PGP private key configured' }
  }
  try {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: fs.readFileSync(PGP_PRIVATE_FILE, 'utf-8') })
    const passphrase = fs.existsSync(PGP_PASS_FILE) ? fs.readFileSync(PGP_PASS_FILE, 'utf-8').trim() || undefined : undefined
    const decryptedKey = passphrase
      ? await openpgp.decryptKey({ privateKey, passphrase })
      : privateKey
    const msg = await openpgp.readMessage({ armoredMessage: armored })
    const { data } = await openpgp.decrypt({ message: msg, decryptionKeys: [decryptedKey] })
    const mime = await data.toString()
    // The decrypted payload is itself a MIME message — parse it for html/text/attachments
    let text = '', html = ''
    const attachments = []
    try {
      const parsed = await simpleParser(mime)
      text = (parsed.text || '').replace(/[\u200C\u200D\u200B-\u200F\uFEFF]/g, '')
      html = parsed.html || ''
      for (const att of parsed.attachments || []) {
        attachments.push({
          id: att.filename || 'attachment',
          filename: att.filename,
          contentType: att.contentType || att.mimeType || '',
          size: att.content?.length || 0,
          contentId: att.contentId || undefined
        })
      }
    } catch {}
    if (!text && !html) { text = mime.trim() }
    let signed = false, verified = null, signer = null
    try {
      const sigs = msg.getSigningKeyIDs()
      if (sigs && sigs.length) {
        signed = true
        signer = (sigs[0].toHex && sigs[0].toHex()) || null
      }
      const pub = await privateKey.getPublicKey()
      const v = await msg.verify({ publicKeys: [pub] })
      if (v.length) verified = v.every(s => s.verified)
    } catch {}
    return { encrypted: true, decrypted: true, text, html, attachments, signed, verified, signer }
  } catch (err) {
    return { encrypted: true, decrypted: false, armored, error: err.message }
  }
}

app.get('/api/pgp/status', (req, res) => res.json(pgpState()))
app.put('/api/pgp', async (req, res) => {
  try {
    const { privateAsc, publicAsc, passphrase } = req.body || {}
    if (!privateAsc && !publicAsc && passphrase === undefined) {
      return res.status(400).json({ error: 'Nothing to save' })
    }
    res.json({ success: true, state: await savePgp({ privateAsc, publicAsc, passphrase }) })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})
app.delete('/api/pgp', (req, res) => res.json({ success: true, state: deletePgp() }))

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
      html: scrubOutboundHtml(bodyHtml || body || '')
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
    html: scrubOutboundHtml(msg.html)
  }

  const transporter = createSmtpTransporter()
  await transporter.sendMail(messageData)
}

// Serve the pre-built PWA (dist/) when present — single-port deploy
const DIST_DIR = path.join(__dirname, '..', 'dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { maxAge: '1h' }))
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))
  console.log(`Serving PWA from ${DIST_DIR}`)
}

// Expose the app for testing / embedding (server.test.js, supertest, etc.)
export function createApp() {
  return app
}

// Only auto-wire the scheduler + bind a port when this file is the entry
// point (`npm run server`, Tauri backend bundle). Importing the module
// elsewhere (tests, the frontend) must not bind a port or leak a timer.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  setInterval(processScheduledMessages, 30000)

  const PORT = parseInt(process.env.PORT || '3001', 10)
  const HOST = process.env.HOST || '127.0.0.1'
  app.listen(PORT, HOST, () => {
    console.log(`Mail server running on http://${HOST}:${PORT}`)
    console.log(`Account: ${account ? account.email : 'not configured'}`)
    console.log(`Scheduled messages: ${scheduledMessages.length}`)
  })
}

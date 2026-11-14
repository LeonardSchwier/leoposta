import express, { Router } from 'express'
import { state, saveScheduled, resolveAccount, getActiveAccount } from '../lib/state.js'
import { createSmtpTransporter, saveToSentFolder, getPoolFor } from '../lib/imap.js'
import { buildDraftSource, ensureDraftsPath, appendDraft, discardDraft } from '../lib/drafts.js'
import { MailActionError, parseUid } from '../lib/removal.js'
import { scrubOutboundHtml } from '../lib/sanitize.js'

const router = Router()

// POST /api/send
router.post('/send', express.json({ limit: '35mb' }), async (req, res) => {
  // express.json() leaves req.body undefined unless Content-Type is exactly a
  // JSON type; say so instead of crashing on the destructuring below.
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ success: false, error: 'Expected a JSON body (Content-Type: application/json)' })
  }
  try {
    const { to, cc, bcc, subject, body, bodyHtml, scheduled, attachments } = req.body
    const acct = resolveAccount(req)

    if (!acct) {
      return res.status(400).json({ error: 'No account configured' })
    }

    if (!to || to.length === 0) {
      return res.status(400).json({ error: 'At least one recipient is required' })
    }

    const messageData = {
      from: `"${acct.name}" <${acct.email}>`,
      to: to.join(', '),
      cc: cc?.join(', '),
      bcc: bcc?.join(', '),
      subject: subject || '(No Subject)',
      text: body || '',
      html: scrubOutboundHtml(bodyHtml || body || ''),
      accountId: acct.email
    }

    if (attachments && attachments.length > 0) {
      messageData.attachments = attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType || 'application/octet-stream'
      }))
    }

    if (scheduled) {
      const when = new Date(scheduled).toISOString()
      const msg = {
        id: Date.now().toString(),
        ...messageData,
        scheduled: when,
        status: 'pending'
      }
      state.scheduledMessages.push(msg)
      saveScheduled()
      console.log(`[send] SCHEDULED for ${when} (${when <= new Date().toISOString() ? 'PAST — will fire on next 30s tick' : 'future'})`)
      res.json({ success: true, scheduled: true })
    } else {
      const transporter = createSmtpTransporter(acct)
      const info = await transporter.sendMail(messageData)
      const messageId = info.messageId
      console.log(`[send] IMMEDIATE send to ${messageData.to} (id=${messageId})`)
      // Async fire-and-forget; never blocks the response or fails the send.
      saveToSentFolder(acct, messageData, { messageId }).catch(err => {
        console.error('[send] saveToSentFolder failed (immediate):', err && err.message)
      })
      res.json({ success: true, messageId })
    }
  } catch (err) {
    console.error('Error sending message:', err)
    res.status(500).json({ error: err.message })
  }
})

// A refusal by the server is returned as a value, not thrown: an error thrown
// inside pool.run makes the pool log the shared IMAP client out.
const asOutcome = (fn) => async (client) => {
  try { return await fn(client) } catch (err) {
    if (err instanceof MailActionError) return { error: err.message }
    throw err
  }
}

/** `replaceUid` / `:uid` of a draft: a positive integer (string or number), or null. */
function draftUid(raw) {
  return parseUid(typeof raw === 'number' ? String(raw) : raw)
}

// POST /api/drafts  { to, cc, bcc, subject, body, attachments, replaceUid? }
// Saves the compose window as a draft: APPENDs it to the account's Drafts
// mailbox (SPECIAL-USE \Drafts, else "Drafts", created if missing) flagged
// \Draft \Seen. Recipients and subject are optional. With `replaceUid` (the
// draft that was reopened) the old draft is removed once the new one is
// stored, so saving again never leaves duplicates; if that removal fails the
// new draft is kept and `replaced: false` says so. See lib/drafts.js.
router.post('/drafts', express.json({ limit: '35mb' }), async (req, res) => {
  try {
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const body = req.body || {}
    const replaceUid = body.replaceUid === undefined || body.replaceUid === null ? null : draftUid(body.replaceUid)
    if (body.replaceUid != null && replaceUid === null) return res.status(400).json({ error: 'invalid replaceUid' })
    const source = await buildDraftSource(acct, body)
    const pool = getPoolFor(acct)

    const found = await pool.run(asOutcome(async (client) => ({ folder: await ensureDraftsPath(client) })))
    if (found.error) return res.status(500).json({ error: found.error })
    // One attempt only: retrying an APPEND whose reply was lost would store the draft twice.
    const saved = await pool.run(asOutcome((client) => appendDraft(client, found.folder, source)), 1)
    if (saved.error) return res.status(500).json({ error: saved.error })
    console.log(`[drafts] saved draft to ${acct.email} :: ${saved.folder} (uid=${saved.uid ?? 'unknown'})`)

    const out = { success: true, folder: saved.folder, uid: saved.uid }
    if (replaceUid !== null && replaceUid !== saved.uid) {
      try {
        const gone = await pool.run(asOutcome((client) => discardDraft(client, saved.folder, replaceUid)))
        out.replaced = !gone.error
        if (gone.error) console.error(`[drafts] could not remove the replaced draft ${replaceUid}: ${gone.error}`)
      } catch (err) {
        out.replaced = false
        console.error(`[drafts] could not remove the replaced draft ${replaceUid}:`, err && err.message)
      }
    }
    res.json(out)
  } catch (err) {
    console.error('Error saving draft:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/drafts/:uid
// Removes a draft from the Drafts mailbox for good, e.g. once it has been sent.
// Only a message flagged \Draft is removed; one that is already gone is a success.
router.delete('/drafts/:uid', async (req, res) => {
  try {
    const uid = draftUid(req.params.uid)
    if (uid === null) return res.status(400).json({ error: 'invalid draft id' })
    const acct = resolveAccount(req)
    if (!acct) return res.status(400).json({ error: 'No account configured' })
    const pool = getPoolFor(acct)
    const out = await pool.run(asOutcome(async (client) => discardDraft(client, await ensureDraftsPath(client), uid)))
    if (out.error) return res.status(500).json({ error: out.error })
    res.json({ success: true, discarded: out.discarded })
  } catch (err) {
    console.error('Error deleting draft:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/scheduled
router.get('/scheduled', (req, res) => {
  res.json({ messages: state.scheduledMessages })
})

// DELETE /api/scheduled/:id
router.delete('/scheduled/:id', (req, res) => {
  const idx = state.scheduledMessages.findIndex(m => m.id === req.params.id)
  if (idx !== -1) {
    state.scheduledMessages.splice(idx, 1)
    saveScheduled()
    res.json({ success: true })
  } else {
    res.status(404).json({ error: 'Message not found' })
  }
})

export async function sendScheduledMessage(msg) {
  const acct = msg.accountId
    ? state.accounts.find(a => a.email.toLowerCase() === msg.accountId.toLowerCase())
    : getActiveAccount()
  if (!acct) throw new Error('No account configured')

  const messageData = {
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    text: msg.text,
    html: scrubOutboundHtml(msg.html)
  }

  if (msg.attachments && msg.attachments.length > 0) {
    messageData.attachments = msg.attachments.map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType || 'application/octet-stream'
    }))
  }

  const transporter = createSmtpTransporter(acct)
  const info = await transporter.sendMail(messageData)
  const messageId = info.messageId
  // Async fire-and-forget; never blocks the scheduler or fails the send.
  saveToSentFolder(acct, messageData, { messageId }).catch(err => {
    console.error('[send] saveToSentFolder failed (scheduled):', err && err.message)
  })
  return messageId
}

// Messages whose send is in flight. They stay `pending` on disk until the send
// resolves (a crash mid-send re-sends rather than loses the mail), so the
// 30 s tick needs this to know it must not dispatch them again: a slow SMTP
// server or a large attachment would otherwise send the same mail every tick.
const inFlight = new Set()

export function processScheduledMessages(send = sendScheduledMessage) {
  const now = new Date()
  const dueMessages = state.scheduledMessages.filter(
    m => m.status === 'pending' && !inFlight.has(m) && new Date(m.scheduled) <= now
  )

  for (const msg of dueMessages) {
    inFlight.add(msg)
    Promise.resolve().then(() => send(msg)).then(() => {
      msg.status = 'sent'
      saveScheduled()
    }).catch(err => {
      console.error('Error sending scheduled message:', err)
      msg.status = 'failed'
      saveScheduled()
    }).finally(() => inFlight.delete(msg))
  }
}

export default router

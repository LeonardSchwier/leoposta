import express, { Router } from 'express'
import { state, saveScheduled, resolveAccount, getActiveAccount } from '../lib/state.js'
import { createSmtpTransporter, saveToSentFolder } from '../lib/imap.js'
import { scrubOutboundHtml } from '../lib/sanitize.js'

const router = Router()

// POST /api/send
router.post('/send', express.json({ limit: '35mb' }), async (req, res) => {
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

import express, { Router } from 'express'
import { state, saveScheduled } from '../lib/state.js'
import { createSmtpTransporter } from '../lib/imap.js'
import { scrubOutboundHtml } from '../lib/sanitize.js'

const router = Router()

// POST /api/send
router.post('/send', express.json({ limit: '35mb' }), async (req, res) => {
  try {
    const { to, cc, bcc, subject, body, bodyHtml, scheduled, attachments } = req.body

    if (!state.account) {
      return res.status(400).json({ error: 'No account configured' })
    }

    if (!to || to.length === 0) {
      return res.status(400).json({ error: 'At least one recipient is required' })
    }

    const messageData = {
      from: `"${state.account.name}" <${state.account.email}>`,
      to: to.join(', '),
      cc: cc?.join(', '),
      bcc: bcc?.join(', '),
      subject: subject || '(No Subject)',
      text: body || '',
      html: scrubOutboundHtml(bodyHtml || body || '')
    }

    if (attachments && attachments.length > 0) {
      messageData.attachments = attachments.map(a => ({
        filename: a.filename,
        content: a.content,
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
      state.scheduledMessages.push(msg)
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
  if (!state.account) throw new Error('No account configured')

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

export function processScheduledMessages() {
  const now = new Date()
  const dueMessages = state.scheduledMessages.filter(m => m.status === 'pending' && new Date(m.scheduled) <= now)

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

export default router

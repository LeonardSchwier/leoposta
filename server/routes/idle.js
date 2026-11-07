import { Router } from 'express'
import { state } from '../lib/state.js'
import { createImapClient } from '../lib/imap.js'

const router = Router()

// GET /api/idle - SSE stream for real-time inbox updates
router.get('/idle', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  })
  res.write('event: connected\ndata: {"status":"connected"}\n\n')

  if (!state.account) {
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

export default router

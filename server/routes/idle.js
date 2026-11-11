import { Router } from 'express'
import { resolveAccount } from '../lib/state.js'
import { createImapClient } from '../lib/imap.js'

// GET /api/idle - SSE stream for real-time inbox updates.
// Dependencies are injectable so the connect/disconnect races can be tested
// without an IMAP server; the default export wires the real ones.
export function createIdleRouter({
  createClient = createImapClient,
  resolve = resolveAccount,
  heartbeatMs = 25000
} = {}) {
  const router = Router()

  router.get('/idle', async (req, res) => {
    // No Access-Control-Allow-Origin here: the cors() middleware in index.js has
    // already set the origin-specific answer (and Vary: Origin), and a header
    // written by writeHead replaces it, here with a wildcard.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })
    const send = (chunk) => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk)
    }
    send('event: connected\ndata: {"status":"connected"}\n\n')

    const acct = resolve(req)
    if (!acct) {
      send('event: error\ndata: {"error":"No account configured"}\n\n')
      res.end()
      return
    }

    let client
    let lock
    let heartbeat
    let closed = false
    let ready = false

    // Release whatever has been acquired so far. Idempotent: it runs from the
    // request's close, the response's close, and the failure paths below.
    const teardown = () => {
      clearInterval(heartbeat)
      // Logging out is what ends IDLE; ImapFlow has no idle.stop().
      if (lock) {
        const l = lock
        lock = undefined
        try { l.release() } catch (e) {}
      }
      if (client) {
        const c = client
        client = undefined
        try { Promise.resolve(c.logout()).catch(() => {}) } catch (e) {}
      }
    }

    // Registered before the first await. The browser can drop the stream while
    // the IMAP connect or the mailbox lock is still pending (every settings or
    // account change restarts the stream); a close handler added after those
    // awaits would never fire and the logged-in IMAP session would leak. Only
    // the response's close is used: it fires when the connection drops or the
    // response ends, and does not depend on how the request body is consumed.
    // Before the stream is ready the awaiting code below owns the cleanup, and
    // close() aborts a connect or lock that is still pending so it settles at
    // once (a client that is still connecting cannot be logged out).
    const onClose = () => {
      closed = true
      if (ready) return teardown()
      if (client) {
        try { client.close() } catch (e) {}
      }
    }
    res.on('close', onClose)

    try {
      client = createClient(acct)
      await client.connect()
      if (closed) return teardown()
      lock = await client.getMailboxLock('INBOX')
      if (closed) return teardown()
    } catch (err) {
      send(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`)
      res.end()
      teardown()
      return
    }

    client.on('mailbox', () => send('event: mailbox-update\ndata: {"type":"new-messages"}\n\n'))
    client.on('expunge', () => send('event: mailbox-update\ndata: {"type":"expunge"}\n\n'))
    client.on('fetch', () => send('event: mailbox-update\ndata: {"type":"fetch"}\n\n'))

    heartbeat = setInterval(() => send(': keepalive\n\n'), heartbeatMs)
    ready = true

    // client.idle() stays pending until broken by idle.stop() or an error.
    // ImapFlow's autoidle() keeps the connection idling on inactivity, so this
    // stream stays live until the client disconnects. Rejecting here means the
    // connection died underneath us: end the SSE stream, whose close runs teardown.
    client.idle().catch(() => {
      try { res.end() } catch (e) {}
      teardown()
    })
  })

  return router
}

export default createIdleRouter()

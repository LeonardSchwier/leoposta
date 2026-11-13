// SMTP sink for the real-stack e2e suite.
//
// Accepts mail from the app on SMTP_PORT (plaintext, any AUTH), then delivers
// a copy into every recipient's INBOX on the Dovecot test server by IMAP
// APPEND (Dovecot's static passdb lets us log in as any user). Every accepted
// envelope is also appended as one JSON line to SMTP_LOG, so tests can assert
// on exactly what was handed to SMTP (recipients incl. Bcc, raw size, ...).
import fs from 'node:fs'
import { SMTPServer } from 'smtp-server'
import { ImapFlow } from 'imapflow'

const PORT = Number(process.env.SMTP_PORT || 3587)
const IMAP_PORT = Number(process.env.IMAP_PORT || 3143)
const PASS = process.env.STACK_PASSWORD || 'pass'
const LOG = process.env.SMTP_LOG || '.e2e-real/smtp.jsonl'
const INBOX = process.env.STACK_INBOX || 'INBOX'

async function deliver(rcpt, raw) {
  const client = new ImapFlow({
    host: '127.0.0.1', port: IMAP_PORT, secure: false,
    auth: { user: rcpt, pass: PASS }, logger: false
  })
  await client.connect()
  try {
    await client.append(INBOX, raw, [])
  } finally {
    await client.logout().catch(() => {})
  }
}

const server = new SMTPServer({
  secure: false,
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, _session, cb) { cb(null, { user: auth.username }) },
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', (c) => chunks.push(c))
    stream.on('end', async () => {
      const raw = Buffer.concat(chunks)
      const rcpts = session.envelope.rcptTo.map((r) => r.address)
      try {
        fs.appendFileSync(LOG, JSON.stringify({
          at: new Date().toISOString(),
          from: session.envelope.mailFrom && session.envelope.mailFrom.address,
          to: rcpts,
          user: session.user || null,
          size: raw.length,
          raw: raw.toString('utf8')
        }) + '\n')
        for (const r of rcpts) await deliver(r, raw)
        cb()
      } catch (e) {
        console.error('[smtp-sink] delivery failed:', e.message)
        cb(new Error('delivery failed'))
      }
    })
  }
})
server.on('error', (e) => console.error('[smtp-sink]', e.message))
server.listen(PORT, '127.0.0.1', () => console.log(`[smtp-sink] listening on 127.0.0.1:${PORT}`))

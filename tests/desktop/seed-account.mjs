// Seeds a fresh mailbox on the real-stack Dovecot with one message and
// configures it as the only account of a running Leoposta backend.
//
//   node tests/desktop/seed-account.mjs <backend-url> <token> <subject> <body>
//
// Ports follow tests/stack/stack.sh (+10 * E2E_STACK_ID). Prints the address.
import { ImapFlow } from 'imapflow'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'

const [base, token, subject, body] = process.argv.slice(2)
if (!base || !token || !subject || !body) {
  console.error('usage: seed-account.mjs <backend-url> <token> <subject> <body>')
  process.exit(2)
}
const SID = Number(process.env.E2E_STACK_ID || 0)
const IMAP_PORT = 3143 + 10 * SID
const SMTP_PORT = 3587 + 10 * SID
const DAV_PORT = 5233 + 10 * SID
const email = `desk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@example.test`

const imap = new ImapFlow({ host: '127.0.0.1', port: IMAP_PORT, secure: false, auth: { user: email, pass: 'pass' }, logger: false })
await imap.connect()
const raw = await new MailComposer({ from: 'Sender <sender@example.test>', to: email, subject, text: body }).compile().build()
await imap.append('INBOX', raw, [])
await imap.logout()

const res = await fetch(`${base}/api/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-leoposta-token': token },
  body: JSON.stringify({
    name: 'desktop smoke', email,
    imapHost: '127.0.0.1', imapPort: IMAP_PORT, imapTls: false,
    smtpHost: '127.0.0.1', smtpPort: SMTP_PORT, smtpTls: false,
    imapUser: email, imapPass: 'pass', smtpUser: email, smtpPass: 'pass',
    davUrl: `http://127.0.0.1:${DAV_PORT}/${encodeURIComponent(email)}/`
  })
})
if (res.status !== 200) {
  console.error(`POST /api/accounts -> ${res.status} ${await res.text()}`)
  process.exit(1)
}
console.log(email)

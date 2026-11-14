// leoposta.mail.starttls-opportunistic (audit run-2): with "Use SSL/TLS" off,
// a remote server that does not offer STARTTLS must not receive the password.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SMTPServer } from 'smtp-server'
import { createImapClient, createSmtpTransporter, isLoopbackHost, mustStartTls } from './lib/imap.js'

test('SMTP with TLS off refuses to authenticate when STARTTLS is missing', async () => {
  let authSeen = false
  const srv = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true,
    onAuth(auth, session, cb) { authSeen = true; cb(null, { user: 1 }) },
    onData(stream, session, cb) { stream.resume(); stream.on('end', cb) }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.server.address().port
  // An IPv4-mapped address reaches this local test server but is not a
  // loopback *name*, so it is treated like any remote host.
  const tr = createSmtpTransporter({ email: 'v@example.test', smtpHost: '::ffff:127.0.0.1', smtpPort: port, smtpTls: false, smtpPass: 'dummy' })
  tr.options.connectionTimeout = 5000
  tr.options.greetingTimeout = 5000
  await assert.rejects(tr.sendMail({ from: 'v@example.test', to: 'x@example.test', subject: 's', text: 't' }), /STARTTLS|TLS/i)
  assert.equal(authSeen, false, 'password must not be sent in clear')
  srv.close()
})

test('transport options: STARTTLS required for remote hosts, not for loopback or implicit TLS', () => {
  const remote = createSmtpTransporter({ email: 'v@example.test', smtpHost: 'smtp.example.test', smtpPort: 587, smtpTls: false, smtpPass: 'x' })
  assert.equal(remote.options.requireTLS, true)
  const local = createSmtpTransporter({ email: 'v@example.test', smtpHost: '127.0.0.1', smtpPort: 3587, smtpTls: false, smtpPass: 'x' })
  assert.equal(local.options.requireTLS, false)
  const imap = createImapClient({ email: 'v@example.test', imapHost: 'imap.example.test', imapPort: 143, imapTls: false, imapPass: 'x' })
  assert.equal(imap.options.doSTARTTLS, true)
  const imapLocal = createImapClient({ email: 'v@example.test', imapHost: 'localhost', imapPort: 3143, imapTls: false, imapPass: 'x' })
  assert.equal(imapLocal.options.doSTARTTLS, undefined)
  const implicit = createImapClient({ email: 'v@example.test', imapHost: 'imap.example.test', imapPort: 993, imapTls: true, imapPass: 'x' })
  assert.equal(implicit.options.doSTARTTLS, undefined)
  assert.ok(isLoopbackHost('127.0.0.5') && isLoopbackHost('[::1]') && !isLoopbackHost('127.0.0.1.example.test'))
})

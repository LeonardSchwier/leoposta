// leoposta.mail.starttls-opportunistic (audit run-2): with "Use SSL/TLS" off,
// a remote server that does not offer STARTTLS must not receive the password.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SMTPServer } from 'smtp-server'
import { createImapClient, createSmtpTransporter, isLoopbackHost, mustStartTls, verifyAccount } from './lib/imap.js'

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

// The account check before saving (qa/accounts verifyAccount) logs in with
// its own clients: they must follow the same STARTTLS rule.
test('verifyAccount: SMTP with TLS off does not send the password to a remote server without STARTTLS', async () => {
  let authSeen = false
  const srv = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true,
    onAuth(auth, session, cb) { authSeen = true; cb(null, { user: 1 }) }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.server.address().port
  const fakeImap = { on() {}, async connect() {}, logout() { return Promise.resolve() } }
  try {
    await assert.rejects(verifyAccount(
      { email: 'v@example.test', imapHost: 'imap.example.test', imapPort: 143, imapTls: false, smtpHost: '::ffff:127.0.0.1', smtpPort: port, smtpTls: false, smtpPass: 'dummy' },
      { makeImap: () => fakeImap }
    ), /SMTP login .* failed/)
    assert.equal(authSeen, false, 'password must not be sent in clear')
  } finally { srv.close() }
})

test('verifyAccount: IMAP with TLS off does not send LOGIN to a remote server without STARTTLS', async () => {
  const net = await import('node:net')
  let loginSeen = false
  const srv = net.createServer((sock) => {
    sock.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n')
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2)
        const [tag, cmd] = line.split(' ')
        if (/^(LOGIN|AUTHENTICATE)$/i.test(cmd || '')) loginSeen = true
        if (/^CAPABILITY$/i.test(cmd || '')) sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`)
        else if (/^LOGOUT$/i.test(cmd || '')) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end() }
        else if (tag) sock.write(`${tag} OK done\r\n`)
      }
    })
    sock.on('error', () => {})
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    await assert.rejects(verifyAccount(
      { email: 'v@example.test', imapHost: '::ffff:127.0.0.1', imapPort: port, imapTls: false, imapPass: 'dummy', smtpHost: 'smtp.example.test', smtpPort: 587 },
      { makeSmtp: () => ({ async verify() {}, close() {} }) }
    ), /IMAP login .* failed/)
    assert.equal(loginSeen, false, 'password must not be sent in clear')
  } finally { srv.close() }
})

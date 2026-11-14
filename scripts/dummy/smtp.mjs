// Accept-all SMTP sink for the mock e2e (playwright.config.ts): Settings
// verifies the SMTP login before it saves an account, so the mock suite
// needs a server to log in to. Mail is accepted and dropped.
import { SMTPServer } from 'smtp-server'

const PORT = Number(process.env.SMTP_PORT || 2525)
const server = new SMTPServer({
  secure: false,
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, _session, cb) { cb(null, { user: auth.username }) },
  onData(stream, _session, cb) { stream.resume(); stream.on('end', () => cb()) }
})
server.listen(PORT, '127.0.0.1', () => console.log(`[dummy-smtp] listening on 127.0.0.1:${PORT}`))

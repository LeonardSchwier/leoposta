import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'

// ── Per-account IMAP pool ────────────────────────────────────────────────────
// One ImapFlow instance per account email, each with its own serialization
// queue so concurrent requests on the same account are ordered, and different
// accounts never block each other.

const pools = new Map()

/** Plain-text mail transport is only acceptable to this machine itself. */
export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h)
}

/** With implicit TLS off, STARTTLS is mandatory for a remote server: an
 * opportunistic upgrade is removed by anyone on the path, who then reads
 * the password from AUTH PLAIN/LOGIN. */
export function mustStartTls(secure, host) {
  return !secure && !isLoopbackHost(host)
}

function safeLogout(c) {
  const p = c && typeof c.logout === 'function' ? c.logout() : null
  if (p && typeof p.catch === 'function') p.catch(() => {})
}

export function createImapClient(acct) {
  const isIP = /^[0-9.]+$/.test(acct.imapHost)
  const servername = isIP ? 'imap.example.com' : acct.imapHost
  const client = new ImapFlow({
    host: acct.imapHost,
    port: acct.imapPort,
    secure: acct.imapTls,
    doSTARTTLS: mustStartTls(acct.imapTls, acct.imapHost) ? true : undefined,
    tls: { servername },
    auth: {
      user: acct.imapUser || acct.email,
      pass: acct.imapPass
    },
    logger: false
  })
  client.on('error', (err) => {
    console.error(`[imap ${acct.email}]`, err && err.code ? `${err.code} ` : '', (err && err.message) || err)
    if (typeof client.logout === 'function') {
      const p = client.logout()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  })
  client.on('close', () => {
    const pool = pools.get(acct.email.toLowerCase())
    if (pool && pool.client === client) { pool.client = null; pool.connectP = null }
  })
  return client
}

/** True for a connected, authenticated ImapFlow client that can take commands. */
export function isUsable(c) {
  return Boolean(c && c.usable && c.authenticated !== false)
}

/** Exported for tests; `connectClient` is the factory for new connections. */
export function makePool(acct, connectClient = createImapClient) {
  return {
    client: null,
    connectP: null,
    queue: Promise.resolve(),
    async ensure() {
      // ImapFlow marks a logged-in, open connection with `usable` (it has no
      // `user` property: checking that opened a new connection per request and
      // leaked the old one until the server's per-user limit refused logins).
      if (isUsable(this.client)) return this.client
      if (this.client) { safeLogout(this.client); this.client = null }
      if (!this.connectP) {
        this.connectP = (async () => {
          const client = connectClient(acct)
          try { await client.connect() } catch (e) { safeLogout(client); throw e }
          return client
        })()
      }
      try {
        const c = await this.connectP
        this.client = c
        return c
      } finally {
        // Also after a failed connect, or the pool would keep handing out the
        // same rejection and never reconnect once the server is back.
        this.connectP = null
      }
    },
    async _exec(fn, retry) {
      let lastErr
      for (let i = 0; i < retry; i++) {
        const reused = isUsable(this.client)
        const c = await this.ensure()
        try {
          // A reused session does not see what changed in its selected mailbox
          // since its last command (new mail, expunges by other clients):
          // getMailboxLock() on that same mailbox skips SELECT. NOOP fetches
          // the pending EXISTS/EXPUNGE and also proves the session is alive.
          if (reused && c.mailbox) await c.noop()
          return await fn(c)
        } catch (e) {
          lastErr = e
          const resp = e && e.responseText ? String(e.responseText) : ''
          const authThrottled = e && (e.authenticationFailed || /\[UNAVAILABLE\]\s*Temporary authentication failure/i.test(resp))
          const transient = !authThrottled && (
            String(e && e.message || '') === 'Command failed'
            || String(e && e.message || '').includes('socket was closed unexpectedly')
            || String(e && e.message || '').includes('No response to command')
            || !isUsable(c)
          )
          const wasOurs = this.client === c
          safeLogout(c)
          if (wasOurs) { this.client = null; this.connectP = null }
          if (!transient || authThrottled) throw e
          await new Promise(r => setTimeout(r, 300 * (i + 1)))
        }
      }
      throw lastErr
    },
    run(fn, retry = 4) {
      const prev = this.queue || Promise.resolve()
      const next = prev.then(() => this._exec(fn, retry))
      this.queue = next.catch(() => {})
      return next
    },
    async reset() {
      const c = this.client
      this.client = null
      this.connectP = null
      if (c) safeLogout(c)
    }
  }
}

/** Look up (or create) the IMAP pool for an account by its email. */
export function getPoolFor(acct) {
  const key = String(acct.email).toLowerCase()
  if (!pools.has(key)) pools.set(key, makePool(acct))
  return pools.get(key)
}

/** Drop the pool for an account (on DELETE /api/accounts/:email). */
export function dropPool(email) {
  const key = String(email).toLowerCase()
  const pool = pools.get(key)
  if (pool) {
    pool.reset().catch(() => {})
    pools.delete(key)
  }
}

// ── SMTP ─────────────────────────────────────────────────────────────────────
export function createSmtpTransporter(acct) {
  return nodemailer.createTransport({
    host: acct.smtpHost,
    port: acct.smtpPort,
    secure: acct.smtpTls,
    requireTLS: mustStartTls(acct.smtpTls, acct.smtpHost),
    auth: {
      user: acct.smtpUser || acct.email,
      pass: acct.smtpPass
    }
  })
}

// ── Save sent mail to IMAP Sent folder ───────────────────────────────────────
// Best-effort: returns true if saved, false otherwise. Never throws.

const SENT_NAMES = ['sent', 'sent items', 'sent messages', 'gesendet', 'gesendete objekte']
const selectable = (m) => !(m.flags && m.flags.has && (m.flags.has('\\Noselect') || m.flags.has('\\NonExistent')))

/** The raw source of the copy kept in Sent: the same message (same Message-ID
 * and Date as the one handed to SMTP), with Bcc kept so the sender can see who
 * was blind-copied, as every mail client does. */
export async function buildSentSource(messageData, { messageId, date } = {}) {
  const { accountId: _ignored, ...mail } = messageData
  void _ignored
  if (messageId) mail.messageId = messageId
  if (date) mail.date = date
  const node = new MailComposer(mail).compile()
  node.keepBcc = true
  return node.build()
}

/** The Sent mailbox: the one flagged \Sent (ImapFlow also derives that from
 * well-known names), else a mailbox whose leaf name is a usual Sent name (any
 * namespace prefix, e.g. "INBOX.Sent"), else a new "Sent". Never INBOX. */
export async function findOrCreateSentPath(client) {
  const boxes = (await client.list()).filter(selectable)
  const flagged = boxes.find((m) => m.specialUse === '\\Sent')
  if (flagged) return flagged.path
  const named = boxes.find((m) => SENT_NAMES.includes(String(m.name || m.path).toLowerCase()))
  if (named) return named.path
  const created = await client.mailboxCreate('Sent')
  return (created && created.path) || 'Sent'
}

export async function saveToSentFolder(acct, messageData, { messageId, date, raw: prebuilt } = {}) {
  if (!acct) return false
  let target = 'Sent'
  try {
    // `prebuilt`: a PGP/MIME message is built (signed/encrypted) by the sender.
    const raw = prebuilt || await buildSentSource(messageData, { messageId, date })
    const pool = getPoolFor(acct)
    // One attempt for the APPEND: retrying one whose reply was lost would
    // store the copy twice.
    target = await pool.run((client) => findOrCreateSentPath(client))
    const done = await pool.run((client) => client.append(target, raw, ['\\Seen'], date || new Date()), 1)
    if (!done) throw new Error('the server refused the APPEND')
    console.log(`[imap] saved sent mail to ${acct.email} :: ${target} (id=${messageId || 'auto'})`)
    return true
  } catch (err) {
    console.error(`[imap] failed to save sent mail to ${target}:`, (err && err.message) || err)
    return false
  }
}



// ── Credential check before an account is saved ─────────────────────────────
const VERIFY_TIMEOUT_MS = Number(process.env.LEOPOSTA_VERIFY_TIMEOUT_MS) || 15_000

function describeError(e) {
  if (!e) return 'unknown error'
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|Authentication failed|Invalid credentials|535/i.test(`${e.responseText || ''} ${e.response || ''} ${e.message || ''}`)) {
    return 'wrong user name or password'
  }
  if (e.code === 'ECONNREFUSED') return 'connection refused'
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return 'host not found'
  if (e.code === 'ETIMEDOUT' || /timeout/i.test(String(e.message))) return 'timed out'
  if (/certificate|SSL|TLS|wrong version number/i.test(String(e.message))) return `TLS problem (${e.message})`
  return e.message || String(e)
}

/**
 * Log in to IMAP and SMTP with the account's settings and log out again.
 * Resolves when both work; rejects with a user-facing message naming the
 * server that failed (never the password). Seams for tests: `deps`.
 */
export async function verifyAccount(acct, deps = {}) {
  // Same TLS rules as the real connections: with implicit TLS off, a remote
  // server must do STARTTLS before it gets the password (mustStartTls).
  const makeImap = deps.makeImap || ((a) => new ImapFlow({
    host: a.imapHost, port: a.imapPort, secure: a.imapTls,
    doSTARTTLS: mustStartTls(a.imapTls, a.imapHost) ? true : undefined,
    tls: { servername: /^[0-9.]+$/.test(a.imapHost || '') ? undefined : a.imapHost },
    auth: { user: a.imapUser || a.email, pass: a.imapPass || '' },
    logger: false,
    connectionTimeout: VERIFY_TIMEOUT_MS, greetingTimeout: VERIFY_TIMEOUT_MS, socketTimeout: VERIFY_TIMEOUT_MS
  }))
  const makeSmtp = deps.makeSmtp || ((a) => nodemailer.createTransport({
    host: a.smtpHost, port: a.smtpPort, secure: a.smtpTls,
    requireTLS: mustStartTls(a.smtpTls, a.smtpHost),
    auth: { user: a.smtpUser || a.email, pass: a.smtpPass || '' },
    connectionTimeout: VERIFY_TIMEOUT_MS, greetingTimeout: VERIFY_TIMEOUT_MS, socketTimeout: VERIFY_TIMEOUT_MS
  }))
  if (!acct.imapHost) throw Object.assign(new Error('IMAP server is required'), { field: 'imap' })
  if (!acct.smtpHost) throw Object.assign(new Error('SMTP server is required'), { field: 'smtp' })
  const imap = makeImap(acct)
  imap.on?.('error', () => {})
  try {
    await imap.connect()
  } catch (e) {
    safeLogout(imap)
    throw Object.assign(new Error(`IMAP login to ${acct.imapHost}:${acct.imapPort} failed: ${describeError(e)}`), { field: 'imap' })
  }
  safeLogout(imap)
  const smtp = makeSmtp(acct)
  try {
    await smtp.verify()
  } catch (e) {
    throw Object.assign(new Error(`SMTP login to ${acct.smtpHost}:${acct.smtpPort} failed: ${describeError(e)}`), { field: 'smtp' })
  } finally {
    smtp.close?.()
  }
}

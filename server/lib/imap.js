import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'

// ── Per-account IMAP pool ────────────────────────────────────────────────────
// One ImapFlow instance per account email, each with its own serialization
// queue so concurrent requests on the same account are ordered, and different
// accounts never block each other.

const pools = new Map()

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

function makePool(acct) {
  return {
    client: null,
    connectP: null,
    queue: Promise.resolve(),
    async ensure() {
      if (this.client && this.client.user) return this.client
      if (!this.connectP) {
        this.connectP = (async () => {
          const client = createImapClient(acct)
          try { await client.connect() } catch (e) { safeLogout(client); throw e }
          return client
        })()
      }
      const c = await this.connectP
      this.client = c
      this.connectP = null
      return c
    },
    async _exec(fn, retry) {
      let lastErr
      for (let i = 0; i < retry; i++) {
        const c = await this.ensure()
        try {
          return await fn(c)
        } catch (e) {
          lastErr = e
          const resp = e && e.responseText ? String(e.responseText) : ''
          const authThrottled = e && (e.authenticationFailed || /\[UNAVAILABLE\]\s*Temporary authentication failure/i.test(resp))
          const transient = !authThrottled && (
            String(e && e.message || '') === 'Command failed'
            || String(e && e.message || '').includes('socket was closed unexpectedly')
            || String(e && e.message || '').includes('No response to command')
            || !c.user
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
    auth: {
      user: acct.smtpUser || acct.email,
      pass: acct.smtpPass
    }
  })
}



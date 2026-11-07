import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { state } from './state.js'

export function createImapClient() {
  if (!state.account) throw new Error('No account configured')
  const acct = state.account
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
    console.error('ImapFlow error:', err && err.code ? `${err.code} ` : '', (err && err.message) || err)
    if (typeof client.logout === 'function') {
      const p = client.logout()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  })
  client.on('close', () => {
    if (pool.client === client) { pool.client = null; pool.connectP = null }
  })
  return client
}

export function safeLogout(c) {
  const p = c && typeof c.logout === 'function' ? c.logout() : null
  if (p && typeof p.catch === 'function') p.catch(() => {})
}

// ONE shared authenticated IMAP connection for all REST operations.
// Reconnects + retries on transient failures; auth-throttle failures
// drop the pool so the next user retry gets a fresh session.
export const pool = {
  client: null,
  connectP: null,
  queue: Promise.resolve(),
  async ensure() {
    if (this.client && this.client.user) return this.client
    if (!this.connectP) {
      this.connectP = (async () => {
        const client = createImapClient()
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

export function createSmtpTransporter() {
  if (!state.account) throw new Error('No account configured')
  const acct = state.account
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

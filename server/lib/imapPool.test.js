// The per-account pool must reuse a live ImapFlow connection. It used to test
// `client.user`, a property ImapFlow never sets, so every request opened a new
// IMAP session and dropped the previous one without LOGOUT: a few clicks later
// Dovecot refused logins (mail_max_userip_connections) and the app showed 500s.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImapFlow } from 'imapflow'
import { getPoolFor, dropPool } from './imap.js'

const acct = { email: 'pool-reuse@example.test', imapHost: '127.0.0.1', imapPort: 1, imapTls: false, imapUser: 'x', imapPass: 'y' }
const flow = () => new ImapFlow({ host: '127.0.0.1', port: 1, secure: false, logger: false, auth: { user: 'x', pass: 'y' } })

test('pool.run reuses a connected (usable) ImapFlow client instead of reconnecting', async () => {
  const pool = getPoolFor(acct)
  const live = flow()
  live.usable = true // what ImapFlow itself sets once connected + authenticated
  pool.client = live
  try {
    const seen = []
    for (let i = 0; i < 3; i++) await pool.run(async (c) => { seen.push(c) }, 1)
    assert.equal(seen.length, 3)
    for (const c of seen) assert.equal(c, live, 'every request must run on the existing connection')
  } finally {
    pool.client = null
    dropPool(acct.email)
  }
})

test('a reused client with a selected mailbox is synced (NOOP) before each request', async () => {
  const pool = getPoolFor(acct)
  const live = flow()
  live.usable = true
  live.mailbox = { path: 'INBOX', exists: 0 }
  const calls = []
  // Stand-in for the server's untagged EXISTS that NOOP brings in.
  live.noop = async () => { calls.push('noop'); live.mailbox.exists++ }
  pool.client = live
  try {
    const exists = await pool.run(async (c) => { calls.push('fn'); return c.mailbox.exists }, 1)
    assert.deepEqual(calls, ['noop', 'fn'])
    assert.equal(exists, 1, 'the request sees mail that arrived since the last command')
  } finally {
    pool.client = null
    dropPool(acct.email)
  }
})

test('pool.run reconnects when the client is no longer usable', async () => {
  const pool = getPoolFor(acct)
  const dead = flow()
  dead.usable = false
  pool.client = dead
  try {
    // Port 1 refuses: the reconnect attempt is what fails.
    await assert.rejects(pool.run(async () => {}, 1))
  } finally {
    pool.client = null
    dropPool(acct.email)
  }
})

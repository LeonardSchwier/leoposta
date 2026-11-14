import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPoolFor } from './imap.js'

// A fake shaped like ImapFlow 1.7.8: `usable` is true once connected and
// authenticated; there is no `user` property.
function fakeClient() {
  const calls = []
  return { usable: true, calls, logout() { calls.push('logout'); this.usable = false; return Promise.resolve() } }
}

test('the pool reuses its usable ImapFlow session instead of logging in again', async () => {
  const pool = getPoolFor({ email: 'reuse@example.test', imapHost: '127.0.0.1', imapPort: 1, imapTls: false, imapPass: 'x' })
  const c = fakeClient()
  pool.client = c
  const seen = []
  for (let i = 0; i < 3; i++) await pool.run(async (client) => { seen.push(client) })
  assert.deepEqual(seen, [c, c, c])
  assert.deepEqual(c.calls, [], 'the session stays open')
})

test('a refusal by the server is not retried with new logins', async () => {
  const pool = getPoolFor({ email: 'refusal@example.test', imapHost: '127.0.0.1', imapPort: 1, imapTls: false, imapPass: 'x' })
  const c = fakeClient()
  pool.client = c
  let attempts = 0
  await assert.rejects(pool.run(async () => {
    attempts++
    throw Object.assign(new Error('Mailbox does not exist'), { responseText: 'Mailbox does not exist' })
  }))
  assert.equal(attempts, 1)
})

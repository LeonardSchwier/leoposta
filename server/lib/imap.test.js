import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makePool, isUsable } from './imap.js'

// A fake ImapFlow 1.7.8 connection: after connect() it is `usable` and
// `authenticated` (the user name); it has no `user` property.
function factory({ failFirst = 0 } = {}) {
  const made = []
  let failures = failFirst
  const make = () => {
    const c = {
      usable: false,
      authenticated: false,
      loggedOut: false,
      async connect() {
        if (failures > 0) { failures--; throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
        c.usable = true
        c.authenticated = 'tester'
      },
      async logout() { c.loggedOut = true; c.usable = false }
    }
    made.push(c)
    return c
  }
  return { make, made }
}

const acct = { email: 'pool@example.test' }

test('isUsable follows ImapFlow\'s usable/authenticated flags', () => {
  assert.equal(isUsable(null), false)
  assert.equal(isUsable({ usable: false, authenticated: 'x' }), false)
  assert.equal(isUsable({ usable: true, authenticated: false }), false)
  assert.equal(isUsable({ usable: true, authenticated: 'x' }), true)
})

test('the pool reuses one IMAP connection for consecutive requests', async () => {
  const f = factory()
  const pool = makePool(acct, f.make)
  for (let i = 0; i < 5; i++) await pool.run(async (c) => c)
  assert.equal(f.made.length, 1, 'one connection, not one per request')
  assert.equal(f.made[0].loggedOut, false)
})

test('a connection that went away is replaced (and the old one logged out)', async () => {
  const f = factory()
  const pool = makePool(acct, f.make)
  await pool.run(async () => {})
  f.made[0].usable = false // e.g. the socket closed
  await pool.run(async () => {})
  assert.equal(f.made.length, 2)
  assert.equal(f.made[0].loggedOut, true)
})

test('after a failed connect the next request connects again', async () => {
  const f = factory({ failFirst: 1 })
  const pool = makePool(acct, f.make)
  await assert.rejects(pool.run(async () => {}, 1), /ECONNREFUSED/)
  const c = await pool.run(async (client) => client, 1)
  assert.equal(isUsable(c), true)
  assert.equal(f.made.length, 2)
})

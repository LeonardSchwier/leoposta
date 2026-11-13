import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Message routes against a fake ImapFlow client seeded into the account's pool.
// The fake follows ImapFlow 1.7.8, where it matters here: message flags are a
// Set<string> (lib/tools.js), there is messageFlagsAdd / messageFlagsRemove but
// no messageFlags, those resolve to false when the server refuses, fetchOne
// resolves false for an unknown message, and getMailboxLock resolves
// { path, release }. It does not model IMAP4rev2 or UIDPLUS.

const TOKEN = 'mailroutes-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-mailroutes-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

const { createApp } = await import('./index.js')
const { state } = await import('./lib/state.js')
const { getPoolFor } = await import('./lib/imap.js')

const EMAIL = 'tester@example.test'
const authed = { 'x-leoposta-token': TOKEN, 'x-account': EMAIL }
const json = { ...authed, 'content-type': 'application/json' }

let server
let base

before(async () => {
  state.accounts = [{
    id: 'acct-test', email: EMAIL, imapHost: '127.0.0.1', imapPort: 1, imapTls: false,
    imapUser: EMAIL, imapPass: 'x'
  }]
  state.rules = []
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

const crlf = (lines) => Buffer.from(lines.join('\r\n'), 'utf-8')

/** A stored message as ImapFlow would return it. */
function message(uid, { flags = [], source, bodyStructure, subject = `Subject ${uid}` } = {}) {
  return {
    uid,
    flags: new Set(flags),
    internalDate: new Date('2026-11-01T10:00:00Z'),
    envelope: {
      date: new Date('2026-11-01T09:00:00Z'),
      subject,
      from: [{ name: 'Alice', address: 'alice@example.test' }],
      to: [{ address: EMAIL }]
    },
    bodyStructure,
    source: source ?? crlf([
      'From: Alice <alice@example.test>', `Subject: ${subject}`, 'Content-Type: text/plain', '', 'hello'
    ])
  }
}

function makeFakeClient({ messages = [], addResult = true, removeResult = true } = {}) {
  const calls = []
  const client = {
    user: 'tester',
    calls,
    mailbox: { exists: messages.length, unseen: messages.filter((m) => !m.flags.has('\\Seen')).length },
    async getMailboxLock(p) {
      calls.push(['lock', p])
      return { path: p, release() { calls.push(['release']) } }
    },
    fetch(range, query, opts) {
      calls.push(['fetch', range, query, opts])
      const onlyUids = Object.keys(query).length === 1 && query.uid
      return (async function* () {
        for (const m of messages) {
          if (onlyUids) yield { uid: m.uid }
          else {
            const { source, ...rest } = m
            yield rest
          }
        }
      })()
    },
    async fetchOne(range, query, opts) {
      calls.push(['fetchOne', range, query, opts])
      const found = opts?.uid ? messages.find((m) => m.uid === Number(range)) : messages[Number(range) - 1]
      return found ? { ...found } : false
    },
    async messageFlagsAdd(range, flags, opts) { calls.push(['messageFlagsAdd', range, flags, opts]); return addResult },
    async messageFlagsRemove(range, flags, opts) { calls.push(['messageFlagsRemove', range, flags, opts]); return removeResult },
    logout() { calls.push(['logout']); return Promise.resolve() }
  }
  return client
}

let fake
function useClient(opts) {
  fake = makeFakeClient(opts)
  const pool = getPoolFor(state.accounts[0])
  pool.client = fake
  pool.connectP = null
  return fake
}
const names = (client) => client.calls.map((c) => c[0])
const find = (client, name) => client.calls.find((c) => c[0] === name)

beforeEach(() => { fake = null })

async function setFlags(id, body) {
  const res = await fetch(`${base}/api/message/${id}/flags`, { method: 'POST', headers: json, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
async function getMessage(id, query = 'folder=INBOX') {
  const res = await fetch(`${base}/api/message/${id}?${query}`, { headers: authed })
  return { status: res.status, body: await res.json() }
}

// ── flags ───────────────────────────────────────────────────────────────────

test('starring a message adds \\Flagged by UID through messageFlagsAdd (messageFlags does not exist in ImapFlow)', async () => {
  const c = useClient({ messages: [message(7)] })
  const res = await setFlags(7, { folder: 'INBOX', add: ['\\Flagged'], remove: [] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true })
  assert.deepEqual(find(c, 'messageFlagsAdd').slice(1), [7, ['\\Flagged'], { uid: true }])
  assert.ok(!names(c).includes('messageFlagsRemove'))
  assert.ok(!names(c).includes('logout'), 'a flag change must not drop the IMAP connection')
  assert.ok(names(c).includes('release'), 'the mailbox lock is released')
})

test('marking unread removes \\Seen; add and remove in one request run both', async () => {
  const c = useClient({ messages: [message(7, { flags: ['\\Seen'] })] })
  const res = await setFlags(7, { folder: 'INBOX', add: ['$Work'], remove: ['\\Seen'] })
  assert.equal(res.status, 200)
  assert.deepEqual(find(c, 'messageFlagsAdd').slice(1), [7, ['$Work'], { uid: true }])
  assert.deepEqual(find(c, 'messageFlagsRemove').slice(1), [7, ['\\Seen'], { uid: true }])
})

test('a request that changes nothing is a success and sends nothing to the server', async () => {
  const c = useClient({ messages: [message(7)] })
  const res = await setFlags(7, { folder: 'INBOX', add: [], remove: [] })
  assert.equal(res.status, 200)
  assert.ok(!names(c).includes('messageFlagsAdd'))
  assert.ok(!names(c).includes('messageFlagsRemove'))
})

test('a refused flag change (ImapFlow answers false) is an error, not success, and keeps the connection', async () => {
  const c = useClient({ messages: [message(7)], addResult: false })
  const res = await setFlags(7, { folder: 'INBOX', add: ['\\Flagged'], remove: [] })
  assert.equal(res.status, 500)
  assert.ok(res.body.error, 'the UI needs a message to show')
  assert.ok(!names(c).includes('logout'), 'a refused change is not a broken connection')
  assert.ok(names(c).includes('release'))
})

test('flag requests that are not a UID plus arrays of plain flag names are rejected before the server is touched', async () => {
  const c = useClient({ messages: [message(7)] })
  const bad = [
    [7.5, { add: ['\\Seen'] }],
    ['abc', { add: ['\\Seen'] }],
    [0, { add: ['\\Seen'] }],
    [7, { add: '\\Seen' }],
    [7, { add: [1] }],
    [7, { add: ['\\Seen) (X'] }],
    [7, { add: ['has space'] }],
    [7, { remove: [{}] }],
    [7, { add: Array.from({ length: 33 }, (_, i) => `$f${i}`) }]
  ]
  for (const [id, body] of bad) {
    const res = await setFlags(id, { folder: 'INBOX', ...body })
    assert.equal(res.status, 400, JSON.stringify([id, body]))
  }
  assert.deepEqual(names(c), [], 'nothing reached the IMAP client')
})

// ── read state reaches the UI ───────────────────────────────────────────────

test('opening an unread message marks it \\Seen through messageFlagsAdd', async () => {
  const c = useClient({ messages: [message(5, { flags: [] })] })
  const res = await getMessage(5)
  assert.equal(res.status, 200)
  assert.deepEqual(find(c, 'messageFlagsAdd').slice(1), [5, ['\\Seen'], { uid: true }])
  assert.ok(!names(c).includes('logout'))
})

test('opening a message that is already read does not touch its flags', async () => {
  const c = useClient({ messages: [message(5, { flags: ['\\Seen'] })] })
  const res = await getMessage(5)
  assert.equal(res.status, 200)
  assert.ok(!names(c).includes('messageFlagsAdd'))
})

test('the message and list responses carry the flags the server reported (a Set)', async () => {
  useClient({ messages: [message(5, { flags: ['\\Seen', '\\Flagged'] }), message(6, { flags: [] })] })
  const detail = await getMessage(5)
  assert.deepEqual(detail.body.flags, ['\\Seen', '\\Flagged'])
  const list = await fetch(`${base}/api/messages?folder=INBOX`, { headers: authed })
  const { messages } = await list.json()
  const byId = Object.fromEntries(messages.map((m) => [m.id, m.flags]))
  assert.deepEqual(byId['5'], ['\\Seen', '\\Flagged'])
  assert.deepEqual(byId['6'], [])
})

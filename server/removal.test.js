import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Deleting or moving a message must never destroy mail by accident. The route
// is exercised through createApp() with a fake ImapFlow client seeded into the
// account's pool. The fake follows ImapFlow 1.7.8: messageMove/messageCopy/
// messageDelete resolve to false on failure instead of throwing, and without the
// MOVE extension messageMove is COPY followed by messageDelete, run even when the
// copy failed (node_modules/imapflow/lib/commands/move.js). getMailboxLock
// normalizes the path (namespace prefix, INBOX in any case) and resolves
// { path, release }, as in lib/tools.js normalizePath. The fake does not model
// IMAP4rev2 capability folding or UIDPLUS.

const TOKEN = 'removal-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-removal-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

const { createApp } = await import('./index.js')
const { state } = await import('./lib/state.js')
const { getPoolFor } = await import('./lib/imap.js')

const EMAIL = 'tester@example.test'
const authed = { 'x-leoposta-token': TOKEN, 'x-account': EMAIL }

let server
let base

before(async () => {
  state.accounts = [{
    id: 'acct-test', email: EMAIL, imapHost: '127.0.0.1', imapPort: 1, imapTls: false,
    imapUser: EMAIL, imapPass: 'x'
  }]
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

/** A fake ImapFlow client. `opts` tunes what the server would answer. */
function makeFakeClient({
  mailboxes = [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Deleted Items', specialUse: '\\Trash' }
  ],
  move = true,
  moveResult = {},
  copyResult = {},
  deleteResult = true,
  createResult = undefined,
  createError = null,
  namespacePrefix = ''
} = {}) {
  const normalize = (p) => {
    if (String(p).toUpperCase() === 'INBOX') return 'INBOX'
    return namespacePrefix && !p.startsWith(namespacePrefix) ? namespacePrefix + p : p
  }
  const calls = []
  const client = {
    user: 'tester',
    capabilities: new Set(move ? ['IMAP4rev1', 'MOVE', 'UIDPLUS'] : ['IMAP4rev1', 'UIDPLUS']),
    calls,
    async list() { calls.push(['list']); return mailboxes },
    async getMailboxLock(p) {
      const resolved = normalize(p)
      calls.push(['lock', resolved])
      return { path: resolved, release() { calls.push(['release']) } }
    },
    async mailboxCreate(p) {
      calls.push(['mailboxCreate', p])
      if (createError) throw createError
      return createResult ?? { path: p, created: true }
    },
    async messageCopy(range, dest, o) { calls.push(['messageCopy', range, dest, o]); return copyResult },
    async messageDelete(range, o) { calls.push(['messageDelete', range, o]); return deleteResult },
    async messageMove(range, dest, o) {
      calls.push(['messageMove', range, dest, o])
      if (this.capabilities.has('MOVE')) return moveResult
      // ImapFlow without MOVE: COPY, then delete whatever the copy returned.
      const result = await this.messageCopy(range, dest, o)
      await this.messageDelete(range, { silent: true, ...o })
      return result
    },
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

async function del(id, query = 'folder=INBOX') {
  const res = await fetch(`${base}/api/message/${id}?${query}`, { method: 'DELETE', headers: authed })
  return { status: res.status, body: await res.json() }
}
async function move(id, body) {
  const res = await fetch(`${base}/api/message/${id}/move`, {
    method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

test('Delete in INBOX moves the message to the server\'s \\Trash mailbox and expunges nothing', async () => {
  const c = useClient()
  const res = await del(7)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true, trashed: true, folder: 'Deleted Items' })
  assert.deepEqual(find(c, 'messageMove').slice(1), [7, 'Deleted Items', { uid: true }])
  assert.ok(!names(c).includes('messageDelete'), 'a trashed message must not be expunged')
})

test('Trash is found by its special-use flag whatever it is called', async () => {
  const c = useClient({ mailboxes: [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: '[Gmail]/Trash', specialUse: '\\Trash' }
  ] })
  const res = await del(3)
  assert.equal(res.status, 200)
  assert.equal(find(c, 'messageMove')[2], '[Gmail]/Trash')
})

test('without a special-use flag a mailbox named Trash is used', async () => {
  const c = useClient({ mailboxes: [{ path: 'INBOX' }, { path: 'Trash' }, { path: 'Archive' }] })
  const res = await del(3)
  assert.equal(res.status, 200)
  assert.equal(find(c, 'messageMove')[2], 'Trash')
  assert.ok(!names(c).includes('mailboxCreate'))
})

test('Delete inside the Trash mailbox removes the message for good', async () => {
  const c = useClient()
  const res = await del(7, 'folder=Deleted%20Items')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true, trashed: false, folder: 'Deleted Items' })
  assert.deepEqual(find(c, 'messageDelete').slice(1), [7, { uid: true }])
  assert.ok(!names(c).includes('messageMove'), 'never move the Trash to itself')
})

test('?toTrash=false no longer means permanent delete (it was the truthy string "false")', async () => {
  const c = useClient()
  const res = await del(7, 'folder=INBOX&toTrash=false')
  assert.equal(res.status, 200)
  assert.equal(find(c, 'messageMove')[2], 'Deleted Items')
  assert.ok(!names(c).includes('messageDelete'))
})

test('with no Trash mailbox, Trash is created and the message moved there; nothing is expunged', async () => {
  const c = useClient({ mailboxes: [{ path: 'INBOX', specialUse: '\\Inbox' }] })
  const res = await del(7)
  assert.equal(res.status, 200)
  assert.deepEqual(find(c, 'mailboxCreate').slice(1), ['Trash'])
  assert.equal(find(c, 'messageMove')[2], 'Trash')
  assert.ok(!names(c).includes('messageDelete'))
})

test('the created mailbox path reported by the server is used (namespace prefix)', async () => {
  const c = useClient({
    mailboxes: [{ path: 'INBOX', specialUse: '\\Inbox' }],
    createResult: { path: 'INBOX.Trash', created: true }
  })
  await del(7)
  assert.equal(find(c, 'messageMove')[2], 'INBOX.Trash')
})

test('if Trash cannot be created the request fails and nothing is moved or deleted', async () => {
  const c = useClient({ mailboxes: [{ path: 'INBOX' }], createError: new Error('CREATE not permitted') })
  const res = await del(7)
  assert.equal(res.status, 500)
  assert.match(res.body.error, /CREATE not permitted/)
  assert.ok(!names(c).includes('messageMove'))
  assert.ok(!names(c).includes('messageDelete'))
})

test('a failed move (ImapFlow answers false) is an error, not success, and keeps the IMAP connection', async () => {
  const c = useClient({ moveResult: false })
  const res = await del(7)
  assert.equal(res.status, 500)
  assert.ok(res.body.error, 'the UI needs a message to show')
  assert.ok(!names(c).includes('messageDelete'))
  assert.ok(!names(c).includes('logout'), 'a refused move is not a broken connection')
  assert.ok(names(c).includes('release'), 'the mailbox lock is released')
})

test('a failed permanent delete inside Trash is an error, not success', async () => {
  const c = useClient({ deleteResult: false })
  const res = await del(7, 'folder=Deleted%20Items')
  assert.equal(res.status, 500)
  assert.ok(names(c).includes('release'))
  assert.ok(!names(c).includes('logout'))
})

// The UI names the mailbox without the server's namespace prefix ("Trash"), but
// the mailbox the server selects, and list() reports, is "INBOX.Trash". Comparing
// the raw folder would move the message from INBOX.Trash into itself, report
// success, and make a permanent delete from Trash impossible.
test('on a server with an INBOX. namespace, Delete in "Trash" removes for good instead of moving Trash to itself', async () => {
  const c = useClient({
    namespacePrefix: 'INBOX.',
    mailboxes: [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'INBOX.Trash', specialUse: '\\Trash' }
    ]
  })
  const res = await del(7, 'folder=Trash')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true, trashed: false, folder: 'INBOX.Trash' })
  assert.deepEqual(find(c, 'messageDelete').slice(1), [7, { uid: true }])
  assert.ok(!names(c).includes('messageMove'), 'a mailbox must never be moved into itself')
})

test('on a server with an INBOX. namespace, Delete in INBOX moves to INBOX.Trash', async () => {
  const c = useClient({
    namespacePrefix: 'INBOX.',
    mailboxes: [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'INBOX.Trash', specialUse: '\\Trash' }
    ]
  })
  const res = await del(7, 'folder=inbox')
  assert.equal(res.status, 200)
  assert.equal(find(c, 'messageMove')[2], 'INBOX.Trash')
  assert.ok(!names(c).includes('messageDelete'))
})

test('a \\Noselect mailbox is never chosen as Trash', async () => {
  const c = useClient({ mailboxes: [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Deleted Items', specialUse: '\\Trash', flags: new Set(['\\Noselect']) },
    { path: 'Trash', flags: new Set() }
  ] })
  const res = await del(7)
  assert.equal(res.status, 200)
  assert.equal(find(c, 'messageMove')[2], 'Trash')
})

test('without the MOVE extension a failed COPY never reaches the expunge', async () => {
  const c = useClient({ move: false, copyResult: false })
  const res = await del(7)
  assert.equal(res.status, 500)
  assert.ok(!names(c).includes('messageDelete'), 'ImapFlow would have expunged the only copy here')
})

test('without the MOVE extension a successful COPY is followed by removing the original', async () => {
  const c = useClient({ move: false, copyResult: { path: 'INBOX', destination: 'Deleted Items' } })
  const res = await del(7)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true, trashed: true, folder: 'Deleted Items' })
  const order = names(c).filter((n) => n === 'messageCopy' || n === 'messageDelete')
  assert.deepEqual(order, ['messageCopy', 'messageDelete'])
})

test('a message id that is not a positive integer is rejected before any IMAP call', async () => {
  const c = useClient()
  for (const id of ['abc', '0', '-4', '1.5']) {
    const res = await del(id)
    assert.equal(res.status, 400, `id ${id}`)
  }
  assert.deepEqual(c.calls, [])
})

test('POST /message/:id/move: a failed move is an error and does not expunge (no MOVE extension)', async () => {
  const c = useClient({ move: false, copyResult: false })
  const res = await move(9, { from: 'INBOX', to: 'Archive' })
  assert.equal(res.status, 500)
  assert.ok(!names(c).includes('messageDelete'))
})

test('POST /message/:id/move: ImapFlow answering false is an error', async () => {
  const c = useClient({ moveResult: false })
  const res = await move(9, { from: 'INBOX', to: 'Archive' })
  assert.equal(res.status, 500)
  assert.ok(!names(c).includes('logout'))
})

test('POST /message/:id/move still moves and reports success', async () => {
  const c = useClient()
  const res = await move(9, { from: 'INBOX', to: 'Archive' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true })
  assert.deepEqual(find(c, 'messageMove').slice(1), [9, 'Archive', { uid: true }])
})

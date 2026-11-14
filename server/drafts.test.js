import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// "Save Draft" must store the message on the IMAP server, in the account's
// Drafts mailbox, so it shows in the Drafts folder (and in every other client).
// The route is exercised through createApp() with a fake ImapFlow client seeded
// into the account's pool. The fake follows ImapFlow 1.7.8: list() entries carry
// `specialUse` (also derived from localized names), append(path, content, flags,
// idate) resolves { destination, uid? } and throws when the server says NO, and
// mailboxCreate resolves { path, created }. No real server is contacted.

const TOKEN = 'drafts-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-drafts-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

const { createApp } = await import('./index.js')
const { state } = await import('./lib/state.js')
const { getPoolFor } = await import('./lib/imap.js')

const EMAIL = 'tester@example.test'
const json = { 'x-leoposta-token': TOKEN, 'x-account': EMAIL, 'content-type': 'application/json' }

let server
let base
let savedAccounts

before(async () => {
  savedAccounts = state.accounts
  state.accounts = [{
    id: 'acct-test', name: 'Tester', email: EMAIL, imapHost: '127.0.0.1', imapPort: 1, imapTls: false,
    imapUser: EMAIL, imapPass: 'x'
  }]
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  state.accounts = savedAccounts
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

const DEFAULT_MAILBOXES = [
  { path: 'INBOX', specialUse: '\\Inbox' },
  { path: 'INBOX.Entwürfe', specialUse: '\\Drafts' },
  { path: 'INBOX.Drafts' },
  { path: 'Sent', specialUse: '\\Sent' }
]

function makeFakeClient({ mailboxes = DEFAULT_MAILBOXES, appendError, appendResult, createResult } = {}) {
  const calls = []
  return {
    usable: true,
    authenticated: 'tester',
    calls,
    capabilities: new Map(),
    async list() {
      calls.push(['list'])
      return mailboxes.map((m) => ({ flags: new Set(), ...m }))
    },
    async mailboxCreate(p) {
      calls.push(['mailboxCreate', p])
      return createResult || { path: p, created: true }
    },
    async append(p, content, flags, idate) {
      calls.push(['append', p, content, flags, idate])
      if (appendError) throw appendError
      return appendResult || { destination: p, uid: 42 }
    },
    logout() { calls.push(['logout']); return Promise.resolve() }
  }
}

let fake
function useClient(opts) {
  fake = makeFakeClient(opts)
  const pool = getPoolFor(state.accounts[0])
  pool.client = fake
  pool.connectP = null
  return fake
}
const find = (client, name) => client.calls.find((c) => c[0] === name)
const names = (client) => client.calls.map((c) => c[0])

beforeEach(() => { fake = null })

async function saveDraft(body) {
  const res = await fetch(`${base}/api/drafts`, { method: 'POST', headers: json, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

test('Save Draft appends the message to the mailbox flagged \\Drafts, whatever it is called', async () => {
  const c = useClient()
  const res = await saveDraft({ to: ['alice@example.test'], subject: 'Plan', body: 'half-written' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true, folder: 'INBOX.Entwürfe', uid: 42 })
  const call = find(c, 'append')
  assert.ok(call, 'the draft must be APPENDed to the server')
  assert.equal(call[1], 'INBOX.Entwürfe', 'the special-use \\Drafts mailbox wins over a plain "Drafts" name')
})

test('the draft is flagged \\Draft and \\Seen and its raw source carries the headers and body', async () => {
  const c = useClient()
  await saveDraft({ to: ['alice@example.test'], cc: ['carol@example.test'], bcc: ['bob@example.test'], subject: 'Plan', body: 'half-written' })
  const [, , content, flags] = find(c, 'append')
  assert.deepEqual([...flags].sort(), ['\\Draft', '\\Seen'])
  assert.ok(Buffer.isBuffer(content), 'ImapFlow append takes the raw message as its second argument')
  const raw = content.toString('utf-8')
  assert.match(raw, /^From: "?Tester"? <tester@example\.test>/m)
  assert.match(raw, /^To: alice@example\.test/m)
  assert.match(raw, /^Cc: carol@example\.test/m)
  assert.match(raw, /^Bcc: bob@example\.test/m, 'a draft keeps its Bcc so it can be finished later')
  assert.match(raw, /^Subject: Plan/m)
  assert.match(raw, /half-written/)
})

test('without a special-use flag a mailbox named Drafts (any case) is used', async () => {
  const c = useClient({ mailboxes: [{ path: 'INBOX' }, { path: 'drafts' }, { path: 'Archive' }] })
  const res = await saveDraft({ subject: 'x', body: 'y' })
  assert.equal(res.status, 200)
  assert.equal(find(c, 'append')[1], 'drafts')
  assert.ok(!names(c).includes('mailboxCreate'))
})

test('a \\Noselect mailbox is never used as Drafts', async () => {
  const c = useClient({ mailboxes: [
    { path: 'INBOX' },
    { path: 'Drafts', specialUse: '\\Drafts', flags: new Set(['\\Noselect']) },
    { path: 'INBOX.Drafts', specialUse: '\\Drafts' }
  ] })
  await saveDraft({ subject: 'x', body: 'y' })
  assert.equal(find(c, 'append')[1], 'INBOX.Drafts')
})

test('with no Drafts mailbox, Drafts is created and the draft appended to the path the server reports', async () => {
  const c = useClient({
    mailboxes: [{ path: 'INBOX', specialUse: '\\Inbox' }],
    createResult: { path: 'INBOX.Drafts', created: true }
  })
  const res = await saveDraft({ subject: 'x', body: 'y' })
  assert.equal(res.status, 200)
  assert.deepEqual(find(c, 'mailboxCreate').slice(1), ['Drafts'])
  assert.equal(find(c, 'append')[1], 'INBOX.Drafts')
  assert.equal(res.body.folder, 'INBOX.Drafts')
})

test('a draft needs no recipients and no subject', async () => {
  const c = useClient()
  const res = await saveDraft({ body: 'just an idea' })
  assert.equal(res.status, 200)
  assert.ok(find(c, 'append'))
})

test('a refused APPEND is an error the UI can show, not success', async () => {
  useClient({ appendError: Object.assign(new Error('Command failed'), { responseText: 'Over quota' }) })
  const res = await saveDraft({ subject: 'x', body: 'y' })
  assert.equal(res.status, 500)
  assert.ok(res.body.error, 'the UI needs a message to show')
  assert.notEqual(res.body.success, true)
})

test('a draft larger than the default 1 MB JSON limit (attachments) is accepted', async () => {
  const c = useClient()
  const content = Buffer.alloc(1536 * 1024, 7).toString('base64')
  const res = await saveDraft({
    subject: 'big', body: 'see attachment',
    // The shape Compose sends (src/lib/attachments.ts OutboundAttachment): base64, no encoding field.
    attachments: [{ filename: 'a.bin', content, contentType: 'application/octet-stream' }]
  })
  assert.equal(res.status, 200)
  const raw = find(c, 'append')[2].toString('utf-8')
  assert.match(raw, /filename=a\.bin/)
  assert.ok(raw.includes(content.slice(0, 76)), 'the base64 content is decoded once, not encoded a second time')
})

test('without an account the route answers 400 and touches no mailbox', async () => {
  const saved = state.accounts
  state.accounts = []
  try {
    const res = await fetch(`${base}/api/drafts`, {
      method: 'POST',
      headers: { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'x' })
    })
    assert.equal(res.status, 400)
  } finally {
    state.accounts = saved
  }
})

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
const structures = JSON.parse(
  fs.readFileSync(new URL('./fixtures/imapflow-bodystructure.json', import.meta.url), 'utf-8')
)

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

test('the flag names the UI and common servers use are accepted', async () => {
  const c = useClient({ messages: [message(7)] })
  const names_ = ['\\Seen', '\\Flagged', '\\Answered', '$Forwarded', '$MDNSent', '$label1', 'NonJunk', 'Junk']
  const res = await setFlags(7, { folder: 'INBOX', add: names_, remove: [] })
  assert.equal(res.status, 200)
  assert.deepEqual(find(c, 'messageFlagsAdd')[2], names_)
})

test('if the removal is refused after the addition went through, the request still reports the failure', async () => {
  const c = useClient({ messages: [message(7)], removeResult: false })
  const res = await setFlags(7, { folder: 'INBOX', add: ['\\Flagged'], remove: ['\\Seen'] })
  assert.equal(res.status, 500)
  assert.ok(res.body.error)
  assert.ok(names(c).includes('messageFlagsAdd'), 'the first half was applied; the error tells the UI to re-sync')
  assert.ok(!names(c).includes('logout'))
})

test('a folder that is not a string is rejected before the server is touched', async () => {
  const c = useClient({ messages: [message(7)] })
  for (const folder of [['INBOX', 'Sent'], { a: 1 }, 5, '']) {
    const res = await setFlags(7, { folder, add: ['\\Seen'] })
    assert.equal(res.status, 400, JSON.stringify(folder))
  }
  assert.deepEqual(names(c), [])
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

// ── received attachments ────────────────────────────────────────────────────

const MIXED = crlf([
  'From: Alice <alice@example.test>',
  'Subject: files',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'see attached',
  '--b1',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 first').toString('base64'),
  '--b1',
  'Content-Type: application/octet-stream',
  "Content-Disposition: attachment; filename*=UTF-8''%C3%BCber.bin",
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from([0, 1, 2, 255, 254]).toString('base64'),
  '--b1--',
  ''
])

async function download(id, attachmentId, { query = 'folder=INBOX', headers = authed } = {}) {
  const res = await fetch(`${base}/api/message/${id}/attachment/${attachmentId}?${query}`, { headers })
  const bytes = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, bytes, text: () => bytes.toString('utf-8') }
}

test('the message lists its attachments by index id, not by file name', async () => {
  useClient({ messages: [message(7, { source: MIXED })] })
  const res = await getMessage(7)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.attachments.map((a) => [a.id, a.filename, a.size]), [
    ['0', 'report.pdf', 14],
    ['1', 'über.bin', 5]
  ])
})

test('an attachment downloads as its exact bytes, with a download header and hardening headers', async () => {
  const c = useClient({ messages: [message(7, { source: MIXED })] })
  const pdf = await download(7, '0')
  assert.equal(pdf.status, 200)
  assert.equal(pdf.text(), '%PDF-1.4 first')
  assert.equal(pdf.headers.get('content-type'), 'application/pdf')
  assert.equal(pdf.headers.get('content-disposition'), 'attachment; filename="report.pdf"')
  assert.equal(pdf.headers.get('content-length'), '14')
  assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff')
  assert.match(pdf.headers.get('content-security-policy'), /^sandbox\b/)
  assert.match(pdf.headers.get('cache-control'), /no-store/)
  // By UID, and only the source is asked for.
  assert.deepEqual(find(c, 'fetchOne').slice(1), [7, { source: true }, { uid: true }])
  assert.ok(names(c).includes('release'), 'the mailbox lock is released')
  assert.ok(!names(c).includes('logout'))

  const bin = await download(7, '1')
  assert.deepEqual([...bin.bytes], [0, 1, 2, 255, 254])
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream')
  assert.match(bin.headers.get('content-disposition'), /filename\*=UTF-8''%C3%BCber\.bin/)
  assert.doesNotMatch(bin.headers.get('content-disposition'), /filename="[^"]*%/)
})

test('a file name that decodes to CR/LF cannot break the response or inject a header', async () => {
  // Only the RFC 2231 form decodes %0D%0A to real CR/LF (a quoted filename keeps the
  // percent text literally), so this is what actually reaches contentDispositionHeader.
  const evil = crlf([
    'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/plain',
    "Content-Disposition: attachment; filename*=UTF-8''x%0D%0ASet-Cookie%3A%20a%3Db.txt", '', 'body',
    '--b--', ''
  ])
  const parsed = await (await import('./lib/attachments.js')).parseMessageSource(evil)
  assert.match(parsed.attachments[0].filename, /\r\n/, 'the fixture must really contain CR/LF')
  useClient({ messages: [message(7, { source: evil })] })
  const res = await download(7, '0')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('set-cookie'), null)
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="xSet-Cookie: a=b.txt"')
  assert.equal(res.text(), 'body')
})

test('an HTML attachment is only ever offered as a download, with nosniff', async () => {
  const odd = crlf([
    'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/html; charset=utf-8', 'Content-Disposition: attachment; filename="page.html"', '', '<script>1</script>',
    '--b--', ''
  ])
  useClient({ messages: [message(7, { source: odd })] })
  const res = await download(7, '0')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/html\b/) // Express adds the charset to text types
  assert.match(res.headers.get('content-disposition'), /^attachment;/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('an unknown attachment, including an old file-name style id, is a 404 that keeps the connection', async () => {
  const c = useClient({ messages: [message(7, { source: MIXED })] })
  for (const id of ['2', '99', 'report.pdf', '-1', '01']) {
    const res = await download(7, id)
    assert.equal(res.status, 404, id)
    assert.equal(JSON.parse(res.text()).error, 'attachment_not_found', id)
  }
  assert.ok(!names(c).includes('logout'), 'not finding an attachment is not a broken connection')
})

test('an unknown message is a 404 that keeps the connection and releases the lock', async () => {
  const c = useClient({ messages: [message(7, { source: MIXED })] })
  const res = await download(8, '0')
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.text()).error, 'message_not_found')
  assert.ok(!names(c).includes('logout'))
  assert.ok(names(c).includes('release'))
})

test('a bad message id or folder is rejected before the server is touched', async () => {
  const c = useClient({ messages: [message(7, { source: MIXED })] })
  for (const id of ['abc', '0', '7.5', '-7']) {
    assert.equal((await download(id, '0')).status, 400, id)
  }
  assert.equal((await download(7, '0', { query: 'folder=A&folder=B' })).status, 400)
  assert.deepEqual(names(c), [])
})

test('an attachment download needs the token header; the token in the URL no longer works', async () => {
  useClient({ messages: [message(7, { source: MIXED })] })
  assert.equal((await download(7, '0', { headers: {} })).status, 401)
  const viaUrl = await download(7, '0', { query: `folder=INBOX&token=${TOKEN}`, headers: { 'x-account': EMAIL } })
  assert.equal(viaUrl.status, 401)
})

test('a message body in another charset is decoded from the bytes, not from a UTF-8 string of them', async () => {
  const latin1 = Buffer.concat([
    Buffer.from('From: a@example.test\r\nSubject: caf\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
    Buffer.from([0x63, 0x61, 0x66, 0xe9]), // "café" in ISO-8859-1
    Buffer.from('\r\n')
  ])
  useClient({ messages: [message(7, { source: latin1, flags: ['\\Seen'] })] })
  const res = await getMessage(7)
  assert.equal(res.status, 200)
  assert.equal(res.body.body.trim(), 'café')
})

test('the list shows a paperclip from the real ImapFlow body structure, with no download id', async () => {
  useClient({ messages: [
    message(1, { bodyStructure: structures.mixed }),
    message(2, { bodyStructure: structures.alternative }),
    message(3, { bodyStructure: structures.plain })
  ] })
  const res = await fetch(`${base}/api/messages?folder=INBOX`, { headers: authed })
  const { messages } = await res.json()
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]))
  assert.equal(byId['1'].hasAttachment, true)
  assert.equal(byId['1'].attachmentCount, 3)
  assert.deepEqual(byId['1'].attachments.map((a) => a.filename), ['report.pdf', 'logo.png', 'fwd.eml'])
  for (const a of byId['1'].attachments) assert.equal('id' in a, false)
  assert.equal(byId['2'].hasAttachment, false)
  assert.equal(byId['3'].attachmentCount, 0)
})

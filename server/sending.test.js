import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { simpleParser } from 'mailparser'

process.env.LEOPOSTA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-sending-'))
process.env.LEOPOSTA_TOKEN = 'sending-test-token-0123456789abcdef'

const { buildMessageData, outboundAttachments } = await import('./routes/send.js')
const { buildSentSource, findOrCreateSentPath } = await import('./lib/imap.js')

const acct = { name: 'Leo "the" Sender', email: 'leo@example.test' }
const build = async (data) => simpleParser(await new MailComposer(data).compile().build())

test('attachments sent as base64 by Compose arrive as the original bytes', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80])
  const data = buildMessageData(acct, {
    to: ['r@example.test'], subject: 's', body: 'b',
    attachments: [{ filename: 'pixel.png', content: bytes.toString('base64'), contentType: 'image/png' }]
  })
  const parsed = await build(data)
  assert.equal(parsed.attachments.length, 1)
  assert.equal(parsed.attachments[0].filename, 'pixel.png')
  assert.equal(parsed.attachments[0].contentType, 'image/png')
  assert.deepEqual(parsed.attachments[0].content, bytes)
})

test('outboundAttachments defaults the content type', () => {
  const [a] = outboundAttachments([{ filename: 'x', content: 'AA==' }])
  assert.equal(a.contentType, 'application/octet-stream')
  assert.equal(a.encoding, 'base64')
})

test('a plain-text body gets no HTML part, and text that looks like markup stays', async () => {
  const body = 'Line 1\nAnna <anna@example.test> wrote:\n> quoted <b>not bold</b>'
  const data = buildMessageData(acct, { to: ['r@example.test'], subject: 's', body })
  assert.equal(data.html, undefined)
  const parsed = await build(data)
  assert.equal(parsed.html, false)
  assert.equal(parsed.text.trimEnd(), body)
})

test('bodyHtml, when given, is scrubbed and sent as the HTML part', () => {
  const data = buildMessageData(acct, { to: ['r@example.test'], body: 'x', bodyHtml: '<p>hi</p><script>evil()</script>' })
  assert.equal(data.html, '<p>hi</p>')
})

test('the From display name is encoded safely even with quotes in it', async () => {
  const parsed = await build(buildMessageData(acct, { to: ['r@example.test'], body: 'x' }))
  assert.deepEqual(parsed.from.value, [{ name: 'Leo "the" Sender', address: 'leo@example.test' }])
})

test('reply headers are passed through', async () => {
  const parsed = await build(buildMessageData(acct, {
    to: ['r@example.test'], body: 'x', inReplyTo: '<a@x>', references: '<z@x> <a@x>'
  }))
  assert.equal(parsed.inReplyTo, '<a@x>')
  assert.deepEqual(parsed.references, ['<z@x>', '<a@x>'])
})

test('the Sent copy is the sent message (same Message-ID and Date) with Bcc kept', async () => {
  const date = new Date('2026-01-02T03:04:05Z')
  const data = buildMessageData(acct, { to: ['r@example.test'], bcc: ['hidden@example.test'], subject: 'Grüße 🎉', body: 'x' })
  const raw = await buildSentSource(data, { messageId: '<m1@example.test>', date })
  const parsed = await simpleParser(raw)
  assert.equal(parsed.messageId, '<m1@example.test>')
  assert.equal(parsed.date.toISOString(), date.toISOString())
  assert.equal(parsed.subject, 'Grüße 🎉')
  assert.equal(parsed.bcc.value[0].address, 'hidden@example.test')
  assert.doesNotMatch(raw.toString(), /accountId/i)
})

function fakeClient(boxes) {
  const created = []
  return {
    created,
    list: async () => boxes.map((b) => ({ flags: new Set(), ...b })),
    mailboxCreate: async (p) => { created.push(p); return { path: p } }
  }
}

test('Sent is the \\Sent special-use mailbox, whatever it is called', async () => {
  const c = fakeClient([{ path: 'INBOX', name: 'INBOX' }, { path: 'INBOX.Gesendet', name: 'Gesendet', specialUse: '\\Sent' }, { path: 'Sent', name: 'Sent' }])
  assert.equal(await findOrCreateSentPath(c), 'INBOX.Gesendet')
})

test('without special-use, a mailbox named Sent under a namespace prefix is used', async () => {
  const c = fakeClient([{ path: 'INBOX', name: 'INBOX' }, { path: 'INBOX.Sent', name: 'Sent' }])
  assert.equal(await findOrCreateSentPath(c), 'INBOX.Sent')
})

test('with no Sent mailbox at all, one is created (never INBOX)', async () => {
  const c = fakeClient([{ path: 'INBOX', name: 'INBOX' }, { path: 'Absent', name: 'Absent', specialUse: '\\Sent', flags: new Set(['\\NonExistent']) }])
  assert.equal(await findOrCreateSentPath(c), 'Sent')
  assert.deepEqual(c.created, ['Sent'])
})

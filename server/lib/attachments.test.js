import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import {
  attachmentAt,
  bodyStructureAttachments,
  contentDispositionHeader,
  listAttachments,
  mergePgpAttachments,
  parseMessageSource,
  safeContentType
} from './attachments.js'

const structures = JSON.parse(
  fs.readFileSync(new URL('../fixtures/imapflow-bodystructure.json', import.meta.url), 'utf-8')
)

const crlf = (lines) => Buffer.from(lines.join('\r\n'), 'utf-8')

const MIXED = crlf([
  'From: a@example.test',
  'To: b@example.test',
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
  "Content-Type: application/octet-stream",
  "Content-Disposition: attachment; filename*=UTF-8''%C3%BCber.bin",
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from([0, 1, 2, 255, 254]).toString('base64'),
  '--b1',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('no name').toString('base64'),
  '--b1--',
  ''
])

test('parseMessageSource reads a Buffer and lists attachments in MIME order', async () => {
  const parsed = await parseMessageSource(MIXED)
  assert.equal(parsed.text.trim(), 'see attached')
  assert.equal(parsed.attachments.length, 3)
})

test('listAttachments gives each attachment a stable index id, a name and its size', async () => {
  const parsed = await parseMessageSource(MIXED)
  const list = listAttachments(parsed.attachments)
  assert.deepEqual(list.map((a) => a.id), ['0', '1', '2'])
  assert.deepEqual(list.map((a) => a.filename), ['report.pdf', 'über.bin', 'attachment-3'])
  assert.deepEqual(list.map((a) => a.size), ['%PDF-1.4 first'.length, 5, 'no name'.length])
  assert.equal(list[0].contentType, 'application/pdf')
  for (const a of list) assert.equal(typeof a.filename, 'string')
})

test('two attachments with the same file name get different ids', async () => {
  const raw = crlf([
    'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="a.txt"', '', 'one',
    '--b', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="a.txt"', '', 'two',
    '--b--', ''
  ])
  const parsed = await parseMessageSource(raw)
  const list = listAttachments(parsed.attachments)
  assert.deepEqual(list.map((a) => a.id), ['0', '1'])
  assert.equal(attachmentAt(parsed.attachments, '1').content.toString().trim(), 'two')
})

test('attachmentAt returns the bytes of the attachment at that index', async () => {
  const parsed = await parseMessageSource(MIXED)
  assert.equal(attachmentAt(parsed.attachments, '0').content.toString(), '%PDF-1.4 first')
  assert.deepEqual([...attachmentAt(parsed.attachments, '1').content], [0, 1, 2, 255, 254])
})

test('attachmentAt rejects anything that is not an in-range index', async () => {
  const parsed = await parseMessageSource(MIXED)
  for (const id of ['3', '99', '-1', '1.5', '01', '', 'abc', '1e1', ' 1', '0x1', '99999999999', undefined, null, 1]) {
    assert.equal(attachmentAt(parsed.attachments, id), null, `id ${JSON.stringify(id)}`)
  }
})

test('bodyStructureAttachments finds attachments in ImapFlow body structures', () => {
  const found = bodyStructureAttachments(structures.mixed)
  assert.deepEqual(
    found.map((a) => [a.filename, a.contentType, a.size]),
    [['report.pdf', 'application/pdf', 4096], ['logo.png', 'image/png', 100], ['fwd.eml', 'message/rfc822', 900]]
  )
  assert.equal(found[1].contentId, '<cid1>')
})

test('bodyStructureAttachments does not look inside an attached message', () => {
  const names = bodyStructureAttachments(structures.mixed).map((a) => a.filename)
  assert.ok(!names.includes('inner.zip'))
})

test('bodyStructureAttachments gives list entries no download id', () => {
  for (const a of bodyStructureAttachments(structures.mixed)) assert.equal('id' in a, false)
})

test('bodyStructureAttachments sees no attachment in plain or alternative mail', () => {
  assert.deepEqual(bodyStructureAttachments(structures.plain), [])
  assert.deepEqual(bodyStructureAttachments(structures.alternative), [])
  assert.deepEqual(bodyStructureAttachments(undefined), [])
  assert.deepEqual(bodyStructureAttachments(null), [])
})

test('bodyStructureAttachments accepts a name from Content-Type and an unnamed attachment disposition', () => {
  const found = bodyStructureAttachments(structures.legacy)
  assert.deepEqual(found.map((a) => a.filename), ['old.bin', 'attachment'])
})

test('bodyStructureAttachments counts an unnamed attached message, as mailparser does', () => {
  const tree = {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 3 },
      { part: '2', type: 'message/rfc822', size: 44 }
    ]
  }
  assert.deepEqual(bodyStructureAttachments(tree).map((a) => a.contentType), ['message/rfc822'])
})

test('bodyStructureAttachments handles a message that is one attachment part', () => {
  const single = {
    type: 'application/pdf', size: 10, disposition: 'attachment',
    dispositionParameters: { filename: 'one.pdf' }
  }
  assert.deepEqual(bodyStructureAttachments(single).map((a) => a.filename), ['one.pdf'])
})

test('contentDispositionHeader keeps a plain ASCII name readable', () => {
  assert.equal(contentDispositionHeader('report.pdf'), 'attachment; filename="report.pdf"')
})

test('contentDispositionHeader sends non-ASCII names as RFC 5987 with an ASCII fallback', () => {
  assert.equal(
    contentDispositionHeader('Überblick (final).pdf'),
    "attachment; filename=\"_berblick (final).pdf\"; filename*=UTF-8''%C3%9Cberblick%20%28final%29.pdf"
  )
})

test('contentDispositionHeader never shows percent escapes in the quoted name', () => {
  assert.doesNotMatch(contentDispositionHeader('über.pdf'), /filename="[^"]*%/)
})

test('contentDispositionHeader neutralises quotes, backslashes, separators and header injection', () => {
  // A quote cannot sit inside the quoted name, so the exact name travels as
  // filename* (percent-encoded); the backslash is a path separator and is replaced.
  assert.equal(
    contentDispositionHeader('a"b\\c.txt'),
    "attachment; filename=\"a_b_c.txt\"; filename*=UTF-8''a%22b_c.txt"
  )
  assert.equal(contentDispositionHeader('../../etc/passwd'), 'attachment; filename=".._.._etc_passwd"')
  // Without CR/LF the rest of the name is just text inside the quoted value, and
  // Node accepts the header (a raw CR/LF makes setHeader throw).
  const injected = contentDispositionHeader('x\r\nSet-Cookie: a=b.txt')
  assert.doesNotMatch(injected, /[\r\n]/)
  assert.doesNotThrow(() => http.validateHeaderValue('Content-Disposition', injected))
  assert.equal(contentDispositionHeader('a;b.txt'), 'attachment; filename="a;b.txt"')
})

test('contentDispositionHeader falls back to a generic name and bounds the length', () => {
  for (const empty of ['', '   ', undefined, null, '\r\n']) {
    assert.equal(contentDispositionHeader(empty), 'attachment; filename="attachment"')
  }
  const header = contentDispositionHeader('x'.repeat(5000) + '.pdf')
  assert.ok(header.length < 600, `header is ${header.length} chars`)
})

test('safeContentType passes a plain type/subtype and refuses everything else', () => {
  assert.equal(safeContentType('application/pdf'), 'application/pdf')
  assert.equal(safeContentType('IMAGE/PNG'), 'image/png')
  assert.equal(safeContentType('text/plain; charset=utf-8'), 'text/plain')
  for (const bad of ['', undefined, null, 'pdf', 'text/html\r\nX-A: b', 'a/b/c', 'text/<script>', 42]) {
    assert.equal(safeContentType(bad), 'application/octet-stream', JSON.stringify(bad))
  }
})

test('mergePgpAttachments appends decrypted attachments without an id and skips duplicates by name', () => {
  const own = [{ id: '0', filename: 'a.pdf', size: 1 }]
  const pgp = [
    { id: 'a.pdf', filename: 'a.pdf', size: 1 },
    { id: 'b.txt', filename: 'b.txt', size: 2, contentType: 'text/plain' }
  ]
  const merged = mergePgpAttachments(own, pgp)
  assert.deepEqual(merged.map((a) => a.filename), ['a.pdf', 'b.txt'])
  assert.equal(merged[0].id, '0')
  assert.equal('id' in merged[1], false)
  assert.deepEqual(mergePgpAttachments(own, undefined), own)
})

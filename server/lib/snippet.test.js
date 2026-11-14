import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { previewPart, snippetFromPart, cleanSnippet, addSnippets, SNIPPET_BYTES } from './snippet.js'

const structures = JSON.parse(
  fs.readFileSync(new URL('../fixtures/imapflow-bodystructure.json', import.meta.url), 'utf-8')
)

test('previewPart picks the readable text part, not an attachment', () => {
  assert.deepEqual(previewPart(structures.mixed), { part: '1', type: 'text/plain', charset: 'utf-8', encoding: '7bit' })
})

test('previewPart prefers text/plain inside multipart/alternative and falls back to html', () => {
  const alt = {
    type: 'multipart/alternative',
    childNodes: [
      { part: '1', type: 'text/html', parameters: { charset: 'utf-8' }, encoding: 'quoted-printable' },
      { part: '2', type: 'text/plain', parameters: { charset: 'iso-8859-1' }, encoding: 'base64' }
    ]
  }
  assert.equal(previewPart(alt).part, '2')
  const htmlOnly = { type: 'multipart/related', childNodes: [{ part: '1', type: 'text/html', encoding: '7bit' }, { part: '2', type: 'image/png', id: '<x>' }] }
  assert.equal(previewPart(htmlOnly).type, 'text/html')
})

test('a single-part message previews section 1', () => {
  assert.equal(previewPart({ type: 'text/plain', encoding: '7bit' }).part, '1')
})

test('no preview for a message with only an attachment or a named text file', () => {
  assert.equal(previewPart({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'a.txt' } }] }), null)
  assert.equal(previewPart({ type: 'message/rfc822', part: '1' }), null)
  assert.equal(previewPart(null), null)
})

test('snippet decodes truncated quoted-printable latin-1', async () => {
  const bytes = Buffer.from('Gr=FC=DFe aus M=FCnchen, soft=\r\nbreak =E')
  assert.equal(await snippetFromPart(bytes, { type: 'text/plain', charset: 'iso-8859-1', encoding: 'quoted-printable' }), 'Grüße aus München, softbreak')
})

test('snippet decodes base64 cut in the middle of a quantum and of a UTF-8 character', async () => {
  const full = Buffer.from('Hällo wörld ✓ ✓ ✓').toString('base64')
  const s = await snippetFromPart(Buffer.from(full.slice(0, full.length - 3)), { type: 'text/plain', charset: 'utf-8', encoding: 'base64' })
  assert.match(s, /^Hällo wörld ✓/)
  assert.ok(!s.includes('�'), s)
})

test('snippet of html is its text, without tags, styles or scripts', async () => {
  const html = Buffer.from('<html><head><style>p{color:red}</style></head><body><p>Hello <b>there</b></p><script>x()</script></body></html>')
  assert.equal(await snippetFromPart(html, { type: 'text/html', charset: 'utf-8', encoding: '7bit' }), 'Hello there')
})

test('cleanSnippet drops quoted lines and PGP armor and collapses whitespace', () => {
  assert.equal(cleanSnippet('Thanks!\n\n> old\n>> older\nBye'), 'Thanks! Bye')
  assert.equal(cleanSnippet('-----BEGIN PGP MESSAGE-----\nabc'), '')
  assert.equal(cleanSnippet('x'.repeat(500)).length, 200)
})

test('addSnippets fetches only the first bytes of each chosen section, one FETCH per section', async () => {
  const calls = []
  const parts = {
    1: Buffer.from('plain one'),
    2: Buffer.from('<p>html two</p>')
  }
  const client = {
    fetch(range, query, opts) {
      calls.push([range, query, opts])
      const key = query.bodyParts[0].key
      return (async function* () {
        for (const uid of range.split(',').map(Number)) yield { uid, bodyParts: new Map([[key, uid === 12 ? parts[2] : parts[1]]]) }
      })()
    }
  }
  const items = [
    { entry: {}, uid: 10, bodyStructure: { type: 'text/plain' } },
    { entry: {}, uid: 11, bodyStructure: { type: 'text/plain' } },
    { entry: {}, uid: 12, bodyStructure: { type: 'multipart/alternative', childNodes: [{ part: '1', type: 'image/png' }, { part: '2', type: 'text/html' }] } },
    { entry: {}, uid: 13, bodyStructure: { type: 'image/png' } }
  ]
  await addSnippets(client, items)
  assert.deepEqual(items.map((i) => i.entry.snippet), ['plain one', 'plain one', 'html two', undefined])
  assert.deepEqual(calls.map((c) => c[0]), ['10,11', '12'])
  assert.deepEqual(calls[0][1].bodyParts, [{ key: '1', maxLength: SNIPPET_BYTES }])
  assert.equal(calls[0][2].uid, true)
})

test('a failing preview FETCH leaves previews empty and does not throw', async () => {
  const client = { fetch() { throw new Error('boom') } }
  const items = [{ entry: {}, uid: 1, bodyStructure: { type: 'text/plain' } }]
  await addSnippets(client, items)
  assert.equal(items[0].entry.snippet, undefined)
})

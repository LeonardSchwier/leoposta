import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVcf, MAX_CARD_BYTES, MAX_CARDS_PER_IMPORT } from './vcf.js'

const GOOD_SINGLE =
  'BEGIN:VCARD\r\n' +
  'VERSION:3.0\r\n' +
  'UID:alice-001\r\n' +
  'FN:Alice Example\r\n' +
  'EMAIL:alice@example.com\r\n' +
  'END:VCARD\r\n'

test('parseVcf: well-formed single card', () => {
  const { cards, errors } = parseVcf(GOOD_SINGLE)
  assert.equal(cards.length, 1)
  assert.deepEqual(errors, [])
  assert.equal(typeof cards[0].uid, 'string')
  assert.equal(typeof cards[0].raw, 'string')
  assert.ok(cards[0].uid.length > 0)
})

test('parseVcf: multiple cards', () => {
  const { cards, errors } = parseVcf(GOOD_SINGLE + GOOD_SINGLE.replace('alice-001', 'bob-001').replace(/Alice/g, 'Bob').replace(/alice@example.com/, 'bob@example.com'))
  assert.equal(cards.length, 2)
  assert.deepEqual(errors, [])
})

test('parseVcf: empty blob has zero cards and a descriptive error', () => {
  const { cards, errors } = parseVcf('')
  assert.equal(cards.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /no cards found|empty/i)
})

test('parseVcf: junk that has BEGIN..END but no VERSION is rejected', () => {
  const { cards, errors } = parseVcf('BEGIN:VCARD\r\nUID:x\r\nEND:VCARD\r\n')
  assert.equal(cards.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /VERSION/i)
})

test('parseVcf: card without UID gets a synthesized one', () => {
  const { cards, errors } = parseVcf('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:NoUid\r\nEND:VCARD\r\n')
  assert.equal(cards.length, 1, 'errors=' + JSON.stringify(errors))
  assert.equal(cards[0].uid.startsWith('leoposta_'), true)
})

test('parseVcf: oversized card is rejected and reported', () => {
  const big = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:' + 'x'.repeat(MAX_CARD_BYTES + 1) + '\r\nEND:VCARD\r\n'
  const { cards, errors } = parseVcf(big)
  assert.equal(cards.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /too large/i)
})

test('parseVcf: too many cards hits the per-import cap', () => {
  const many = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:u\r\nEND:VCARD\r\n'.repeat(MAX_CARDS_PER_IMPORT + 1)
  const { cards, errors } = parseVcf(many)
  assert.equal(cards.length, MAX_CARDS_PER_IMPORT)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /too many cards/i)
})

test('parseVcf: trailing junk between END:VCARD and next BEGIN is dropped', () => {
  const { cards, errors } = parseVcf('BEGIN:VCARD\r\nVERSION:4.0\r\nUID:a\r\nEND:VCARD\r\n<garbage>\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nUID:b\r\nEND:VCARD\r\n')
  assert.equal(cards.length, 2)
  assert.deepEqual(errors, [])
})

test('parseVcf: a card is sent with exactly one END:VCARD (was doubled, servers rejected it)', () => {
  const { cards } = parseVcf(GOOD_SINGLE)
  assert.equal((cards[0].raw.match(/END:VCARD/g) || []).length, 1)
  assert.match(cards[0].raw, /^BEGIN:VCARD\r\n[\s\S]*\r\nEND:VCARD\r\n$/)
})

test('parseVcf: a card without UID gets the synthesized UID inside the card too', () => {
  const { cards } = parseVcf('BEGIN:VCARD\nVERSION:4.0\nFN:NoUid\nEND:VCARD\n')
  assert.match(cards[0].raw, new RegExp(`\\r\\nUID:${cards[0].uid}\\r\\n`))
})

test('parseCard: folded lines, item groups, vCard 4 URIs, escapes and unicode', async () => {
  const { parseCard } = await import('./vcf.js')
  const c = parseCard([
    'BEGIN:VCARD', 'VERSION:4.0', 'UID:urn:uuid:1234', 'FN:Jürgen Müller-Lüdenscheidt\\, Dr.',
    'item1.EMAIL;TYPE=work:juergen@example.test', 'EMAIL:j2@example.test',
    'TEL;VALUE=uri;TYPE=cell:tel:+49-170-1234', 'ORG:Größe GmbH;Abteilung',
    'NOTE:Line one\\nline two that is folded', '  and continues', 'ADR;TYPE=home:;;Hauptstr. 1;Köln;;50667;DE', 'END:VCARD'
  ].join('\r\n'))
  assert.equal(c.uid, '1234')
  assert.equal(c.name, 'Jürgen Müller-Lüdenscheidt, Dr.')
  assert.deepEqual(c.emails, ['juergen@example.test', 'j2@example.test'])
  assert.equal(c.email, 'juergen@example.test')
  assert.equal(c.phone, '+49-170-1234')
  assert.equal(c.org, 'Größe GmbH')
  assert.equal(c.notes, 'Line one\nline two that is folded and continues')
  assert.equal(c.address, 'Hauptstr. 1, Köln, 50667, DE')
})

test('parseCard: vCard 3.0 with only N gets a display name', async () => {
  const { parseCard } = await import('./vcf.js')
  assert.equal(parseCard('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nEND:VCARD').name, 'Jane Doe')
})

// Text from mail senders and servers must not make the single-process
// server spin: every parser below used an end-anchored or line-spanning
// regex that was quadratic (2-4 s on 100 000 characters). Each case checks
// the result still matches the old behaviour and stays fast on worst input.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimEndChar, trimStartChar } from './trim.js'
import { parseAddr } from './address.js'
import { sameHref } from './dav.js'
import { cleanSnippet } from './snippet.js'
import { splitIcsByUid } from './ics.js'

const N = 200_000
function fast(fn, label) {
  const t = performance.now()
  fn()
  const ms = performance.now() - t
  assert.ok(ms < 300, `${label} took ${ms.toFixed(0)} ms`)
}

test('trimEndChar / trimStartChar', () => {
  assert.equal(trimEndChar('/a/b///', '/'), '/a/b')
  assert.equal(trimEndChar('///', '/'), '')
  assert.equal(trimEndChar('', '/'), '')
  assert.equal(trimStartChar('//a/', '/'), 'a/')
  assert.equal(trimEndChar('ab��', '�'), 'ab')
  fast(() => trimEndChar('/'.repeat(N) + 'x', '/'), 'trimEndChar')
})

test('parseAddr: "Name addr" without brackets, same results, linear', () => {
  assert.deepEqual(parseAddr('Erika Muster erika@x.test'), { name: 'Erika Muster', address: 'erika@x.test' })
  assert.deepEqual(parseAddr('Erika   erika@x.test  '), { name: 'Erika', address: 'erika@x.test' })
  assert.deepEqual(parseAddr('"Erika" <erika@x.test>'), { name: 'Erika', address: 'erika@x.test' })
  assert.deepEqual(parseAddr('erika@x.test'), { name: '', address: 'erika@x.test' })
  assert.deepEqual(parseAddr('just a name'), { name: 'just a name', address: '' })
  assert.deepEqual(parseAddr('bad @ thing'), { name: '', address: 'bad @ thing' })
  fast(() => parseAddr(' '.repeat(N) + 'x'), 'parseAddr spaces')
  fast(() => parseAddr('a '.repeat(N / 2) + 'b@c.de'), 'parseAddr words')
})

test('sameHref: trailing slashes ignored, linear', () => {
  assert.equal(sameHref('/dav/a/', '/dav/a'), true)
  assert.equal(sameHref('/dav/a%20b///', '/dav/a b'), true)
  assert.equal(sameHref('/dav/a', '/dav/b'), false)
  fast(() => sameHref('/'.repeat(N) + 'x', '/x'), 'sameHref')
})

test('cleanSnippet: trailing U+FFFD dropped, linear', () => {
  assert.equal(cleanSnippet('Hello  world��'), 'Hello world')
  assert.equal(cleanSnippet('> quoted\nreal text'), 'real text')
  fast(() => cleanSnippet('�'.repeat(N) + 'x'), 'cleanSnippet')
})

test('splitIcsByUid: TZID/UID found as before, linear on many lines without ":"', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:abc-1', 'DTSTART;TZID=Europe/Berlin:20261115T100000', 'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n')
  const groups = splitIcsByUid(ics)
  const all = JSON.stringify(groups)
  assert.ok(all.includes('abc-1'), all)
  assert.ok(all.includes('Europe/Berlin'), all)
  const evil = 'BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\n' + 'TZID\r\n'.repeat(N / 6) + 'END:VTIMEZONE\r\n' +
    'BEGIN:VEVENT\r\n' + 'UID\r\n'.repeat(N / 5) + 'END:VEVENT\r\nEND:VCALENDAR'
  fast(() => splitIcsByUid(evil), 'splitIcsByUid')
})

import { parseVcf } from './vcf.js'
test('parseVcf: UID found as before, linear on a card full of blank lines', () => {
  const one = parseVcf('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Erika\r\nUID:urn:uuid:abc-1\r\nEND:VCARD\r\n')
  assert.ok(JSON.stringify(one).includes('abc-1'), JSON.stringify(one))
  const evil = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X' + '\r\n'.repeat(30_000) + '\u0000\r\nEND:VCARD\r\n'
  assert.ok(evil.length < 64 * 1024, 'the card must be under MAX_CARD_BYTES so the regex runs')
  fast(() => parseVcf(evil), 'parseVcf')
})

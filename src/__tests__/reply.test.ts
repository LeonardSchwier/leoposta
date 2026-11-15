// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { prefixSubject, replyRecipients, quoteOriginal, threadHeaders, formatAddress, htmlToText, type Original } from '../lib/reply'

const base: Original = {
  id: '7', from: 'Erika Muster', fromAddress: 'erika@x.test', to: ['me@x.test', 'other@x.test'],
  cc: ['cc@x.test', 'ME@x.test'], subject: 'Plan', body: 'Line one\nLine two\n', date: '2026-01-02T03:04:05Z',
  messageId: '<m2@x.test>', references: ['<m0@x.test>', '<m1@x.test>']
}
const own = ['me@x.test']

describe('prefixSubject', () => {
  it('adds Re:/Fwd: once', () => {
    expect(prefixSubject('Plan', 'reply')).toBe('Re: Plan')
    expect(prefixSubject('Re: Plan', 'replyAll')).toBe('Re: Plan')
    expect(prefixSubject('AW: Plan', 'reply')).toBe('AW: Plan')
    expect(prefixSubject('Plan', 'forward')).toBe('Fwd: Plan')
    expect(prefixSubject('Fwd: Plan', 'forward')).toBe('Fwd: Plan')
    expect(prefixSubject('Re: Plan', 'forward')).toBe('Fwd: Re: Plan')
  })
})

describe('replyRecipients', () => {
  it('reply goes to the sender with the display name', () => {
    expect(replyRecipients(base, 'reply', own)).toEqual({ to: ['Erika Muster <erika@x.test>'], cc: [] })
  })
  it('reply honours Reply-To', () => {
    expect(replyRecipients({ ...base, replyTo: ['list@x.test'] }, 'reply', own).to).toEqual(['list@x.test'])
  })
  it('reply all adds the other To and the Cc, never our own address, no duplicates', () => {
    const r = replyRecipients({ ...base, cc: ['cc@x.test', 'ME@x.test', 'other@x.test'] }, 'replyAll', own)
    expect(r).toEqual({ to: ['Erika Muster <erika@x.test>', 'other@x.test'], cc: ['cc@x.test'] })
  })
  it('replying to our own sent mail goes to its recipients', () => {
    const mine = { ...base, from: 'Me', fromAddress: 'me@x.test', to: ['a@x.test', 'b@x.test'], cc: [] }
    expect(replyRecipients(mine, 'reply', own).to).toEqual(['a@x.test'])
    expect(replyRecipients(mine, 'replyAll', own).to).toEqual(['a@x.test', 'b@x.test'])
  })
  it('forward has no recipients', () => {
    expect(replyRecipients(base, 'forward', own)).toEqual({ to: [], cc: [] })
  })
})

describe('formatAddress', () => {
  it('quotes names that contain separators', () => {
    expect(formatAddress('Doe, John', 'j@x.test')).toBe('"Doe, John" <j@x.test>')
    expect(formatAddress('', 'j@x.test')).toBe('j@x.test')
    expect(formatAddress('j@x.test', 'j@x.test')).toBe('j@x.test')
  })
})

describe('quoteOriginal', () => {
  it('reply: attribution line and "> " lines', () => {
    const q = quoteOriginal(base, 'reply')
    expect(q).toMatch(/^On .+, Erika Muster <erika@x\.test> wrote:\n> Line one\n> Line two$/)
  })
  it('quotes the text of an HTML-only mail, not its markup', () => {
    const q = quoteOriginal({ ...base, body: '', bodyHtml: '<p>Hello <b>you</b></p><p>Bye</p><script>x()</script>' }, 'reply')
    expect(q).toContain('> Hello you')
    expect(q).toContain('> Bye')
    expect(q).not.toMatch(/<\/?(p|b|script)>|x\(\)/i)
  })
  it('forward: header block and unquoted text', () => {
    const q = quoteOriginal(base, 'forward')
    expect(q).toContain('---------- Forwarded message ----------\nFrom: Erika Muster <erika@x.test>')
    expect(q).toContain('Subject: Plan\nTo: me@x.test, other@x.test\nCc: cc@x.test, ME@x.test\n\nLine one\nLine two')
  })
})

describe('threadHeaders', () => {
  it('In-Reply-To is the original, References its chain plus it', () => {
    expect(threadHeaders(base, 'reply')).toEqual({ inReplyTo: '<m2@x.test>', references: '<m0@x.test> <m1@x.test> <m2@x.test>' })
  })
  it('none for a forward or without a Message-ID', () => {
    expect(threadHeaders(base, 'forward')).toEqual({})
    expect(threadHeaders({ ...base, messageId: undefined }, 'reply')).toEqual({})
  })
})

describe('htmlToText', () => {
  it('keeps line structure', () => {
    expect(htmlToText('a<br>b<div>c</div>d')).toBe('a\nb\nc\nd')
  })
})

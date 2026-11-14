import { describe, it, expect } from 'vitest'
import { linkify } from '../lib/linkify'

const links = (t: string) => linkify(t).filter((s) => s.href).map((s) => [s.text, s.href])

describe('linkify', () => {
  it('keeps the text around links exactly', () => {
    const t = 'Line one\nVisit https://example.org/path?a=1&b=2 now.\nBye'
    expect(linkify(t).map((s) => s.text).join('')).toBe(t)
    expect(links(t)).toEqual([['https://example.org/path?a=1&b=2', 'https://example.org/path?a=1&b=2']])
  })
  it('drops sentence punctuation but keeps balanced brackets', () => {
    expect(links('see https://x.test/a.')).toEqual([['https://x.test/a', 'https://x.test/a']])
    expect(links('(https://x.test/a)')).toEqual([['https://x.test/a', 'https://x.test/a']])
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar) ok')[0][0]).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })
  it('links www. and e-mail addresses, never javascript:', () => {
    expect(links('go to www.example.org')).toEqual([['www.example.org', 'https://www.example.org']])
    expect(links('mail bob@example.org.')).toEqual([['bob@example.org', 'mailto:bob@example.org']])
    expect(links('javascript:alert(1) data:text/html,x')).toEqual([])
  })
  it('does not interpret markup', () => {
    const segs = linkify('<script>x</script> https://a.test/<b>')
    expect(segs.map((s) => s.text).join('')).toBe('<script>x</script> https://a.test/<b>')
    expect(segs.find((s) => s.href)?.href).toBe('https://a.test/')
  })
})

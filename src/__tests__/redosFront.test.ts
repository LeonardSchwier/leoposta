// The reading pane and Compose parse mail text with linkify, quoteOriginal and
// recipientAddress. Their old regexes were quadratic (3-4 s on 100 KB, so
// one hostile mail froze the tab). The new code must give exactly the old
// results: the old implementations are kept here and compared on random text.
import { describe, it, expect } from 'vitest'
import { linkify, type Segment } from '../lib/linkify'
import { recipientAddress } from '../lib/recipients'

const OLD_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\bmailto:[^\s<>"']+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi
const OLD_TRAILING = /[.,;:!?)\]}'"»”’]+$/
function oldTrim(url: string): string {
  let out = url.replace(OLD_TRAILING, '')
  const opens = (url.match(/\(/g) || []).length
  if (opens && url.slice(out.length).startsWith(')') && (out.match(/\)/g) || []).length < opens) out += ')'
  return out
}
function oldLinkify(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(OLD_URL_RE)) {
    const raw = m[0]
    const url = raw.includes('@') && !/^(https?:|www\.|mailto:)/i.test(raw) ? raw : oldTrim(raw)
    if (!url) continue
    const start = m.index ?? 0
    if (start > last) out.push({ text: text.slice(last, start) })
    let href: string
    if (/^www\./i.test(url)) href = `https://${url}`
    else if (/^(https?|mailto):/i.test(url)) href = url
    else href = `mailto:${url}`
    out.push({ text: url, href })
    last = start + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
function oldRecipientAddress(r: string): string {
  const m = r.match(/<([^>]*)>\s*$/)
  return (m ? m[1] : r).trim()
}

// Deterministic PRNG so a failure is reproducible.
function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
}
const PIECES = ['a', 'B', '1', '_', '.', '-', '+', '%', '@', ' ', '\n', ':', '/', '(', ')', ',', '!', '"', "'", '<', '>', '»',
  'http://', 'https://', 'www.', 'mailto:', 'x.com', 'de', 'HTTP://', 'Www.', '@x.org', 'a@b.cd']
function randomText(next: () => number, len: number) {
  let s = ''
  for (let i = 0; i < len; i++) s += PIECES[Math.floor(next() * PIECES.length)]
  return s
}

function fast(fn: () => unknown, label: string) {
  const t = performance.now()
  fn()
  expect(performance.now() - t, label).toBeLessThan(300)
}

describe('linkify', () => {
  it('gives the old results on 20 000 random texts', () => {
    const next = rng(42)
    for (let i = 0; i < 20_000; i++) {
      const text = randomText(next, 1 + Math.floor(next() * 30))
      expect(linkify(text), JSON.stringify(text)).toEqual(oldLinkify(text))
    }
  })
  it('is linear on worst-case text', () => {
    const N = 200_000
    fast(() => linkify('a.'.repeat(N / 2)), 'a.a.')
    fast(() => linkify('a@' + 'a.'.repeat(N / 2) + '1'), 'a@a.')
    fast(() => linkify('http://x/' + ')'.repeat(N) + 'a'), '))))')
    fast(() => linkify('x@'.repeat(N / 2)), 'x@x@')
  })
})

describe('recipientAddress', () => {
  it('gives the old results on 20 000 random strings', () => {
    const next = rng(7)
    for (let i = 0; i < 20_000; i++) {
      const s = randomText(next, 1 + Math.floor(next() * 12))
      expect(recipientAddress(s), JSON.stringify(s)).toBe(oldRecipientAddress(s))
    }
  })
  it('is linear on a long run of "<"', () => {
    fast(() => recipientAddress('<'.repeat(200_000)), '<<<<')
  })
})

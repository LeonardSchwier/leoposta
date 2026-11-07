// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sanitizeHtml, hasRemoteImages } from '../lib/sanitizeHtml'

function el(html: string, opts?: { allowRemoteImages?: boolean }) {
  const d = document.createElement('div')
  d.innerHTML = sanitizeHtml(html, opts)
  return d
}

describe('sanitizeHtml', () => {
  it('adds rel noopener noreferrer on target links', () => {
    const a = el('<a href="https://x" target="_blank">x</a>').querySelector('a')!
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })
  it('drops javascript: href', () => {
    expect(el('<a href="javascript:alert(1)">x</a>').querySelector('a')!.hasAttribute('href')).toBe(false)
  })
  it('drops onerror', () => {
    expect(el('<img src="x" onerror="alert(1)">').querySelector('img')!.hasAttribute('onerror')).toBe(false)
  })
  it('drops id and name', () => {
    const d = el('<div id="a" name="b">t</div>').querySelector('div')!
    expect(d.hasAttribute('id')).toBe(false)
    expect(d.hasAttribute('name')).toBe(false)
  })
  it('drops style with url()', () => {
    expect(el('<p style="background:url(http://t/p.gif)">x</p>').querySelector('p')!.hasAttribute('style')).toBe(false)
  })
  it('drops style that hides url() via CSS escapes or image-set', () => {
    expect(el('<p style="background:\\75rl(http://t/p.gif)">x</p>').querySelector('p')!.hasAttribute('style')).toBe(false)
    expect(el('<p style="background:image-set(\'http://t/p.gif\' 1x)">x</p>').querySelector('p')!.hasAttribute('style')).toBe(false)
  })
  it('keeps harmless style', () => {
    expect(el('<p style="color:red">x</p>').querySelector('p')!.getAttribute('style')).toContain('color')
  })
  it('blocks remote images by default', () => {
    const i = el('<img src="https://t/p.gif">').querySelector('img')!
    expect(i.hasAttribute('src')).toBe(false)
    expect(i.getAttribute('data-remote-src')).toBe('https://t/p.gif')
  })
  it('keeps remote images when allowed', () => {
    const i = el('<img src="https://t/p.gif">', { allowRemoteImages: true }).querySelector('img')!
    expect(i.getAttribute('src')).toBe('https://t/p.gif')
  })
  it('keeps cid images', () => {
    expect(el('<img src="cid:abc">').querySelector('img')!.getAttribute('src')).toBe('cid:abc')
  })
  it('detects remote images', () => {
    expect(hasRemoteImages('<img src="https://t/p.gif">')).toBe(true)
    expect(hasRemoteImages('<img src="cid:a">')).toBe(false)
    expect(hasRemoteImages('')).toBe(false)
  })
})

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from '../lib/sanitizeHtml'

function el(html: string) {
  const d = document.createElement('div')
  d.innerHTML = sanitizeHtml(html)
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
  it('keeps harmless style', () => {
    expect(el('<p style="color:red">x</p>').querySelector('p')!.getAttribute('style')).toContain('color')
  })
})

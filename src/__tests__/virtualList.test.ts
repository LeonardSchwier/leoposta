import { describe, it, expect } from 'vitest'
import { computeVirtualRange, DEFAULT_ITEM_HEIGHT, OVERSCAN } from '../lib/virtualList'

describe('computeVirtualRange', () => {
  it('renders the first N items at scrollTop 0', () => {
    const r = computeVirtualRange({ totalItems: 100, viewportHeight: 400, scrollTop: 0 })
    expect(r.startIndex).toBe(0)
    const rendered = r.endIndex - r.startIndex + 1
    expect(rendered).toBeGreaterThan(400 / DEFAULT_ITEM_HEIGHT)
    expect(rendered - (400 / DEFAULT_ITEM_HEIGHT)).toBeLessThanOrEqual(OVERSCAN * 2 + 1)
    expect(r.paddingTop).toBe(0)
  })

  it('advances startIndex as scrollTop grows', () => {
    const a = computeVirtualRange({ totalItems: 1000, viewportHeight: 400, scrollTop: 0 })
    const b = computeVirtualRange({ totalItems: 1000, viewportHeight: 400, scrollTop: 400 })
    expect(b.startIndex).toBeGreaterThan(a.startIndex)
    expect(b.paddingTop).toBeGreaterThan(a.paddingTop)
  })

  it('clamps to totalItems at the bottom', () => {
    const r = computeVirtualRange({ totalItems: 10, viewportHeight: 400, scrollTop: 1000 })
    expect(r.endIndex).toBe(10)
    expect(r.startIndex).toBeGreaterThanOrEqual(0)
  })

  it('handles zero totalItems without producing negative indices', () => {
    const r = computeVirtualRange({ totalItems: 0, viewportHeight: 400, scrollTop: 0 })
    expect(r.startIndex).toBe(0)
    expect(r.endIndex).toBe(0)
    expect(r.paddingTop).toBe(0)
    expect(r.paddingBottom).toBe(0)
  })

  it('is pure: same input, same output', () => {
    const a = computeVirtualRange({ totalItems: 50, viewportHeight: 300, scrollTop: 100 })
    const b = computeVirtualRange({ totalItems: 50, viewportHeight: 300, scrollTop: 100 })
    expect(a).toEqual(b)
  })

  it('honors a caller-provided itemHeight instead of the default', () => {
    const r = computeVirtualRange({ totalItems: 100, viewportHeight: 400, scrollTop: 320, itemHeight: 80 })
    // firstVisible=4, startIndex=0 (clamped by overscan), paddingTop=0
    expect(r.paddingTop).toBe(0)
    const r2 = computeVirtualRange({ totalItems: 100, viewportHeight: 400, scrollTop: 800, itemHeight: 80 })
    expect(r2.paddingTop).toBe(r2.startIndex * 80)
  })

  it('paddingTop equals startIndex * itemHeight so rendering stays in position', () => {
    const r = computeVirtualRange({ totalItems: 100, viewportHeight: 400, scrollTop: 1000 })
    expect(r.paddingTop).toBe(r.startIndex * DEFAULT_ITEM_HEIGHT)
  })

  it('rendered slice covers the currently-visible viewport', () => {
    const H = 80
    const r = computeVirtualRange({ totalItems: 500, viewportHeight: 600, scrollTop: 25 * H, itemHeight: H })
    const visibleFirst = 25
    const visibleLast = 25 + Math.ceil(600 / H)
    expect(r.startIndex).toBeLessThanOrEqual(visibleFirst)
    expect(r.endIndex).toBeGreaterThanOrEqual(Math.min(visibleLast, 500))
  })
})

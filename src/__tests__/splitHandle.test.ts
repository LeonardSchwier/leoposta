import { describe, it, expect } from 'vitest'
import { computeStartWidth, clampWidth } from '../lib/splitHandle'

describe('computeStartWidth', () => {
  it('is the handle-to-content offset with no bias (the handle no longer overlaps the list via negative margin)', () => {
    // content starts at x=0, handle (a 6px-wide, non-overlapping flex item)
    // sits right after a 320px-wide list column, so its left edge is at 320.
    expect(computeStartWidth(320, 0)).toBe(320)
  })

  it('still works when the content pane itself is offset from the viewport', () => {
    expect(computeStartWidth(500, 180)).toBe(320)
  })
})

describe('clampWidth', () => {
  const MIN = 280
  const MAX_FRACTION = 0.8
  const CONTENT_W = 1000

  it('passes a value already inside [min, max] through unchanged', () => {
    expect(clampWidth(400, CONTENT_W, MIN, MAX_FRACTION)).toBe(400)
  })

  it('clamps to the minimum when dragged narrower than it', () => {
    expect(clampWidth(100, CONTENT_W, MIN, MAX_FRACTION)).toBe(MIN)
  })

  it('clamps to maxFraction * contentWidth when dragged wider than it', () => {
    expect(clampWidth(999, CONTENT_W, MIN, MAX_FRACTION)).toBe(800)
  })

  it('rounds to the nearest whole pixel', () => {
    expect(clampWidth(400.6, CONTENT_W, MIN, MAX_FRACTION)).toBe(401)
  })
})

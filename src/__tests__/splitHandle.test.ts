// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { computeStartWidth, clampWidth, beginSplitDrag, isOnNativeScrollbar } from '../lib/splitHandle'

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

// ---------------------------------------------------------------------------
// Drag lifecycle. Regression for "I click the scrollbar / handle, release,
// and the column keeps following the pointer": the old inline onUp handler in
// App.svelte threw (it assigned an undeclared `splitActive`) before it could
// remove its window listeners, so the drag never ended. These tests pin down
// that every way a press can end really does end the drag.
// ---------------------------------------------------------------------------
describe('beginSplitDrag', () => {
  type Opts = Parameters<typeof beginSplitDrag>[1]
  let handle: HTMLElement
  let container: HTMLElement
  let widths: number[]
  let ended: number

  function ptr(type: string, init: { clientX?: number; buttons?: number; pointerId?: number; button?: number } = {}): PointerEvent {
    const Ctor = (window.PointerEvent ?? window.MouseEvent) as typeof PointerEvent
    const ev = new Ctor(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, buttons: init.buttons ?? 0, button: init.button ?? 0 })
    if (!('pointerId' in ev) || ev.pointerId === undefined) Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 })
    return ev
  }

  function opts(): Opts {
    return {
      handle, container, min: 100, maxFraction: 0.8,
      onResize: (w) => widths.push(w),
      onEnd: () => { ended++ },
    }
  }

  function press(clientX = 300): PointerEvent {
    const ev = ptr('pointerdown', { clientX, buttons: 1, pointerId: 1 })
    Object.defineProperty(ev, 'target', { value: handle })
    Object.defineProperty(ev, 'currentTarget', { value: handle })
    return ev
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    container = document.createElement('div')
    handle = document.createElement('div')
    container.appendChild(handle)
    document.body.appendChild(container)
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON() {} }) as DOMRect
    handle.getBoundingClientRect = () => ({ left: 300, top: 0, width: 6, height: 500, right: 306, bottom: 500, x: 300, y: 0, toJSON() {} }) as DOMRect
    widths = []
    ended = 0
  })

  it('resizes while the button is held', () => {
    const stop = beginSplitDrag(press(), opts())
    expect(stop).not.toBeNull()
    window.dispatchEvent(ptr('pointermove', { clientX: 350, buttons: 1 }))
    expect(widths).toEqual([350])
    stop!()
  })

  it('ends the drag on pointerup on window, and later moves no longer resize', () => {
    beginSplitDrag(press(), opts())
    window.dispatchEvent(ptr('pointerup', { clientX: 320 }))
    expect(ended).toBe(1)
    window.dispatchEvent(ptr('pointermove', { clientX: 500, buttons: 1 }))
    expect(widths).toEqual([])
  })

  it('a move with buttons === 0 (release we never saw) ends the drag instead of resizing', () => {
    beginSplitDrag(press(), opts())
    window.dispatchEvent(ptr('pointermove', { clientX: 500, buttons: 0 }))
    expect(widths).toEqual([])
    expect(ended).toBe(1)
    window.dispatchEvent(ptr('pointermove', { clientX: 600, buttons: 1 }))
    expect(widths).toEqual([])
  })

  it.each(['pointercancel', 'lostpointercapture'])('ends the drag on %s', (type) => {
    beginSplitDrag(press(), opts())
    if (type === 'lostpointercapture') handle.dispatchEvent(ptr(type))
    else window.dispatchEvent(ptr(type))
    expect(ended).toBe(1)
    window.dispatchEvent(ptr('pointermove', { clientX: 500, buttons: 1 }))
    expect(widths).toEqual([])
  })

  it('ends the drag when the window loses focus', () => {
    beginSplitDrag(press(), opts())
    window.dispatchEvent(new Event('blur'))
    expect(ended).toBe(1)
    window.dispatchEvent(ptr('pointermove', { clientX: 500, buttons: 1 }))
    expect(widths).toEqual([])
  })

  it('only ends once even if several end signals fire', () => {
    beginSplitDrag(press(), opts())
    window.dispatchEvent(ptr('pointerup'))
    window.dispatchEvent(ptr('pointercancel'))
    window.dispatchEvent(new Event('blur'))
    expect(ended).toBe(1)
  })

  it('restores body cursor / user-select after the drag', () => {
    beginSplitDrag(press(), opts())
    expect(document.body.style.cursor).toBe('col-resize')
    window.dispatchEvent(ptr('pointerup'))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('does not start for a non-primary button', () => {
    const ev = ptr('pointerdown', { clientX: 300, buttons: 2, button: 2 })
    Object.defineProperty(ev, 'target', { value: handle })
    expect(beginSplitDrag(ev, opts())).toBeNull()
  })

  it('does not start when the press lands on something other than the handle (e.g. a scrollbar of a child)', () => {
    const child = document.createElement('div')
    handle.appendChild(child)
    const ev = ptr('pointerdown', { clientX: 300, buttons: 1 })
    Object.defineProperty(ev, 'target', { value: child })
    expect(beginSplitDrag(ev, opts())).toBeNull()
  })
})

describe('isOnNativeScrollbar', () => {
  function el(o: { clientWidth: number; offsetWidth: number; clientHeight: number; offsetHeight: number; left?: number; top?: number }): HTMLElement {
    const e = document.createElement('div')
    Object.defineProperty(e, 'clientWidth', { value: o.clientWidth })
    Object.defineProperty(e, 'offsetWidth', { value: o.offsetWidth })
    Object.defineProperty(e, 'clientHeight', { value: o.clientHeight })
    Object.defineProperty(e, 'offsetHeight', { value: o.offsetHeight })
    Object.defineProperty(e, 'clientLeft', { value: 0 })
    Object.defineProperty(e, 'clientTop', { value: 0 })
    e.getBoundingClientRect = () => ({ left: o.left ?? 0, top: o.top ?? 0, width: o.offsetWidth, height: o.offsetHeight, right: (o.left ?? 0) + o.offsetWidth, bottom: (o.top ?? 0) + o.offsetHeight, x: 0, y: 0, toJSON() {} }) as DOMRect
    return e
  }

  it('is true in the vertical scrollbar gutter', () => {
    expect(isOnNativeScrollbar(el({ clientWidth: 190, offsetWidth: 200, clientHeight: 100, offsetHeight: 100 }), 195, 50)).toBe(true)
  })
  it('is true in the horizontal scrollbar gutter', () => {
    expect(isOnNativeScrollbar(el({ clientWidth: 200, offsetWidth: 200, clientHeight: 90, offsetHeight: 100 }), 50, 95)).toBe(true)
  })
  it('is false in the content area', () => {
    expect(isOnNativeScrollbar(el({ clientWidth: 190, offsetWidth: 200, clientHeight: 90, offsetHeight: 100 }), 50, 50)).toBe(false)
  })
  it('is false for an element with no scrollbars', () => {
    expect(isOnNativeScrollbar(el({ clientWidth: 200, offsetWidth: 200, clientHeight: 100, offsetHeight: 100 }), 199, 99)).toBe(false)
  })
})

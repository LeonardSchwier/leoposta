// Pure math for the list/preview split-handle drag in App.svelte, pulled out
// so the offset/clamp logic is testable without a real DOM layout.
//
// The handle used to sit on a `margin: 0 -3px` straddling the list/preview
// boundary, which let its hit area bleed 3px into the message list — right
// where that list's own vertical scrollbar renders, since both sit flush
// against the same right edge. A click meant for the scrollbar thumb could
// land on the handle instead and resize the column rather than scroll.
// The handle no longer overlaps (see the `.split-handle` CSS: no negative
// margin), so computeStartWidth no longer needs the `-3` bias that used to
// compensate for it.

export function computeStartWidth(handleLeft: number, contentLeft: number): number {
  return handleLeft - contentLeft
}

export function clampWidth(w: number, contentWidth: number, min: number, maxFraction: number): number {
  return Math.round(Math.min(contentWidth * maxFraction, Math.max(min, w)))
}

/**
 * True when (clientX, clientY) lands in `el`'s native scrollbar gutter rather
 * than its content box. Native scrollbars aren't DOM nodes, so the only way to
 * tell is geometry: the gutter is the strip between the padding box
 * (clientWidth/clientHeight) and the border box (offsetWidth/offsetHeight).
 */
export function isOnNativeScrollbar(el: Element, clientX: number, clientY: number): boolean {
  if (!(el instanceof HTMLElement)) return false
  const rect = el.getBoundingClientRect()
  const vGutter = el.offsetWidth - el.clientWidth - el.clientLeft * 2
  const hGutter = el.offsetHeight - el.clientHeight - el.clientTop * 2
  const x = clientX - rect.left
  const y = clientY - rect.top
  if (vGutter > 0 && x >= el.clientLeft + el.clientWidth && x < el.offsetWidth - el.clientLeft) return true
  if (hGutter > 0 && y >= el.clientTop + el.clientHeight && y < el.offsetHeight - el.clientTop) return true
  return false
}

export interface SplitDragOptions {
  /** The separator element the press started on. */
  handle: HTMLElement
  /** The flex row whose first column is being resized. */
  container: HTMLElement
  min: number
  maxFraction: number
  onResize: (width: number) => void
  /** Called exactly once when the drag ends, however it ends. */
  onEnd: () => void
  win?: Window
}

/**
 * Start a column-resize drag from a pointerdown on the split handle.
 * Returns a function that force-ends the drag, or null if no drag was started
 * (non-primary button, or the press landed on anything but the handle itself,
 * e.g. a native scrollbar).
 *
 * The drag is guaranteed to end on any of: pointerup, pointercancel,
 * lostpointercapture, window blur, or a pointermove that reports no button
 * held (`buttons === 0` — the release happened somewhere we never got the
 * pointerup, such as over a native scrollbar or outside the webview).
 */
export function beginSplitDrag(e: PointerEvent, opts: SplitDragOptions): (() => void) | null {
  const { handle, container, min, maxFraction, onResize, onEnd } = opts
  const win = opts.win ?? window
  if (e.button !== 0) return null
  if (e.target !== handle) return null
  if (isOnNativeScrollbar(handle, e.clientX, e.clientY)) return null

  e.preventDefault()
  const pointerId = e.pointerId
  const startX = e.clientX
  const contentRect = container.getBoundingClientRect()
  const startW = computeStartWidth(handle.getBoundingClientRect().left, contentRect.left)
  const body = handle.ownerDocument.body

  let done = false
  const end = () => {
    if (done) return
    done = true
    win.removeEventListener('pointermove', onMove)
    win.removeEventListener('pointerup', end)
    win.removeEventListener('pointercancel', end)
    win.removeEventListener('blur', end)
    handle.removeEventListener('lostpointercapture', end)
    try {
      if (pointerId !== undefined && handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
    } catch { /* pointer already gone */ }
    body.style.cursor = ''
    body.style.userSelect = ''
    onEnd()
  }
  const onMove = (ev: PointerEvent) => {
    if ((ev.buttons & 1) === 0) { end(); return }
    onResize(clampWidth(startW + (ev.clientX - startX), contentRect.width, min, maxFraction))
  }

  win.addEventListener('pointermove', onMove)
  win.addEventListener('pointerup', end)
  win.addEventListener('pointercancel', end)
  win.addEventListener('blur', end)
  handle.addEventListener('lostpointercapture', end)
  try {
    if (pointerId !== undefined) handle.setPointerCapture?.(pointerId)
  } catch { /* synthetic / unknown pointer id */ }
  body.style.cursor = 'col-resize'
  body.style.userSelect = 'none'
  return end
}

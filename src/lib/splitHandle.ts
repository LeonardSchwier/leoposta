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

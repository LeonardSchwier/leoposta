// Virtualised list helper — windowing math for MessageList.svelte (and
// any future scroll list). Pure function of (totalItems, viewportHeight,
// scrollTop, itemHeight); Svelte 5 reactivity is applied by the caller
// (a component wrapping it in $effect / $derived). No third-party
// dependency: the component renders `startIndex..endIndex` rows between
// two spacer divs sized paddingTop/paddingBottom.
//
// itemHeight is provided by the caller (measured from the DOM once the
// first row is painted) so the math stays honest even when the row layout
// changes (wraps on mobile, extra preview lines, etc.).

export const DEFAULT_ITEM_HEIGHT = 64
export const OVERSCAN = 5

export interface VirtualRangeInput {
  totalItems: number
  viewportHeight: number
  scrollTop: number
  itemHeight?: number
  overscan?: number
}

export interface VirtualRange {
  startIndex: number
  endIndex: number // inclusive
  paddingTop: number
  paddingBottom: number
}

export function computeVirtualRange(input: VirtualRangeInput): VirtualRange {
  const { totalItems, viewportHeight, scrollTop } = input
  const H = input.itemHeight && input.itemHeight > 0 ? input.itemHeight : DEFAULT_ITEM_HEIGHT
  const O = input.overscan ?? OVERSCAN
  if (totalItems <= 0 || viewportHeight <= 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 }
  }
  const firstVisible = Math.floor(scrollTop / H)
  const visibleCount = Math.ceil(viewportHeight / H)
  const startIndex = Math.max(0, firstVisible - O)
  const endIndex = Math.min(totalItems, firstVisible + visibleCount + O)
  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * H,
    paddingBottom: Math.max(0, (totalItems - endIndex) * H),
  }
}

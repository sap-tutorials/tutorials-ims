// Pure label helpers: which coin titles are shown in full, and vertical stacking so
// visible labels never overlap. No DOM — the LabelLayer applies the results.

export type LabelMode = 'full' | 'badge' | 'hidden'

export const FULL_RADIUS = 8   // world units around Kasimir where titles are shown in full
export const MAX_FULL = 2      // at most this many full coin titles at once

/**
 * Coins within `viewHalfW` of the camera are visible. The `maxFull` coins nearest to
 * Kasimir (and inside FULL_RADIUS) show their full title; the rest show a compact badge.
 */
export function labelModes(
  coinXs: number[],
  kasX: number,
  camX: number,
  viewHalfW: number,
  opts: { fullRadius?: number; maxFull?: number } = {},
): LabelMode[] {
  const fullRadius = opts.fullRadius ?? FULL_RADIUS
  const maxFull = opts.maxFull ?? MAX_FULL
  const modes: LabelMode[] = coinXs.map(x => (Math.abs(x - camX) <= viewHalfW ? 'badge' : 'hidden'))
  const near = coinXs
    .map((x, i) => ({ i, d: Math.abs(x - kasX) }))
    .filter(c => c.d <= fullRadius && modes[c.i] !== 'hidden')
    .sort((a, b) => a.d - b.d)
    .slice(0, maxFull)
  for (const c of near) modes[c.i] = 'full'
  return modes
}

export interface LabelRect { x: number; y: number; w: number; h: number } // x = centre, y = bottom (screen px)

/**
 * Returns upward offsets (px) so no two rects overlap. Rects are placed in array order
 * (callers pass highest priority first); each is lifted just above any earlier rect it
 * would collide with.
 */
export function stackRects(rects: LabelRect[], gap = 6): number[] {
  const offsets = new Array<number>(rects.length).fill(0)
  const placed: Array<{ l: number; r: number; top: number; bottom: number }> = []
  rects.forEach((r, i) => {
    const l = r.x - r.w / 2
    const rr = r.x + r.w / 2
    let bottom = r.y
    let moved = true
    while (moved) {
      moved = false
      for (const p of placed) {
        const overlapX = l < p.r + gap && rr > p.l - gap
        const overlapY = bottom > p.top - gap && bottom - r.h < p.bottom + gap
        if (overlapX && overlapY) {
          bottom = p.top - gap
          moved = true
        }
      }
    }
    offsets[i] = r.y - bottom
    placed.push({ l, r: rr, top: bottom - r.h, bottom })
  })
  return offsets
}

/** Trim very long titles at a word boundary; CSS line-clamp handles the rest. */
export function tidyTitle(title: string, max = 90): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '') + '…'
}

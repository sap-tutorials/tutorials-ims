import type { Obstacle, Pit } from './types'
import { HAZARD_LIMITS } from './constants'

export const COIN_SPACING = 6   // 1 coin-index unit = 6 world units
export const MIN_LANDING = 2.5  // world units — minimum clear ground between hazards

/** Mulberry32 seeded PRNG. Returns a function that produces values in [0, 1). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return function () {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Place hazards deterministically for one zone.
 * - Hazards sit midway between coins (x = i + 0.5, coin-index units) so they never overlap a coin.
 * - The first gap of every zone is kept clear (breathing room after the zone banner), as are
 *   gaps occupied by checkpoint gates (`blockedGaps` = coin indices a gate follows).
 * - At most ceil(coinCount / 2.5) hazards; every hazard is comfortably clearable (see HAZARD_LIMITS).
 * - Mix: pits, crates and spikes, roughly 40/35/25.
 */
export function placeHazards(
  coinCount: number,
  zoneSeed: number,
  blockedGaps: number[] = [],
): { obstacles: Obstacle[]; pits: Pit[] } {
  if (coinCount <= 2) return { obstacles: [], pits: [] }

  const rand = mulberry32(zoneSeed * 7919 + 17)
  const maxHazards = Math.ceil(coinCount / 2.5)
  const blocked = new Set(blockedGaps)

  const candidates: number[] = []
  for (let i = 1; i < coinCount - 1; i++) {
    if (!blocked.has(i)) candidates.push(i + 0.5)
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }

  const obstacles: Obstacle[] = []
  const pits: Pit[] = []
  const placed: Array<{ left: number; right: number }> = []
  const L = HAZARD_LIMITS

  for (const cx of candidates) {
    if (obstacles.length + pits.length >= maxHazards) break
    const r = rand()
    const kind: 'pit' | 'crate' | 'spike' = r < 0.4 ? 'pit' : r < 0.75 ? 'crate' : 'spike'
    const w =
      kind === 'pit' ? L.pitMinW + rand() * (L.pitMaxW - L.pitMinW)
      : kind === 'crate' ? L.crateW
      : L.spikeMinW + rand() * (L.spikeMaxW - L.spikeMinW)
    const worldX = cx * COIN_SPACING
    const left = worldX - w / 2
    const right = worldX + w / 2
    if (placed.some(e => Math.max(left - e.right, e.left - right) < MIN_LANDING)) continue

    if (kind === 'pit') {
      pits.push({ x: cx, w })
    } else if (kind === 'crate') {
      const h = L.crateMinH + rand() * (L.crateMaxH - L.crateMinH)
      obstacles.push({ x: cx, w, h, kind: 'crate' })
    } else {
      obstacles.push({ x: cx, w, h: L.spikeH, kind: 'spike' })
    }
    placed.push({ left, right })
  }

  obstacles.sort((a, b) => a.x - b.x)
  pits.sort((a, b) => a.x - b.x)
  return { obstacles, pits }
}

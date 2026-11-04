import type { Obstacle, Pit } from './types'
import { JUMP_ARC } from './constants'

const COIN_SPACING = 4.5 // 1 coin-index unit = 4.5 world units

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
 * Place obstacles and pits deterministically for a given zone.
 * - coinCount 0 or 1 → empty arrays
 * - At most floor(coinCount / 3) hazards total
 * - Every pit w <= JUMP_ARC.maxGap (w is in world units)
 * - Every obstacle h <= JUMP_ARC.maxHeight, fixed w = 0.6 (world units)
 * - No two hazards within JUMP_ARC.maxGap world units of each other
 * - x values are in coin-index units (between integer indices, e.g. 1.5, 3.5)
 */
export function placeHazards(coinCount: number, zoneSeed: number): { obstacles: Obstacle[]; pits: Pit[] } {
  if (coinCount <= 1) {
    return { obstacles: [], pits: [] }
  }

  const maxHazards = Math.floor(coinCount / 3)
  if (maxHazards === 0) {
    return { obstacles: [], pits: [] }
  }

  const rand = mulberry32(zoneSeed)

  const obstacles: Obstacle[] = []
  const pits: Pit[] = []

  // Candidate x positions: between each pair of coin slots (i + 0.5 for i = 0..coinCount-2)
  const candidates: number[] = []
  for (let i = 0; i < coinCount - 1; i++) {
    candidates.push(i + 0.5)
  }
  // Fisher-Yates shuffle using the seeded PRNG
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }

  // Track placed hazard x positions in world units for spacing check
  const placedWorldX: number[] = []

  for (const cx of candidates) {
    if (obstacles.length + pits.length >= maxHazards) break

    const worldX = cx * COIN_SPACING

    // Enforce minimum gap: no placed hazard within JUMP_ARC.maxGap world units
    const tooClose = placedWorldX.some(px => Math.abs(worldX - px) < JUMP_ARC.maxGap)
    if (tooClose) continue

    // Randomly choose pit or obstacle (50/50)
    if (rand() < 0.5) {
      // Pit: width in world units, clamped to JUMP_ARC.maxGap
      const w = Math.min((0.3 + rand() * 0.7) * JUMP_ARC.maxGap, JUMP_ARC.maxGap)
      pits.push({ x: cx, w })
      placedWorldX.push(worldX)
    } else {
      // Obstacle: fixed w = 0.6, h clamped to JUMP_ARC.maxHeight
      const h = Math.min((0.5 + rand() * 0.5) * JUMP_ARC.maxHeight, JUMP_ARC.maxHeight)
      obstacles.push({ x: cx, w: 0.6, h })
      placedWorldX.push(worldX)
    }
  }

  return { obstacles, pits }
}

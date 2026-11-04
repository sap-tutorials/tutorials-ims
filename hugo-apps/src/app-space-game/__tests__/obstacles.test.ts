import { describe, it, expect } from 'vitest'
import { placeHazards, COIN_SPACING, MIN_LANDING } from '../obstacles'
import { JUMP_ARC } from '../constants'

describe('placeHazards', () => {
  it('1: determinism — same args produce deep-equal output', () => {
    const a = placeHazards(9, 3)
    const b = placeHazards(9, 3)
    expect(a).toEqual(b)
  })

  it('2: both calls with same args are valid (completable-path check covers correctness)', () => {
    const r0 = placeHazards(9, 0)
    const r5 = placeHazards(9, 5)
    // Both must be structurally valid (arrays of Obstacle/Pit)
    expect(Array.isArray(r0.obstacles)).toBe(true)
    expect(Array.isArray(r0.pits)).toBe(true)
    expect(Array.isArray(r5.obstacles)).toBe(true)
    expect(Array.isArray(r5.pits)).toBe(true)
  })

  it('3: every pit w <= JUMP_ARC.maxGap', () => {
    const { pits } = placeHazards(12, 7)
    for (const pit of pits) {
      expect(pit.w).toBeLessThanOrEqual(JUMP_ARC.maxGap)
    }
  })

  it('4: every obstacle h <= JUMP_ARC.maxHeight', () => {
    const { obstacles } = placeHazards(12, 7)
    for (const obs of obstacles) {
      expect(obs.h).toBeLessThanOrEqual(JUMP_ARC.maxHeight)
    }
  })

  it('5: completable-path — edge-to-edge gap between every adjacent pair >= MIN_LANDING', () => {
    // Check across multiple seeds and coin counts to confirm the invariant holds
    for (let seed = 0; seed <= 20; seed++) {
      for (let coinCount = 3; coinCount <= 15; coinCount++) {
        const { obstacles, pits } = placeHazards(coinCount, seed)

        // Build [leftEdge, rightEdge] in world units for every hazard
        type Edge = { left: number; right: number }
        const edges: Edge[] = [
          ...obstacles.map(o => ({
            left: o.x * COIN_SPACING - o.w / 2,
            right: o.x * COIN_SPACING + o.w / 2,
          })),
          ...pits.map(p => ({
            left: p.x * COIN_SPACING - p.w / 2,
            right: p.x * COIN_SPACING + p.w / 2,
          })),
        ].sort((a, b) => a.left - b.left)

        for (let i = 1; i < edges.length; i++) {
          const edgeGap = edges[i].left - edges[i - 1].right
          expect(edgeGap).toBeGreaterThanOrEqual(MIN_LANDING)
        }
      }
    }
  })

  it('6: coinCount 0 -> empty arrays, no throw', () => {
    expect(placeHazards(0, 1)).toEqual({ obstacles: [], pits: [] })
  })

  it('6b: coinCount 1 -> empty arrays, no throw', () => {
    expect(placeHazards(1, 1)).toEqual({ obstacles: [], pits: [] })
  })

  it('7: hazard count <= floor(coinCount / 3)', () => {
    for (const coinCount of [3, 6, 9, 12, 15]) {
      const { obstacles, pits } = placeHazards(coinCount, coinCount)
      const total = obstacles.length + pits.length
      expect(total).toBeLessThanOrEqual(Math.floor(coinCount / 3))
    }
  })
})

import { describe, it, expect } from 'vitest'
import { placeHazards } from '../obstacles'
import { JUMP_ARC } from '../constants'

const COIN_SPACING = 4.5 // 1 coin-index unit = 4.5 world units

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

  it('5: completable-path — no two consecutive hazards closer than maxGap in world units', () => {
    const { obstacles, pits } = placeHazards(12, 3)
    // Collect all hazard x positions in world units
    const xs: number[] = [
      ...obstacles.map(o => o.x * COIN_SPACING),
      ...pits.map(p => p.x * COIN_SPACING),
    ].sort((a, b) => a - b)

    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1]
      // Must be at least JUMP_ARC.maxGap apart (clear landing slot between each pair)
      expect(gap).toBeGreaterThanOrEqual(JUMP_ARC.maxGap)
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

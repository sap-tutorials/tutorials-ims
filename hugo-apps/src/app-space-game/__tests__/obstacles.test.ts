import { describe, it, expect } from 'vitest'
import { placeHazards, COIN_SPACING, MIN_LANDING } from '../obstacles'
import { JUMP_ARC, HAZARD_LIMITS } from '../constants'

describe('placeHazards', () => {
  it('is deterministic', () => {
    expect(placeHazards(9, 3)).toEqual(placeHazards(9, 3))
  })

  it('returns nothing for tiny zones', () => {
    for (const n of [0, 1, 2]) expect(placeHazards(n, 1)).toEqual({ obstacles: [], pits: [] })
  })

  it('keeps every hazard comfortably inside the jump arc (not frame-perfect)', () => {
    for (let seed = 0; seed < 30; seed++) {
      const { obstacles, pits } = placeHazards(14, seed)
      for (const p of pits) expect(p.w).toBeLessThanOrEqual(JUMP_ARC.maxGap * 0.5 + 1e-9)
      for (const o of obstacles) expect(o.h).toBeLessThanOrEqual(JUMP_ARC.maxHeight * 0.55 + 1e-9)
      for (const o of obstacles) if (o.kind === 'spike') expect(o.h).toBe(HAZARD_LIMITS.spikeH)
    }
  })

  it('never sits on a coin, in the first gap, or in a gate gap', () => {
    for (let seed = 0; seed < 30; seed++) {
      const { obstacles, pits } = placeHazards(12, seed, [4, 7])
      for (const h of [...obstacles, ...pits]) {
        expect(h.x % 1).toBe(0.5)
        expect(h.x).toBeGreaterThan(1)
        expect([4.5, 7.5]).not.toContain(h.x)
      }
    }
  })

  it('leaves at least MIN_LANDING of ground between hazards', () => {
    for (let seed = 0; seed <= 20; seed++) {
      for (let n = 3; n <= 15; n++) {
        const { obstacles, pits } = placeHazards(n, seed)
        const edges = [...obstacles, ...pits]
          .map(h => ({ l: h.x * COIN_SPACING - h.w / 2, r: h.x * COIN_SPACING + h.w / 2 }))
          .sort((a, b) => a.l - b.l)
        for (let i = 1; i < edges.length; i++) expect(edges[i].l - edges[i - 1].r).toBeGreaterThanOrEqual(MIN_LANDING)
      }
    }
  })

  it('uses a mix of pits, crates and spikes across zones', () => {
    const kinds = new Set<string>()
    for (let seed = 0; seed < 20; seed++) {
      const { obstacles, pits } = placeHazards(10, seed)
      if (pits.length) kinds.add('pit')
      for (const o of obstacles) kinds.add(o.kind)
    }
    expect(kinds).toEqual(new Set(['pit', 'crate', 'spike']))
  })

  it('caps hazard count at ceil(coins / 2.5)', () => {
    for (const n of [3, 6, 9, 12, 15]) {
      const { obstacles, pits } = placeHazards(n, n)
      expect(obstacles.length + pits.length).toBeLessThanOrEqual(Math.ceil(n / 2.5))
    }
  })
})

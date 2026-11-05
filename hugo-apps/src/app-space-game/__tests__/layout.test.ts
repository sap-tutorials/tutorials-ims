import { describe, it, expect } from 'vitest'
import { buildWorldLayout, goalAt, zoneIndexAt, COIN_Y, GOAL_REACH } from '../layout'
import { COIN_SPACING } from '../obstacles'
import type { LevelModel, Zone } from '../types'

function zone(id: string, coins: number, extra: Partial<Zone> = {}): Zone {
  return {
    id, title: id.toUpperCase(), colorIndex: 0, cleared: false, locked: false,
    coins: Array.from({ length: coins }, (_, i) => ({ title: `T${i}`, done: false, available: true })),
    gates: [], goal: { kind: 'track', label: 'Complete Track', prizeId: null, trackId: id },
    obstacles: [], pits: [], ...extra,
  }
}

describe('buildWorldLayout', () => {
  const model: LevelModel = {
    zones: [
      zone('a', 3, { gates: [{ afterCoinIndex: 0 }], obstacles: [{ x: 1.5, w: 1.3, h: 1, kind: 'crate' }] }),
      zone('b', 2, { pits: [{ x: 0.5, w: 2 }], locked: true }),
    ],
  }
  const L = buildWorldLayout(model)

  it('places coins at regular spacing on the walking line', () => {
    const a = L.coins.filter(c => c.zoneIndex === 0)
    expect(a).toHaveLength(3)
    expect(a[1].x - a[0].x).toBe(COIN_SPACING)
    expect(a.every(c => c.y === COIN_Y)).toBe(true)
  })

  it('zones are contiguous and the goal sits after the last coin', () => {
    expect(L.zones[1].x0).toBe(L.zones[0].x1)
    const lastA = L.coins.filter(c => c.zoneIndex === 0).at(-1)!
    expect(L.zones[0].goal.x).toBeGreaterThan(lastA.x)
    expect(L.zones[0].goal.x).toBeLessThan(L.zones[0].x1)
  })

  it('converts hazards to world edges between coins', () => {
    const coins = L.coins.filter(c => c.zoneIndex === 0)
    const crate = L.hazards.crates[0]
    expect((crate.x0 + crate.x1) / 2).toBeCloseTo((coins[1].x + coins[2].x) / 2)
    expect(crate.top).toBe(1)
    expect(L.hazards.pits).toHaveLength(1)
  })

  it('carries locked state and track id onto goals', () => {
    expect(L.zones[1].goal.locked).toBe(true)
    expect(L.zones[1].goal.trackId).toBe('b')
  })

  it('zoneIndexAt / goalAt find the right zone and goal', () => {
    expect(zoneIndexAt(L, 0)).toBe(0)
    expect(zoneIndexAt(L, L.zones[1].x0 + 1)).toBe(1)
    expect(goalAt(L, L.zones[0].goal.x + GOAL_REACH * 0.5)?.zoneId).toBe('a')
    expect(goalAt(L, L.zones[0].goal.x - GOAL_REACH - 1)).toBeNull()
  })

  it('the level has walls just outside the first and last zone', () => {
    expect(L.hazards.minX).toBe(0)
    expect(L.hazards.maxX).toBe(L.length)
    expect(L.length).toBeGreaterThan(L.zones[1].x1)
  })
})

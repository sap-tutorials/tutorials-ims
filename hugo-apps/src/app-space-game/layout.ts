// Pure world layout: converts the LevelModel into world-space positions shared by
// physics, autopilot, labels and the renderer. No Three.js, no DOM.

import type { LevelModel, Goal } from './types'
import { COIN_SPACING } from './obstacles'

export const ZONE_LEAD = 6     // ground before a zone's first coin (zone sign lives here)
export const GOAL_TAIL = 6     // ground after a zone's goal before the next zone starts
export const COIN_Y = 1.3      // coin centre height — collected by walking past
export const LEVEL_PAD = 4     // solid ground before the first and after the last zone
export const GOAL_REACH = 1.8  // |kasimir.x − goal.x| within which the goal can be opened

export interface Box { x0: number; x1: number; top: number }
export interface Span { x0: number; x1: number }

export interface WorldHazards {
  crates: Box[]
  spikes: Box[]
  pits: Span[]
  minX: number
  maxX: number
}

export interface WorldCoin {
  x: number
  y: number
  title: string
  done: boolean
  available: boolean
  zoneIndex: number
  index: number // 0-based within the zone
}

export interface WorldGoal extends Goal {
  x: number
  zoneId: string
  zoneTitle: string
  zoneIndex: number
  locked: boolean
}

export interface WorldZone {
  id: string
  title: string
  colorIndex: number
  locked: boolean
  cleared: boolean
  x0: number
  x1: number
  coinCount: number
  goal: WorldGoal
}

export interface WorldLayout {
  zones: WorldZone[]
  coins: WorldCoin[]
  gates: { x: number; zoneIndex: number }[]
  hazards: WorldHazards
  spawnX: number
  length: number
}

export function buildWorldLayout(model: LevelModel): WorldLayout {
  const zones: WorldZone[] = []
  const coins: WorldCoin[] = []
  const gates: WorldLayout['gates'] = []
  const crates: Box[] = []
  const spikes: Box[] = []
  const pits: Span[] = []
  let cursor = LEVEL_PAD

  model.zones.forEach((zone, zi) => {
    const x0 = cursor
    const firstCoin = x0 + ZONE_LEAD
    zone.coins.forEach((coin, k) => {
      coins.push({
        x: firstCoin + k * COIN_SPACING,
        y: COIN_Y,
        title: coin.title,
        done: coin.done,
        available: coin.available,
        zoneIndex: zi,
        index: k,
      })
    })
    for (const g of zone.gates) {
      gates.push({ x: firstCoin + (g.afterCoinIndex + 0.5) * COIN_SPACING, zoneIndex: zi })
    }
    for (const o of zone.obstacles) {
      const cx = firstCoin + o.x * COIN_SPACING
      const box = { x0: cx - o.w / 2, x1: cx + o.w / 2, top: o.h }
      if (o.kind === 'spike') spikes.push(box)
      else crates.push(box)
    }
    for (const p of zone.pits) {
      const cx = firstCoin + p.x * COIN_SPACING
      pits.push({ x0: cx - p.w / 2, x1: cx + p.w / 2 })
    }
    const lastCoinX = zone.coins.length ? firstCoin + (zone.coins.length - 1) * COIN_SPACING : x0 + 2
    const goalX = lastCoinX + COIN_SPACING
    const x1 = goalX + GOAL_TAIL
    zones.push({
      id: zone.id,
      title: zone.title,
      colorIndex: zone.colorIndex,
      locked: zone.locked,
      cleared: zone.cleared,
      x0,
      x1,
      coinCount: zone.coins.length,
      goal: { ...zone.goal, x: goalX, zoneId: zone.id, zoneTitle: zone.title, zoneIndex: zi, locked: zone.locked },
    })
    cursor = x1
  })

  const length = cursor + LEVEL_PAD
  return {
    zones,
    coins,
    gates,
    hazards: { crates, spikes, pits, minX: 0, maxX: length },
    spawnX: 2,
    length,
  }
}

/** Index of the zone containing world x (clamped to first/last). */
export function zoneIndexAt(layout: WorldLayout, x: number): number {
  const zs = layout.zones
  if (!zs.length) return -1
  for (let i = 0; i < zs.length; i++) {
    if (x < zs[i].x1) return i
  }
  return zs.length - 1
}

/** The goal Kasimir is standing at, if any. */
export function goalAt(layout: WorldLayout, x: number): WorldGoal | null {
  for (const z of layout.zones) {
    if (Math.abs(x - z.goal.x) <= GOAL_REACH) return z.goal
  }
  return null
}

import { describe, it, expect } from 'vitest'
import { placeHazards } from '../obstacles'
import { buildWorldLayout } from '../layout'
import { initialState, stepPhysics } from '../physics'
import { autopilotInput } from '../autopilot'
import { FIXED_DT } from '../constants'
import type { LevelModel, Zone } from '../types'

function zone(coinCount: number, seed: number, gateAfter: number[] = []): Zone {
  const { obstacles, pits } = placeHazards(coinCount, seed, gateAfter)
  return {
    id: `z${seed}-${coinCount}`,
    title: 'Zone',
    colorIndex: seed,
    cleared: false,
    locked: false,
    coins: Array.from({ length: coinCount }, (_, i) => ({ title: `T${i}`, done: false, available: true })),
    gates: gateAfter.map(a => ({ afterCoinIndex: a })),
    goal: { kind: 'track', label: 'Complete Track', prizeId: null, trackId: 't' },
    obstacles,
    pits,
  }
}

function runAutopilot(model: LevelModel) {
  const layout = buildWorldLayout(model)
  let s = initialState(layout.spawnX)
  const events: string[] = []
  let t = 0
  let lastAdvance = 0
  let bestX = s.x
  let wedged = false
  while (s.x < layout.length - 3 && t < 300) {
    const { next, event } = stepPhysics(s, autopilotInput(s, layout.hazards), layout.hazards, FIXED_DT)
    if (event === 'hit' || event === 'fell') events.push(`${event}@${s.x.toFixed(1)}`)
    s = next
    t += FIXED_DT
    if (s.x > bestX + 0.5) { bestX = s.x; lastAdvance = t }
    if (t - lastAdvance > 3) { wedged = true; break }
    if (event === 'fell') break
  }
  return { events, wedged, finished: s.x >= layout.length - 3, layout }
}

describe('level solvability (autopilot never needs the watchdog)', () => {
  it('clears every seed 0..40 × coin counts 3..15 without a hit, fall or wedge', () => {
    const failures: string[] = []
    let hazardsSeen = 0
    for (let seed = 0; seed <= 40; seed++) {
      for (let n = 3; n <= 15; n++) {
        const r = runAutopilot({ zones: [zone(n, seed)] })
        hazardsSeen += r.layout.hazards.crates.length + r.layout.hazards.spikes.length + r.layout.hazards.pits.length
        if (!r.finished || r.wedged || r.events.length) {
          failures.push(`seed ${seed} n ${n}: finished=${r.finished} wedged=${r.wedged} ${r.events.join(',')}`)
        }
      }
    }
    expect(hazardsSeen).toBeGreaterThan(500)
    expect(failures).toEqual([])
  })

  it('clears a multi-zone level with gates', () => {
    const model: LevelModel = { zones: [zone(8, 1, [3]), zone(12, 2, [5]), zone(5, 3)] }
    const r = runAutopilot(model)
    expect(r.events).toEqual([])
    expect(r.wedged).toBe(false)
    expect(r.finished).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { autopilotInput, watchdog } from '../autopilot'
import type { ProgressTrack } from '../autopilot'
import { initialState } from '../physics'
import type { WorldHazards } from '../layout'

const world = (h: Partial<WorldHazards> = {}): WorldHazards => ({
  crates: [], spikes: [], pits: [], minX: 0, maxX: 200, ...h,
})

describe('autopilotInput', () => {
  it('runs right without jumping on clear ground', () => {
    expect(autopilotInput({ ...initialState(5), vx: 7 }, world())).toEqual({ moveDir: 1, jump: false })
  })

  it('jumps when a pit edge is within launch distance', () => {
    const r = autopilotInput({ ...initialState(5), vx: 7 }, world({ pits: [{ x0: 6.2, x1: 8.5 }] }))
    expect(r).toEqual({ moveDir: 1, jump: true })
  })

  it('does not jump while the hazard is still far away', () => {
    const r = autopilotInput({ ...initialState(5), vx: 7 }, world({ crates: [{ x0: 15, x1: 16.3, top: 1.2 }] }))
    expect(r.jump).toBe(false)
  })

  it('keeps holding jump while rising (full-height jump), releases while falling', () => {
    const rising = { ...initialState(5), y: 1, vy: 5, onGround: false }
    const falling = { ...rising, vy: -5 }
    expect(autopilotInput(rising, world()).jump).toBe(true)
    expect(autopilotInput(falling, world()).jump).toBe(false)
  })

  it('ignores hazards already passed', () => {
    const r = autopilotInput({ ...initialState(10), vx: 7 }, world({ spikes: [{ x0: 7, x1: 8.5, top: 0.55 }] }))
    expect(r.jump).toBe(false)
  })
})

describe('watchdog', () => {
  const stalled: ProgressTrack = { lastX: 5, lastAdvanceT: 0, nowT: 4 }

  it('stays quiet while progress is recent', () => {
    const s = initialState(5)
    const r = watchdog({ lastX: 5, lastAdvanceT: 0, nowT: 2 }, s, world())
    expect(r.forced).toBe(false)
    expect(r.next).toBe(s)
  })

  it('frees a wedge past the blocking hazard', () => {
    const r = watchdog(stalled, initialState(5), world({ crates: [{ x0: 5.5, x1: 6.8, top: 1.4 }] }))
    expect(r.forced).toBe(true)
    expect(r.next.x).toBeGreaterThan(6.8)
    expect(r.next.onGround).toBe(true)
    expect(r.next.lastSafeX).toBe(r.next.x)
  })

  it('nudges forward when nothing is ahead', () => {
    const r = watchdog(stalled, initialState(5), world())
    expect(r.forced).toBe(true)
    expect(r.next.x).toBe(11)
  })
})

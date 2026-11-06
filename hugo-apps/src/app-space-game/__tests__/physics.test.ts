import { describe, it, expect } from 'vitest'
import { stepPhysics, respawn, initialState, GROUND_Y } from '../physics'
import type { PhysicsState, PhysicsInput } from '../physics'
import type { WorldHazards } from '../layout'
import { FIXED_DT, JUMP_ARC, BODY_HW, INVULN_S } from '../constants'

const world = (h: Partial<WorldHazards> = {}): WorldHazards => ({
  crates: [], spikes: [], pits: [], minX: 0, maxX: 200, ...h,
})
const idle: PhysicsInput = { moveDir: 0, jump: false }

function run(s: PhysicsState, input: PhysicsInput | ((s: PhysicsState, i: number) => PhysicsInput), h: WorldHazards, seconds: number) {
  const events: string[] = []
  const n = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < n; i++) {
    const inp = typeof input === 'function' ? input(s, i) : input
    const r = stepPhysics(s, inp, h, FIXED_DT)
    if (r.event !== 'none') events.push(r.event)
    s = r.next
  }
  return { s, events }
}

describe('stepPhysics', () => {
  it('feet rest on the ground at y = 0', () => {
    const { s } = run({ ...initialState(5), y: 4, onGround: false }, idle, world(), 2)
    expect(s.y).toBe(GROUND_Y)
    expect(s.onGround).toBe(true)
  })

  it('accelerates smoothly instead of snapping to full speed', () => {
    const first = stepPhysics(initialState(5), { moveDir: 1, jump: false }, world(), FIXED_DT).next
    expect(first.vx).toBeGreaterThan(0)
    expect(first.vx).toBeLessThan(1)
    const { s } = run(initialState(5), { moveDir: 1, jump: false }, world(), 1)
    expect(s.vx).toBeCloseTo(7, 5)
  })

  it('moves left and faces left', () => {
    const { s } = run(initialState(50), { moveDir: -1, jump: false }, world(), 0.5)
    expect(s.x).toBeLessThan(50)
    expect(s.facing).toBe(-1)
  })

  it('a full held jump reaches JUMP_ARC.maxHeight; a tap is lower (variable jump)', () => {
    const peak = (hold: number) => {
      let s = initialState(5)
      let max = 0
      for (let i = 0; i < 200; i++) {
        s = stepPhysics(s, { moveDir: 0, jump: i < hold }, world(), FIXED_DT).next
        max = Math.max(max, s.y)
      }
      return max
    }
    const full = peak(200)
    expect(full).toBeGreaterThan(JUMP_ARC.maxHeight * 0.95)
    expect(full).toBeLessThanOrEqual(JUMP_ARC.maxHeight + 1e-6)
    expect(peak(6)).toBeLessThan(JUMP_ARC.maxHeight * 0.6)
  })

  it('holding jump does not re-jump on landing (needs a fresh press)', () => {
    const { events } = run(initialState(5), { moveDir: 0, jump: true }, world(), 2)
    expect(events.filter(e => e === 'jump')).toHaveLength(1)
  })

  it('jump buffer: a press shortly before landing still jumps', () => {
    let s: PhysicsState = { ...initialState(5), y: 0.3, vy: -6, onGround: false }
    s = stepPhysics(s, { moveDir: 0, jump: true }, world(), FIXED_DT).next
    const { events } = run(s, { moveDir: 0, jump: true }, world(), 0.1)
    expect(events).toContain('jump')
  })

  it('coyote time: can still jump just after walking off a ledge', () => {
    const pit = { x0: 10, x1: 14 }
    let s: PhysicsState = { ...initialState(10.1), vx: 7 }
    s = stepPhysics(s, { moveDir: 1, jump: false }, world({ pits: [pit] }), FIXED_DT).next
    expect(s.onGround).toBe(false)
    const r = stepPhysics(s, { moveDir: 1, jump: true }, world({ pits: [pit] }), FIXED_DT)
    expect(r.event).toBe('jump')
  })

  it('crates block from the side with NO penalty event', () => {
    const crate = { x0: 8, x1: 9.3, top: 1.2 }
    const { s, events } = run(initialState(5), { moveDir: 1, jump: false }, world({ crates: [crate] }), 2)
    expect(s.x).toBeCloseTo(crate.x0 - BODY_HW, 5)
    expect(events).not.toContain('hit')
  })

  it('can land on top of a crate', () => {
    const crate = { x0: 8, x1: 9.3, top: 1.2 }
    const s0: PhysicsState = { ...initialState(8.6), y: 3, onGround: false }
    const { s } = run(s0, idle, world({ crates: [crate] }), 1)
    expect(s.y).toBeCloseTo(1.2, 5)
    expect(s.onGround).toBe(true)
  })

  it('falls into a pit and reports fell', () => {
    const pit = { x0: 10, x1: 13 }
    const { s, events } = run(initialState(9), { moveDir: 1, jump: false }, world({ pits: [pit] }), 2)
    expect(events).toContain('fell')
    expect(s.x).toBeGreaterThan(pit.x0)
    expect(s.x).toBeLessThan(pit.x1)
  })

  it('clears a max-width pit with a running jump', () => {
    const pit = { x0: 12, x1: 12 + JUMP_ARC.maxGap * 0.5 }
    const { s, events } = run(
      { ...initialState(5), vx: 7 },
      (st) => ({ moveDir: 1, jump: st.x > pit.x0 - 1.4 && st.x < pit.x0 }),
      world({ pits: [pit] }),
      2,
    )
    expect(events).not.toContain('fell')
    expect(s.x).toBeGreaterThan(pit.x1)
  })

  it('spikes cost a hit with knock-back and brief invulnerability', () => {
    const spike = { x0: 8, x1: 9.5, top: 0.55 }
    let s: PhysicsState = { ...initialState(6), vx: 7 }
    let hit = false
    for (let i = 0; i < 120 && !hit; i++) {
      const r = stepPhysics(s, { moveDir: 1, jump: false }, world({ spikes: [spike] }), FIXED_DT)
      s = r.next
      hit = r.event === 'hit'
    }
    expect(hit).toBe(true)
    expect(s.vx).toBeLessThan(0)
    expect(s.vy).toBeGreaterThan(0)
    expect(s.invuln).toBeCloseTo(INVULN_S, 5)
  })

  it('level walls stop Kasimir at both ends', () => {
    const { s } = run(initialState(2), { moveDir: -1, jump: false }, world({ minX: 0, maxX: 30 }), 2)
    expect(s.x).toBeCloseTo(BODY_HW, 5)
    const r = run(initialState(28), { moveDir: 1, jump: false }, world({ minX: 0, maxX: 30 }), 2)
    expect(r.s.x).toBeCloseTo(30 - BODY_HW, 5)
  })

  it('lastSafeX stays away from hazard edges', () => {
    const pit = { x0: 10, x1: 13 }
    const { s } = run(initialState(5), { moveDir: 1, jump: false }, world({ pits: [pit] }), 2)
    expect(s.lastSafeX).toBeLessThanOrEqual(pit.x0 - 1.2)
  })
})

describe('respawn', () => {
  it('returns to lastSafeX on the ground, stopped and briefly invulnerable', () => {
    const s: PhysicsState = { ...initialState(8), y: -4, vy: -10, vx: 3, onGround: false, lastSafeX: 4 }
    const r = respawn(s)
    expect(r).toMatchObject({ x: 4, y: 0, vx: 0, vy: 0, onGround: true })
    expect(r.invuln).toBeGreaterThan(0)
  })
})

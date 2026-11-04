import { describe, it, expect } from 'vitest'
import { stepPhysics, respawn } from '../physics'
import type { PhysicsState, WorldHazards } from '../physics'

// Helper: build a PhysicsState with sane defaults
function mk(partial: Partial<PhysicsState> = {}): PhysicsState {
  return {
    x: 5,
    y: 1.8,
    vy: 0,
    onGround: true,
    facing: 1,
    lastSafeX: 5,
    ...partial,
  }
}

const noHazards: WorldHazards = { obstacles: [], pits: [] }

describe('stepPhysics', () => {
  // Test 1: Gravity + land
  it('gravity: airborne state drops and eventually lands at ground (y=1.8, onGround true)', () => {
    let s = mk({ y: 5, vy: 0, onGround: false })
    const dt = 0.05
    // Run up to 200 steps (10 seconds) to let it fall
    let landed = false
    let prevY = s.y
    for (let i = 0; i < 200; i++) {
      const { next } = stepPhysics(s, { moveDir: 0, jump: false }, noHazards, dt)
      if (i > 0) {
        expect(next.y).toBeLessThanOrEqual(prevY + 0.001) // y should be decreasing or at ground
      }
      s = next
      if (s.onGround) {
        landed = true
        break
      }
      prevY = s.y
    }
    expect(landed).toBe(true)
    expect(s.y).toBeCloseTo(1.8, 4)
    expect(s.onGround).toBe(true)
  })

  // Test 2: Jump
  it('jump: grounded + jump:true -> next.vy > 0, next.onGround false', () => {
    const s = mk()
    const { next } = stepPhysics(s, { moveDir: 0, jump: true }, noHazards, 0.016)
    expect(next.vy).toBeGreaterThan(0)
    expect(next.onGround).toBe(false)
  })

  // Test 3: Jump consumed — second step while airborne does NOT add velocity
  it('jump consumed: airborne + jump:true does NOT re-apply jump velocity', () => {
    const s = mk()
    const dt = 0.016
    // First step: jump
    const { next: after1 } = stepPhysics(s, { moveDir: 0, jump: true }, noHazards, dt)
    expect(after1.onGround).toBe(false)
    const vyAfterJump = after1.vy
    // Second step: still holding jump but airborne
    const { next: after2 } = stepPhysics(after1, { moveDir: 0, jump: true }, noHazards, dt)
    // vy should have DECREASED due to gravity (not increased by another JUMP)
    expect(after2.vy).toBeLessThan(vyAfterJump)
  })

  // Test 4: Move right and left
  it('move right: moveDir:1 -> next.x > s.x, facing 1', () => {
    const s = mk()
    const { next } = stepPhysics(s, { moveDir: 1, jump: false }, noHazards, 0.016)
    expect(next.x).toBeGreaterThan(s.x)
    expect(next.facing).toBe(1)
  })

  it('move left: moveDir:-1 -> next.x < s.x, facing -1', () => {
    const s = mk()
    const { next } = stepPhysics(s, { moveDir: -1, jump: false }, noHazards, 0.016)
    expect(next.x).toBeLessThan(s.x)
    expect(next.facing).toBe(-1)
  })

  // Test 5: Obstacle blocks (grounded, moving right into obstacle)
  it('obstacle blocks: grounded moving right into obstacle -> x clamped to near edge, event hit', () => {
    // Kasimir at x=5, obstacle at x=7 with w=1 -> left edge = 6.5
    // Moving right with large dt should be blocked at near edge
    const obs = { x: 7, w: 1, h: 2 }
    const hazards: WorldHazards = { obstacles: [obs], pits: [] }
    const s = mk({ x: 5, y: 1.8, onGround: true })
    // Use a large dt so move would overshoot
    const { next, event } = stepPhysics(s, { moveDir: 1, jump: false }, hazards, 0.5)
    const nearEdge = obs.x - obs.w / 2  // 6.5
    expect(next.x).toBeLessThanOrEqual(nearEdge + 0.001)
    expect(event).toBe('hit')
  })

  // Test 6: Obstacle cleared by jump (airborne above obstacle top)
  it('obstacle cleared: airborne above obstacle top -> not blocked, event none', () => {
    // Obstacle h=2, top = 1.8 + 2 = 3.8
    // Kasimir at y=5 (above top), moving right
    const obs = { x: 7, w: 1, h: 2 }
    const hazards: WorldHazards = { obstacles: [obs], pits: [] }
    const s = mk({ x: 5, y: 5, vy: 0, onGround: false })
    const { next, event } = stepPhysics(s, { moveDir: 1, jump: false }, hazards, 0.5)
    // Should pass through, x should have moved right
    const nearEdge = obs.x - obs.w / 2  // 6.5
    expect(next.x).toBeGreaterThan(nearEdge)
    expect(event).toBe('none')
  })

  // Test 7: Pit fall — grounded walking over pit
  it('pit fall: grounded walking over pit -> event fell, y drops below 1.8', () => {
    // Pit at x=8, w=2 -> [7, 9]
    // Kasimir at x=8 (center of pit), onGround
    const pit = { x: 8, w: 2 }
    const hazards: WorldHazards = { obstacles: [], pits: [pit] }
    const s = mk({ x: 8, y: 1.8, onGround: true })
    const { next, event } = stepPhysics(s, { moveDir: 0, jump: false }, hazards, 0.016)
    expect(event).toBe('fell')
    // After falling, y should drop below ground
    expect(next.y).toBeLessThan(1.8)
  })

  // Test 8: Pit cleared — airborne over pit
  it('pit cleared: airborne over pit -> no fell event, passes', () => {
    const pit = { x: 8, w: 2 }
    const hazards: WorldHazards = { obstacles: [], pits: [pit] }
    // Airborne above pit
    const s = mk({ x: 8, y: 4, vy: 2, onGround: false })
    const { event } = stepPhysics(s, { moveDir: 1, jump: false }, hazards, 0.016)
    expect(event).not.toBe('fell')
  })

  // Test 9: respawn
  it('respawn: lastSafeX:12, fallen (y:-3) -> x:12, y:1.8, onGround:true, vy:0', () => {
    const s = mk({ x: 8, y: -3, vy: -10, onGround: false, lastSafeX: 12 })
    const result = respawn(s)
    expect(result.x).toBe(12)
    expect(result.y).toBe(1.8)
    expect(result.onGround).toBe(true)
    expect(result.vy).toBe(0)
  })
})

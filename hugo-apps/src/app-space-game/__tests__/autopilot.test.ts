import { describe, it, expect } from 'vitest'
import { autopilotInput, watchdog } from '../autopilot'
import type { ProgressTrack } from '../autopilot'

// PhysicsState shape — matches physics.ts exactly (type-only; defined locally
// so this test runs even if physics.ts is not yet on disk).
interface PhysicsState {
  x: number
  y: number
  vy: number
  onGround: boolean
  facing: 1 | -1
  lastSafeX: number
}

interface WorldHazards {
  obstacles: { x: number; w: number; h: number }[]
  pits: { x: number; w: number }[]
}

// Helper: default PhysicsState as specified in the brief
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

describe('autopilotInput', () => {
  // Test 1: Clear ground (empty hazards) → {moveDir:1, jump:false}
  it('clear ground: empty hazards → moveDir:1, jump:false', () => {
    const result = autopilotInput(mk(), noHazards)
    expect(result).toEqual({ moveDir: 1, jump: false })
  })

  // Test 2: moveDir is always 1 — even with a hazard dead ahead
  it('moveDir is always 1 even with a hazard dead ahead', () => {
    const hazards: WorldHazards = {
      obstacles: [{ x: 5.5, w: 1, h: 2 }],
      pits: [],
    }
    const result = autopilotInput(mk(), hazards)
    expect(result.moveDir).toBe(1)
  })

  // Test 3: Pit edge just ahead within lookahead, onGround → jump:true
  it('pit edge within lookahead, onGround → jump:true', () => {
    // s.x=5, lookahead=3 → checks x in [5, 8]
    // Pit near edge at x=7, w=2 → left edge = 6. Within lookahead.
    const hazards: WorldHazards = {
      obstacles: [],
      pits: [{ x: 7, w: 2 }],
    }
    const result = autopilotInput(mk({ x: 5, onGround: true }), hazards)
    expect(result.jump).toBe(true)
  })

  // Test 4: Hazard far away (beyond lookahead) → jump:false
  it('hazard far away (beyond lookahead) → jump:false', () => {
    // s.x=5, lookahead=3 → hazard must be beyond x=8
    const hazards: WorldHazards = {
      obstacles: [{ x: 15, w: 1, h: 2 }],
      pits: [],
    }
    const result = autopilotInput(mk({ x: 5, onGround: true }), hazards)
    expect(result.jump).toBe(false)
  })

  // Test 5: Not on ground (airborne) with hazard ahead → jump:false
  it('airborne with hazard ahead → jump:false (no double-jump)', () => {
    const hazards: WorldHazards = {
      obstacles: [{ x: 7, w: 1, h: 2 }],
      pits: [],
    }
    // onGround: false
    const result = autopilotInput(mk({ x: 5, onGround: false }), hazards)
    expect(result.jump).toBe(false)
  })
})

describe('watchdog', () => {
  // Test 6: Watchdog fires: 4s stall with obstacle at x≈6 → forced:true, next.x > 6+0.5, onGround true
  it('fires after stall >3s with obstacle → forced:true, next.x past obstacle far edge, onGround true', () => {
    const s = mk({ x: 5 })
    // obstacle at x=6, w=1 → far edge = 6 + 0.5 = 6.5
    const hazards: WorldHazards = {
      obstacles: [{ x: 6, w: 1, h: 2 }],
      pits: [],
    }
    const progress: ProgressTrack = { lastX: 5, lastAdvanceT: 0, nowT: 4 }
    const { forced, next } = watchdog(progress, s, hazards)
    expect(forced).toBe(true)
    expect(next.x).toBeGreaterThan(6)   // past the obstacle far edge
    expect(next.onGround).toBe(true)
  })

  // Test 7: Watchdog quiet: nowT:2 (under 3s) → forced:false, next === s
  it('quiet when under 3s stall → forced:false, next x unchanged', () => {
    const s = mk({ x: 5 })
    const progress: ProgressTrack = { lastX: 5, lastAdvanceT: 0, nowT: 2 }
    const { forced, next } = watchdog(progress, s, noHazards)
    expect(forced).toBe(false)
    expect(next.x).toBe(s.x)
  })

  // Test 8: Stalled >3s with no hazards → forced:true, next.x === s.x + 8
  it('stalled >3s with no hazards → forced:true, next.x === s.x + 8', () => {
    const s = mk({ x: 5 })
    const progress: ProgressTrack = { lastX: 5, lastAdvanceT: 0, nowT: 4 }
    const { forced, next } = watchdog(progress, s, noHazards)
    expect(forced).toBe(true)
    expect(next.x).toBe(5 + 8)
  })

  // Test 9: Lodged in obstacle, stalled >3s → watchdog frees him (next.x beyond obstacle)
  it('lodged in obstacle stalled >3s → freed beyond obstacle far edge', () => {
    // Kasimir at x=6 (inside obstacle centered at x=6, w=2 → [5, 7])
    const s = mk({ x: 6 })
    const hazards: WorldHazards = {
      obstacles: [{ x: 6, w: 2, h: 2 }],
      pits: [],
    }
    const progress: ProgressTrack = { lastX: 6, lastAdvanceT: 0, nowT: 4 }
    const { forced, next } = watchdog(progress, s, hazards)
    expect(forced).toBe(true)
    // far edge = 6 + 1 = 7 → next.x must be > 7
    expect(next.x).toBeGreaterThan(7)
  })
})

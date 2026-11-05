// Pure platformer physics for Kasimir. y is the FEET position; ground top is y = 0.
// Crates are solid (block from the side, standable on top); spikes cost rings;
// pits are gaps in the ground you fall through.

import {
  SPEED, ACCEL, DECEL, TURN_ACCEL, AIR_ACCEL, GRAV, JUMP, JUMP_CUT_GRAV, FALL_GRAV, MAX_FALL,
  COYOTE_S, JUMP_BUFFER_S, INVULN_S, FALL_LIMIT_Y, BODY_HW,
} from './constants'
import type { WorldHazards } from './layout'

export type { WorldHazards } from './layout'

export const GROUND_Y = 0
const EPS = 0.04
const PIT_FORGIVE = 0.15 // feet may hang this far over a pit edge without falling
const SAFE_MARGIN = 1.2  // respawn points keep this much ground from any hazard

export interface PhysicsState {
  x: number
  y: number
  vx: number
  vy: number
  onGround: boolean
  facing: 1 | -1
  coyote: number
  jumpBuffer: number
  jumpHeld: boolean
  invuln: number
  lastSafeX: number
}

export interface PhysicsInput {
  moveDir: -1 | 0 | 1
  jump: boolean // button currently held
}

export type PhysicsEvent = 'none' | 'jump' | 'land' | 'hit' | 'fell'

export function initialState(x: number): PhysicsState {
  return {
    x, y: GROUND_Y, vx: 0, vy: 0, onGround: true, facing: 1,
    coyote: 0, jumpBuffer: 0, jumpHeld: false, invuln: 0, lastSafeX: x,
  }
}

function approach(v: number, target: number, step: number): number {
  return v < target ? Math.min(v + step, target) : Math.max(v - step, target)
}

export function overPit(x: number, pits: WorldHazards['pits']): boolean {
  for (const p of pits) {
    if (x > p.x0 + PIT_FORGIVE && x < p.x1 - PIT_FORGIVE) return true
  }
  return false
}

function isSafe(x: number, h: WorldHazards): boolean {
  const near = (x0: number, x1: number) => x > x0 - SAFE_MARGIN && x < x1 + SAFE_MARGIN
  for (const p of h.pits) if (near(p.x0, p.x1)) return false
  for (const c of h.crates) if (near(c.x0, c.x1)) return false
  for (const s of h.spikes) if (near(s.x0, s.x1)) return false
  return true
}

export function stepPhysics(
  s: PhysicsState,
  input: PhysicsInput,
  h: WorldHazards,
  dt: number,
): { next: PhysicsState; event: PhysicsEvent } {
  let { vx, vy, onGround, facing, coyote, jumpBuffer, invuln, lastSafeX } = s
  const { x, y } = s
  let event: PhysicsEvent = 'none'
  const pressed = input.jump && !s.jumpHeld

  jumpBuffer = pressed ? JUMP_BUFFER_S : Math.max(0, jumpBuffer - dt)
  coyote = onGround ? COYOTE_S : Math.max(0, coyote - dt)
  invuln = Math.max(0, invuln - dt)

  // --- Horizontal velocity ---
  const target = input.moveDir * SPEED
  let accel: number
  if (!onGround) accel = AIR_ACCEL
  else if (input.moveDir === 0) accel = DECEL
  else if (vx !== 0 && Math.sign(vx) !== input.moveDir) accel = TURN_ACCEL
  else accel = ACCEL
  vx = approach(vx, target, accel * dt)
  if (input.moveDir !== 0) facing = input.moveDir

  // --- Jump (buffered + coyote) ---
  if (jumpBuffer > 0 && (onGround || coyote > 0)) {
    vy = JUMP
    onGround = false
    coyote = 0
    jumpBuffer = 0
    event = 'jump'
  }

  // --- Gravity (variable jump height: releasing early cuts the rise) ---
  let g = GRAV
  if (vy > 0 && !input.jump) g *= JUMP_CUT_GRAV
  else if (vy < 0) g *= FALL_GRAV
  vy = Math.max(MAX_FALL, vy + g * dt)

  // --- X move + crate side collision ---
  let nx = x + vx * dt
  for (const c of h.crates) {
    if (y >= c.top - EPS) continue // above the crate
    if (nx + BODY_HW > c.x0 && nx - BODY_HW < c.x1) {
      nx = x <= (c.x0 + c.x1) / 2 ? c.x0 - BODY_HW : c.x1 + BODY_HW
      vx = 0
    }
  }
  // Inside a pit: its walls hold Kasimir in the hole.
  if (y < GROUND_Y - EPS) {
    for (const p of h.pits) {
      if (x >= p.x0 && x <= p.x1) {
        const lo = Math.min(p.x0 + BODY_HW, (p.x0 + p.x1) / 2)
        const hi = Math.max(p.x1 - BODY_HW, (p.x0 + p.x1) / 2)
        if (nx < lo) { nx = lo; vx = 0 }
        if (nx > hi) { nx = hi; vx = 0 }
        break
      }
    }
  }
  // Level walls
  if (nx < h.minX + BODY_HW) { nx = h.minX + BODY_HW; vx = 0 }
  if (nx > h.maxX - BODY_HW) { nx = h.maxX - BODY_HW; vx = 0 }

  // --- Y move + landing ---
  let ny = y + vy * dt
  const wasOnGround = s.onGround
  onGround = false
  let onCrate = false
  if (vy <= 0) {
    let top = -Infinity
    for (const c of h.crates) {
      if (nx + BODY_HW > c.x0 + EPS && nx - BODY_HW < c.x1 - EPS && y >= c.top - EPS && ny <= c.top) {
        if (c.top > top) { top = c.top; onCrate = true }
      }
    }
    if (y >= GROUND_Y - EPS && ny <= GROUND_Y && !overPit(nx, h.pits) && GROUND_Y > top) {
      top = GROUND_Y
      onCrate = false
    }
    if (top > -Infinity) {
      ny = top
      vy = 0
      onGround = true
      if (!wasOnGround && event === 'none') event = 'land'
    }
  }

  // --- Spikes ---
  if (invuln === 0) {
    for (const sp of h.spikes) {
      if (nx + BODY_HW * 0.7 > sp.x0 && nx - BODY_HW * 0.7 < sp.x1 && ny < sp.top) {
        const away = Math.sign(nx - (sp.x0 + sp.x1) / 2) || -facing
        vx = away * 5
        vy = 9
        ny = Math.max(ny, sp.top)
        onGround = false
        invuln = INVULN_S
        event = 'hit'
        break
      }
    }
  }

  if (ny < FALL_LIMIT_Y) event = 'fell'

  if (onGround && !onCrate && isSafe(nx, h)) lastSafeX = nx

  return {
    next: {
      x: nx, y: ny, vx, vy, onGround, facing, coyote, jumpBuffer,
      jumpHeld: input.jump, invuln, lastSafeX,
    },
    event,
  }
}

/** State after a fall: back on the last safe ground, briefly invulnerable. */
export function respawn(s: PhysicsState): PhysicsState {
  return {
    ...s,
    x: s.lastSafeX,
    y: GROUND_Y,
    vx: 0,
    vy: 0,
    onGround: true,
    coyote: 0,
    jumpBuffer: 0,
    invuln: INVULN_S,
  }
}

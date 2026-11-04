import { SPEED, GRAV, JUMP } from './constants'

export const GROUND_Y = 1.8

export interface PhysicsState {
  x: number           // world units
  y: number           // world units; ground = 1.8 (matches renderer kasY baseline)
  vy: number
  onGround: boolean
  facing: 1 | -1     // 1 = right, -1 = left
  lastSafeX: number  // last x while grounded and NOT over a pit
}

// Hazards here are in WORLD units (renderer converts from coin-index before calling).
export interface WorldHazards {
  obstacles: { x: number; w: number; h: number }[]
  pits: { x: number; w: number }[]
}

/** Returns true if Kasimir's x is inside a pit's horizontal span */
function overPit(x: number, pits: WorldHazards['pits']): boolean {
  for (const p of pits) {
    if (x >= p.x - p.w / 2 && x <= p.x + p.w / 2) return true
  }
  return false
}

/** Returns true if Kasimir (point x, feet y) is inside an obstacle's body */
function insideObstacle(
  x: number,
  y: number,
  obs: WorldHazards['obstacles'][number],
): boolean {
  const left = obs.x - obs.w / 2
  const right = obs.x + obs.w / 2
  const top = GROUND_Y + obs.h
  return x >= left && x <= right && y < top
}

export function stepPhysics(
  s: PhysicsState,
  input: { moveDir: -1 | 0 | 1; jump: boolean },
  hazards: WorldHazards,
  dt: number,
): { next: PhysicsState; event: 'none' | 'hit' | 'fell' } {
  let { x, y, vy, onGround, facing, lastSafeX } = s
  let event: 'none' | 'hit' | 'fell' = 'none'

  // --- Jump ---
  if (input.jump && onGround) {
    vy = JUMP
    onGround = false
  }

  // --- Gravity ---
  vy += GRAV * dt
  y += vy * dt

  // --- Horizontal movement (tentative) ---
  const dx = SPEED * input.moveDir * dt
  let newX = x + dx

  if (input.moveDir !== 0) {
    facing = input.moveDir > 0 ? 1 : -1
  }

  // --- Obstacle collision (AABB, x-axis) ---
  // Check each obstacle; block if we would enter it while below its top.
  // Use the original y (pre-gravity) to determine if Kasimir was above the obstacle.
  // Kasimir is treated as a point-ish body; x is clamped to the obstacle's near edge.
  let hitObstacle = false
  for (const obs of hazards.obstacles) {
    const obsLeft = obs.x - obs.w / 2
    const obsRight = obs.x + obs.w / 2
    const obsTop = GROUND_Y + obs.h

    // Vertical check: if Kasimir started above the obstacle top, he may pass
    if (s.y >= obsTop) continue

    // Horizontal overlap: moving right crosses into the obstacle
    if (input.moveDir > 0 && x <= obsLeft && newX > obsLeft) {
      newX = obsLeft
      hitObstacle = true
    }
    // Moving left crosses into the obstacle
    else if (input.moveDir < 0 && x >= obsRight && newX < obsRight) {
      newX = obsRight
      hitObstacle = true
    }
    // Already inside (or standing still inside): push to nearest edge
    else if (newX > obsLeft && newX < obsRight) {
      const distLeft = Math.abs(newX - obsLeft)
      const distRight = Math.abs(newX - obsRight)
      newX = distLeft <= distRight ? obsLeft : obsRight
      hitObstacle = true
    }
  }

  if (hitObstacle && onGround) {
    event = 'hit'
  }

  x = newX

  // --- Ground clamping / pit detection ---
  const currentlyOverPit = overPit(x, hazards.pits)

  if (y <= GROUND_Y) {
    if (currentlyOverPit) {
      // Let Kasimir fall into the pit — do not clamp y
      // Set event to 'fell' on first frame of falling into pit
      if (!hitObstacle) {
        event = 'fell'
      }
    } else {
      // Solid ground — clamp
      y = GROUND_Y
      vy = 0
      onGround = true
    }
  }

  // --- lastSafeX update ---
  // Update while grounded and NOT over a pit and NOT inside any obstacle
  if (onGround && !currentlyOverPit && !hitObstacle) {
    let inObs = false
    for (const obs of hazards.obstacles) {
      if (insideObstacle(x, y, obs)) { inObs = true; break }
    }
    if (!inObs) {
      lastSafeX = x
    }
  }

  const next: PhysicsState = {
    x,
    y,
    vy,
    onGround,
    facing: facing as 1 | -1,
    lastSafeX,
  }

  return { next, event }
}

export function respawn(s: PhysicsState): PhysicsState {
  return {
    ...s,
    x: s.lastSafeX,
    y: GROUND_Y,
    vy: 0,
    onGround: true,
  }
}

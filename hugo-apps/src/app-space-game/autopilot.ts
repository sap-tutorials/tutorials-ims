import { SPEED, JUMP_ARC } from './constants'
import type { PhysicsState, WorldHazards } from './physics'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Seconds of no x-advance before the watchdog teleports Kasimir forward. */
const WEDGE_TIMEOUT = 3

/**
 * Default lookahead distance (world units ahead of s.x to scan for hazards).
 * 60 % of horizontal reach of a full jump arc — jump when the hazard is this
 * close, giving time to arc over while occasionally mis-timing (adds life).
 */
const DEFAULT_LOOKAHEAD = SPEED * JUMP_ARC.airtime * 0.6

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProgressTrack {
  lastX: number
  lastAdvanceT: number
  nowT: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the x coordinate of the nearest hazard edge AHEAD of `px`
 * (i.e. the left/near edge of obstacles, left edge of pits) that falls
 * within [px, px + lookahead], or null if the runway is clear.
 */
function nearestHazardEdge(
  px: number,
  hazards: WorldHazards,
  lookahead: number
): number | null {
  let nearest: number | null = null

  for (const obs of hazards.obstacles) {
    // Near (left) edge of obstacle
    const edge = obs.x - obs.w / 2
    if (edge >= px && edge <= px + lookahead) {
      if (nearest === null || edge < nearest) nearest = edge
    }
  }

  for (const pit of hazards.pits) {
    // Near (left) edge of pit
    const edge = pit.x - pit.w / 2
    if (edge >= px && edge <= px + lookahead) {
      if (nearest === null || edge < nearest) nearest = edge
    }
  }

  return nearest
}

/**
 * Return the far (right) edge of the nearest hazard at or ahead of `px`,
 * or null if no hazard is found.
 */
function nearestHazardFarEdge(
  px: number,
  hazards: WorldHazards
): number | null {
  let nearestEdge: number | null = null
  let farEdge: number | null = null

  for (const obs of hazards.obstacles) {
    const edge = obs.x - obs.w / 2
    if (edge >= px) {
      if (nearestEdge === null || edge < nearestEdge) {
        nearestEdge = edge
        farEdge = obs.x + obs.w / 2
      }
    }
    // Also handle the case where Kasimir is already inside the obstacle
    const far = obs.x + obs.w / 2
    if (far > px && edge < px) {
      if (nearestEdge === null || edge < nearestEdge) {
        nearestEdge = edge
        farEdge = far
      }
    }
  }

  for (const pit of hazards.pits) {
    const edge = pit.x - pit.w / 2
    if (edge >= px) {
      if (nearestEdge === null || edge < nearestEdge) {
        nearestEdge = edge
        farEdge = pit.x + pit.w / 2
      }
    }
    // Inside a pit
    const far = pit.x + pit.w / 2
    if (far > px && edge < px) {
      if (nearestEdge === null || edge < nearestEdge) {
        nearestEdge = edge
        farEdge = far
      }
    }
  }

  return farEdge
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Autopilot input decision for one game tick.
 *
 * - `moveDir` is ALWAYS `1` (moving right; stopping risks a wedge).
 * - `jump: true` when a hazard near-edge is within `lookahead` world units
 *   AND the character is on the ground (no double-jumps).
 *
 * Pure and deterministic — never throws.
 */
export function autopilotInput(
  s: PhysicsState,
  hazards: WorldHazards,
  lookahead?: number
): { moveDir: 1; jump: boolean } {
  const la = lookahead !== undefined ? lookahead : DEFAULT_LOOKAHEAD
  const hazardEdge = nearestHazardEdge(s.x, hazards, la)
  const shouldJump = hazardEdge !== null && s.onGround
  return { moveDir: 1, jump: shouldJump }
}

/**
 * Hard watchdog: if x hasn't advanced > 0.5 world units in WEDGE_TIMEOUT
 * seconds, teleport Kasimir forward past the nearest blocking hazard.
 *
 * - `forced: true`  → state was reset; `next` is the teleported state.
 * - `forced: false` → no action; `next` is the original `s` unchanged.
 *
 * Pure and deterministic — never throws.
 */
export function watchdog(
  progress: ProgressTrack,
  s: PhysicsState,
  hazards: WorldHazards
): { forced: boolean; next: PhysicsState } {
  const stalled = progress.nowT - progress.lastAdvanceT > WEDGE_TIMEOUT

  if (!stalled) {
    return { forced: false, next: s }
  }

  // Find the far edge of the nearest hazard ahead (or overlapping)
  const far = nearestHazardFarEdge(s.x, hazards)
  const newX = far !== null ? far + 0.1 : s.x + 8

  const next: PhysicsState = {
    ...s,
    x: newX,
    y: 1.8,  // GROUND_Y
    vy: 0,
    onGround: true,
  }

  return { forced: true, next }
}

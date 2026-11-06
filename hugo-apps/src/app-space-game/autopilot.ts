// Attract-mode driver: runs right and times jumps from the hazard geometry and the
// current speed so Kasimir clears every crate, spike and pit. Pure and deterministic.

import { GRAV, JUMP, BODY_HW } from './constants'
import type { PhysicsState, PhysicsInput } from './physics'
import type { WorldHazards } from './layout'

const WEDGE_TIMEOUT = 3
const RISE_T = JUMP / Math.abs(GRAV)

export interface ProgressTrack {
  lastX: number
  lastAdvanceT: number
  nowT: number
}

interface Ahead { x0: number; x1: number }

/** Nearest hazard whose far edge is still ahead of Kasimir's centre. */
function nextHazard(x: number, h: WorldHazards): Ahead | null {
  let best: Ahead | null = null
  const consider = (x0: number, x1: number) => {
    if (x1 <= x) return
    if (!best || x0 < best.x0) best = { x0, x1 }
  }
  for (const c of h.crates) consider(c.x0, c.x1)
  for (const s of h.spikes) consider(s.x0, s.x1)
  for (const p of h.pits) consider(p.x0, p.x1)
  return best
}

/**
 * Jump so the apex lands over the hazard's middle. Holds the button while rising
 * (full-height jump), releases on the way down so the next press registers.
 */
export function autopilotInput(s: PhysicsState, h: WorldHazards): PhysicsInput {
  const holding = !s.onGround && s.vy > 0
  const hz = nextHazard(s.x, h)
  if (!hz || !s.onGround) return { moveDir: 1, jump: holding }
  const front = s.x + BODY_HW
  const d = hz.x0 - front
  const speed = Math.max(Math.abs(s.vx), 3)
  const halfW = (hz.x1 - hz.x0) / 2
  const launchAt = Math.min(2.6, Math.max(0.25, speed * RISE_T - (halfW + BODY_HW)))
  const launch = d <= launchAt
  return { moveDir: 1, jump: launch || holding }
}

/** Furthest-right x Kasimir has safely reached is tracked by the caller; this frees a wedge. */
export function watchdog(
  progress: ProgressTrack,
  s: PhysicsState,
  h: WorldHazards,
): { forced: boolean; next: PhysicsState } {
  if (progress.nowT - progress.lastAdvanceT <= WEDGE_TIMEOUT) return { forced: false, next: s }
  const hz = nextHazard(s.x, h)
  const x = hz ? hz.x1 + 1.5 : s.x + 6
  return {
    forced: true,
    next: { ...s, x: Math.min(x, h.maxX - 1), y: 0, vx: 0, vy: 0, onGround: true, lastSafeX: Math.min(x, h.maxX - 1) },
  }
}

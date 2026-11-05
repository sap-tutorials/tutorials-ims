// World units: ground top is y = 0 and physics y is Kasimir's FEET.

export const SPEED = 7          // max horizontal speed (units/s)
export const ACCEL = 38         // ground acceleration toward target speed
export const DECEL = 46         // ground deceleration when no input
export const TURN_ACCEL = 60    // ground acceleration when reversing direction
export const AIR_ACCEL = 26     // air control
export const GRAV = -34         // gravity (units/s²)
export const JUMP = 13.5        // jump launch speed (units/s)
export const JUMP_CUT_GRAV = 2.4 // gravity multiplier while rising with jump released (variable jump)
export const FALL_GRAV = 1.25   // gravity multiplier while falling (snappier arcs)
export const MAX_FALL = -28
export const COYOTE_S = 0.1     // can still jump this long after walking off a ledge
export const JUMP_BUFFER_S = 0.12 // a jump pressed this long before landing still fires
export const INVULN_S = 1.4     // invulnerability after a spike hit
export const FALL_LIMIT_Y = -5  // below this (inside a pit) Kasimir has fallen

export const BODY_HW = 0.45     // collision half-width
export const BODY_H = 2.1       // collision height
export const KASIMIR_H = 2.5    // rendered character height (feet → ear tips)

export const FIXED_DT = 1 / 120 // physics step

const RISE_T = JUMP / Math.abs(GRAV)
const MAX_H = (JUMP * JUMP) / (2 * Math.abs(GRAV))
const FALL_T = Math.sqrt((2 * MAX_H) / (Math.abs(GRAV) * FALL_GRAV))

// Full-height jump with the button held, at full run speed.
export const JUMP_ARC = {
  airtime: RISE_T + FALL_T,
  maxHeight: MAX_H,
  maxGap: SPEED * (RISE_T + FALL_T),
}

// Hazards are tuned well inside the arc so ordinary, non-frame-perfect jumps clear them.
export const HAZARD_LIMITS = {
  crateMaxH: MAX_H * 0.55,
  crateMinH: 0.9,
  crateW: 1.3,
  pitMaxW: SPEED * (RISE_T + FALL_T) * 0.5,
  pitMinW: 1.8,
  spikeH: 0.55,
  spikeMinW: 1.2,
  spikeMaxW: 1.8,
}

export const SPEED = 6      // world units/sec horizontal
export const GRAV = -24     // world units/sec^2
export const JUMP = 10      // initial jump velocity (world units/sec)
// Derived: a jump launched at JUMP under GRAV returns to launch height after
// t = 2*JUMP/|GRAV| seconds, during which horizontal travel = SPEED * t.
// maxHeight = JUMP^2 / (2*|GRAV|).
export const JUMP_ARC = {
  airtime: (2 * JUMP) / Math.abs(GRAV),         // seconds
  maxGap: SPEED * ((2 * JUMP) / Math.abs(GRAV)), // world units clearable horizontally
  maxHeight: (JUMP * JUMP) / (2 * Math.abs(GRAV)),
}

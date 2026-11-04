import { describe, it, expect } from 'vitest'
import { selectClip, frameAt } from '../anim'
import type { AnimContext } from '../anim'

// Minimal clip map for frameAt tests (loop + non-loop)
const testClips = {
  idle: { frames: [0, 1, 2, 3, 4].map(() => ({})), fps: 8, loop: true },
  walk: { frames: [0, 1, 2].map(() => ({})), fps: 12, loop: true },
  run: { frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => ({})), fps: 16, loop: true },
  jump: { frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(() => ({})), fps: 12, loop: false },
  hit: { frames: [{}], fps: 10, loop: false },
  ko: { frames: [{}], fps: 8, loop: false },
  celebrate: { frames: [{}], fps: 10, loop: false },
  taunt: { frames: [{}], fps: 10, loop: false },
  chest: { frames: [{}], fps: 8, loop: false },
} as Parameters<typeof frameAt>[2]

describe('selectClip', () => {
  // Test 1: Airborne → 'jump'
  it('returns jump when airborne (onGround:false, vy non-zero, no event)', () => {
    const ctx: AnimContext = { onGround: false, moveDir: 0, vy: -5, lastEvent: 'none', sinceEventMs: 0 }
    expect(selectClip(ctx)).toBe('jump')
  })

  // Test 2: fell event overrides even if airborne
  it('returns ko when lastEvent:fell and sinceEventMs < 800 (overrides locomotion)', () => {
    const ctx: AnimContext = { onGround: false, moveDir: 0, vy: -5, lastEvent: 'fell', sinceEventMs: 200 }
    expect(selectClip(ctx)).toBe('ko')
  })

  // Test 3: fell event expired → falls through to locomotion
  it('does NOT return ko when lastEvent:fell but sinceEventMs >= 800', () => {
    const ctx: AnimContext = { onGround: false, moveDir: 0, vy: -5, lastEvent: 'fell', sinceEventMs: 2000 }
    expect(selectClip(ctx)).not.toBe('ko')
  })

  // Test 4: hit event within window
  it('returns hit when lastEvent:hit and sinceEventMs < 600', () => {
    const ctx: AnimContext = { onGround: true, moveDir: 0, vy: 0, lastEvent: 'hit', sinceEventMs: 300 }
    expect(selectClip(ctx)).toBe('hit')
  })

  // Test 5: pickup event → celebrate
  it('returns celebrate when lastEvent:pickup and sinceEventMs < 400', () => {
    const ctx: AnimContext = { onGround: true, moveDir: 0, vy: 0, lastEvent: 'pickup', sinceEventMs: 200 }
    expect(selectClip(ctx)).toBe('celebrate')
  })

  // Test 6: goal event → celebrate
  it('returns celebrate when lastEvent:goal and sinceEventMs < 800', () => {
    const ctx: AnimContext = { onGround: true, moveDir: 0, vy: 0, lastEvent: 'goal', sinceEventMs: 600 }
    expect(selectClip(ctx)).toBe('celebrate')
  })

  // Test 7: grounded + moving → 'run'
  it('returns run when grounded and moving (moveDir:1, vy:0)', () => {
    const ctx: AnimContext = { onGround: true, moveDir: 1, vy: 0, lastEvent: 'none', sinceEventMs: 0 }
    expect(selectClip(ctx)).toBe('run')
  })

  // Test 8: grounded + still → 'idle'
  it('returns idle when grounded and still (moveDir:0, vy:0)', () => {
    const ctx: AnimContext = { onGround: true, moveDir: 0, vy: 0, lastEvent: 'none', sinceEventMs: 0 }
    expect(selectClip(ctx)).toBe('idle')
  })
})

describe('frameAt', () => {
  // Test 9: loop clip at elapsedMs=1000, fps=8, frames.length=5
  // Math.floor(1000 / (1000/8)) % 5 = Math.floor(8) % 5 = 8 % 5 = 3
  it('returns correct frame index for a loop clip (elapsedMs=1000, fps=8, 5 frames → 3)', () => {
    expect(frameAt('idle', 1000, testClips)).toBe(3)
  })

  // Test 10: non-loop clip past end clamps to frames.length - 1
  it('clamps to last frame index for a non-loop clip past the end', () => {
    // jump clip has 12 frames, fps=12, non-loop
    // at elapsedMs=10000, floor(10000/83.33) = 120 which is well past 11 (frames.length-1)
    const lastIdx = testClips.jump.frames.length - 1
    expect(frameAt('jump', 10000, testClips)).toBe(lastIdx)
  })
})

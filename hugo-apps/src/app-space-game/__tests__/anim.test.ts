import { describe, it, expect } from 'vitest'
import { selectClip, frameAt, jumpFrame, playbackRate } from '../anim'
import type { AnimContext } from '../anim'
import { JUMP, SPEED } from '../constants'

const ctx = (p: Partial<AnimContext> = {}): AnimContext => ({
  onGround: true, vx: 0, vy: 0, lastEvent: 'none', sinceEventMs: 10_000, pose: null, ...p,
})

describe('selectClip', () => {
  it('idle → walk → trot → run as speed rises', () => {
    expect(selectClip(ctx({ vx: 0 }))).toBe('idle')
    expect(selectClip(ctx({ vx: SPEED * 0.3 }))).toBe('walk')
    expect(selectClip(ctx({ vx: -SPEED * 0.6 }))).toBe('trot')
    expect(selectClip(ctx({ vx: SPEED }))).toBe('run')
  })

  it('airborne → jump', () => {
    expect(selectClip(ctx({ onGround: false, vy: 3, vx: SPEED }))).toBe('jump')
  })

  it('holds the landing crouch briefly after touching down', () => {
    expect(selectClip(ctx({ vx: SPEED, lastEvent: 'land', sinceEventMs: 40 }))).toBe('jump')
    expect(selectClip(ctx({ vx: SPEED, lastEvent: 'land', sinceEventMs: 200 }))).toBe('run')
  })

  it('fell → fall pose; hit → dizzy on ground, flail in the air', () => {
    expect(selectClip(ctx({ lastEvent: 'fell', onGround: false }))).toBe('fall')
    expect(selectClip(ctx({ lastEvent: 'hit', sinceEventMs: 100, onGround: true }))).toBe('hit')
    expect(selectClip(ctx({ lastEvent: 'hit', sinceEventMs: 100, onGround: false }))).toBe('fall')
    expect(selectClip(ctx({ lastEvent: 'hit', sinceEventMs: 900, vx: SPEED }))).toBe('run')
  })

  it('a scripted pose overrides everything', () => {
    expect(selectClip(ctx({ pose: 'reach', lastEvent: 'hit', sinceEventMs: 0 }))).toBe('reach')
    expect(selectClip(ctx({ pose: 'celebrate', onGround: false }))).toBe('celebrate')
  })
})

describe('jumpFrame', () => {
  it('follows the arc: rise → apex → descend, crouch on the ground', () => {
    const f = (vy: number, extra: Partial<AnimContext> = {}) => jumpFrame(ctx({ onGround: false, vy, ...extra }), 10)
    expect(f(JUMP)).toBe(2)
    expect(f(0)).toBe(5)
    expect(f(-JUMP)).toBe(7)
    expect(f(JUMP, { lastEvent: 'jump', sinceEventMs: 10 })).toBe(1)
    expect(jumpFrame(ctx({ onGround: true }), 10)).toBe(8)
    const seq = [JUMP, JUMP * 0.5, JUMP * 0.2, 0, -JUMP * 0.4, -JUMP].map(v => f(v))
    expect([...seq].sort((a, b) => a - b)).toEqual(seq)
  })

  it('never exceeds the clip length', () => {
    expect(jumpFrame(ctx({ onGround: true }), 3)).toBe(2)
  })
})

describe('frameAt', () => {
  const clips = {
    idle: { frames: [1, 2, 3, 4], fps: 4, loop: true },
    taunt: { frames: [1, 2, 3], fps: 10, loop: false },
  }
  it('loops looping clips', () => {
    expect(frameAt('idle', 0, clips)).toBe(0)
    expect(frameAt('idle', 1250, clips)).toBe(1)
  })
  it('clamps one-shot clips on the last frame', () => {
    expect(frameAt('taunt', 5000, clips)).toBe(2)
  })
  it('returns 0 for unknown clips', () => {
    expect(frameAt('run', 500, clips)).toBe(0)
  })
})

describe('playbackRate', () => {
  it('scales locomotion with speed, clamped', () => {
    expect(playbackRate('run', SPEED)).toBeCloseTo(1)
    expect(playbackRate('run', 0.1)).toBe(0.6)
    expect(playbackRate('idle', 0)).toBe(1)
  })
})

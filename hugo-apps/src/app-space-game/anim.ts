// Pure animation state machine for the Kasimir sprite. No DOM, no Three.js.

import { JUMP, SPEED } from './constants'

export type ClipName =
  | 'idle' | 'walk' | 'trot' | 'run' | 'jump'
  | 'hit' | 'fall' | 'ko' | 'reach' | 'chest' | 'celebrate' | 'taunt'

export type AnimEvent = 'none' | 'hit' | 'fell' | 'land' | 'jump' | 'respawn'

export interface AnimContext {
  onGround: boolean
  vx: number
  vy: number
  lastEvent: AnimEvent
  sinceEventMs: number
  /** Scripted pose (standing at a goal, celebrating) — overrides locomotion. */
  pose?: 'reach' | 'chest' | 'celebrate' | 'taunt' | null
}

/** Strict priority: scripted pose > fall > hit > airborne > ground locomotion by speed. */
export function selectClip(ctx: AnimContext): ClipName {
  const { onGround, vx, lastEvent, sinceEventMs } = ctx
  if (ctx.pose) return ctx.pose
  if (lastEvent === 'fell') return 'fall'
  if (lastEvent === 'respawn' && sinceEventMs < 700) return 'hit'
  if (lastEvent === 'hit' && sinceEventMs < 700) return onGround ? 'hit' : 'fall'
  if (!onGround) return 'jump'
  if (lastEvent === 'land' && sinceEventMs < 90) return 'jump'
  const speed = Math.abs(vx)
  if (speed < 0.35) return 'idle'
  if (speed < SPEED * 0.45) return 'walk'
  if (speed < SPEED * 0.8) return 'trot'
  return 'run'
}

/**
 * Jump frames are chosen by the arc, not by time, so the pose always matches the motion.
 * Sheet order: 0 crouch · 1 push-off · 2–4 rise · 5 apex stretch · 6–7 descend · 8 land · 9 stand.
 */
export function jumpFrame(ctx: AnimContext, frameCount: number): number {
  const last = frameCount - 1
  if (ctx.onGround) return Math.min(8, last)
  if (ctx.lastEvent === 'jump' && ctx.sinceEventMs < 60) return Math.min(1, last)
  const v = ctx.vy / JUMP
  let f: number
  if (v > 0.7) f = 2
  else if (v > 0.4) f = 3
  else if (v > 0.12) f = 4
  else if (v > -0.2) f = 5
  else if (v > -0.6) f = 6
  else f = 7
  return Math.min(f, last)
}

/** Frame index within a time-driven clip. Loops wrap; one-shots hold the last frame. */
export function frameAt(
  clipName: ClipName,
  elapsedMs: number,
  clips: Partial<Record<ClipName, { frames: unknown[]; fps: number; loop: boolean }>>,
): number {
  const clip = clips[clipName]
  if (!clip || clip.frames.length === 0) return 0
  const raw = Math.floor((elapsedMs * clip.fps) / 1000)
  return clip.loop ? raw % clip.frames.length : Math.min(raw, clip.frames.length - 1)
}

/** Locomotion clips play faster the faster Kasimir moves, so feet don't skate. */
export function playbackRate(clip: ClipName, vx: number): number {
  const ref: Partial<Record<ClipName, number>> = { walk: SPEED * 0.3, trot: SPEED * 0.62, run: SPEED }
  const r = ref[clip]
  if (!r) return 1
  return Math.min(1.4, Math.max(0.6, Math.abs(vx) / r))
}

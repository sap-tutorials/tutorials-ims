// Pure animation state machine for Kasimir sprite.
// No DOM, no Three.js, no canvas — only clip-selection and frame-index math.
// The renderer owns all UV updates.

export type ClipName = 'idle' | 'walk' | 'run' | 'jump' | 'hit' | 'ko' | 'celebrate' | 'taunt' | 'chest'

export interface AnimContext {
  onGround: boolean
  moveDir: -1 | 0 | 1       // from autopilot or player input
  vy: number
  lastEvent: 'none' | 'hit' | 'fell' | 'goal' | 'pickup'
  sinceEventMs: number       // ms since lastEvent fired
}

/**
 * Select the appropriate clip name from the current animation context.
 * Priority is strict highest-first; event overrides (ko/hit/celebrate) beat
 * locomotion/jump even when airborne.
 */
export function selectClip(ctx: AnimContext): ClipName {
  const { onGround, moveDir, vy, lastEvent, sinceEventMs } = ctx

  // Priority 1: fell event — KO override
  if (lastEvent === 'fell' && sinceEventMs < 800) {
    return 'ko'
  }

  // Priority 2: hit event
  if (lastEvent === 'hit' && sinceEventMs < 600) {
    return 'hit'
  }

  // Priority 3: goal event → celebrate
  if (lastEvent === 'goal' && sinceEventMs < 800) {
    return 'celebrate'
  }

  // Priority 4: pickup event → celebrate
  if (lastEvent === 'pickup' && sinceEventMs < 400) {
    return 'celebrate'
  }

  // Priority 5: airborne
  if (!onGround) {
    return 'jump'
  }

  // Priority 6: moving on ground (no walk/run distinction in v1 — always run; YAGNI)
  if (moveDir !== 0 && vy === 0 && onGround) {
    return 'run'
  }

  // Default
  return 'idle'
}

/**
 * Returns the 0-based frame index within a clip for the given elapsed time.
 * - Loop clips wrap around.
 * - Non-loop clips clamp to the last frame.
 */
export function frameAt(
  clipName: ClipName,
  elapsedMs: number,
  clips: Record<ClipName, { frames: unknown[]; fps: number; loop: boolean }>
): number {
  const clip = clips[clipName]
  const frameCount = clip.frames.length
  const msPerFrame = 1000 / clip.fps
  const rawIndex = Math.floor(elapsedMs / msPerFrame)

  if (clip.loop) {
    return rawIndex % frameCount
  } else {
    return Math.min(rawIndex, frameCount - 1)
  }
}

// WebAudio pickup sound for app-space-game.
// Starts DISABLED. blip() is a no-op until first user gesture AND enabled.
// Guards window.AudioContext (and webkitAudioContext). NEVER throws.

/** The return type of createSound. */
export interface SoundHandle {
  /** Whether audio is currently enabled. */
  enabled: boolean
  /** Toggle enabled state. */
  toggle(): void
  /** Play a short blip sound. No-op if disabled or no AudioContext. */
  blip(): void
}

export function createSound(): SoundHandle {
  let enabled = false
  let gestureReceived = false
  let ctx: AudioContext | null = null

  function getCtx(): AudioContext | null {
    if (ctx) return ctx
    try {
      // Guard both AudioContext and webkitAudioContext
      const Ctor =
        (typeof window !== 'undefined' &&
          ((window as Record<string, unknown>).AudioContext as typeof AudioContext | undefined)) ||
        (typeof window !== 'undefined' &&
          ((window as Record<string, unknown>).webkitAudioContext as typeof AudioContext | undefined)) ||
        null
      if (!Ctor) return null
      ctx = new Ctor()
      return ctx
    } catch {
      return null
    }
  }

  // Mark first user gesture — required before AudioContext can produce sound
  function onFirstGesture(): void {
    gestureReceived = true
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', onFirstGesture)
      window.removeEventListener('keydown', onFirstGesture)
      window.removeEventListener('touchstart', onFirstGesture)
    }
    // Resume context if it was suspended (browser policy)
    try {
      const c = getCtx()
      if (c && c.state === 'suspended') {
        c.resume().catch(() => { /* silent */ })
      }
    } catch {
      // silent
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true })
    window.addEventListener('keydown', onFirstGesture, { once: true, passive: true })
    window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true })
  }

  return {
    get enabled() {
      return enabled
    },
    toggle() {
      enabled = !enabled
    },
    blip() {
      // No-op unless enabled AND a user gesture has occurred
      if (!enabled || !gestureReceived) return
      try {
        const c = getCtx()
        if (!c) return
        if (c.state === 'suspended') return
        // Short sine blip: ~50ms, 880Hz → 440Hz
        const osc = c.createOscillator()
        const gain = c.createGain()
        osc.connect(gain)
        gain.connect(c.destination)
        osc.type = 'sine'
        osc.frequency.setValueAtTime(880, c.currentTime)
        osc.frequency.exponentialRampToValueAtTime(440, c.currentTime + 0.05)
        gain.gain.setValueAtTime(0.18, c.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.08)
        osc.start(c.currentTime)
        osc.stop(c.currentTime + 0.09)
      } catch {
        // NEVER throw — audio is best-effort
      }
    },
  }
}

// WebAudio pickup sound for app-space-game.
// Starts DISABLED. blip() is a no-op until first user gesture AND enabled.
// Guards window.AudioContext (and webkitAudioContext). NEVER throws.

/** The return type of createSound. */
export interface SoundHandle {
  /** Whether audio is currently enabled. */
  enabled: boolean
  /** Toggle enabled state. */
  toggle(): void
  /** Play a short blip sound (ring pickup). No-op if disabled or no AudioContext. */
  blip(): void
  jump(): void
  hit(): void
  fall(): void
  goal(): void
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
      // Toggling is itself a user gesture.
      gestureReceived = true
    },
    blip() {
      tone([[880, 440]], 0.08, 'sine', 0.18)
    },
    jump() {
      tone([[320, 640]], 0.12, 'square', 0.06)
    },
    hit() {
      tone([[220, 90]], 0.25, 'sawtooth', 0.12)
    },
    fall() {
      tone([[600, 120]], 0.5, 'triangle', 0.14)
    },
    goal() {
      tone([[523, 523], [659, 659], [784, 784], [1047, 1047]], 0.1, 'square', 0.07, 0.09)
    },
  }

  /**
   * Plays a short sequence of sweeps. Each entry is [startHz, endHz].
   * No-op unless enabled AND a user gesture has occurred. NEVER throws.
   */
  function tone(sweeps: Array<[number, number]>, dur: number, type: OscillatorType, vol: number, gap = 0): void {
    if (!enabled || !gestureReceived) return
    try {
      const c = getCtx()
      if (!c || c.state === 'suspended') return
      sweeps.forEach(([f0, f1], i) => {
        const t0 = c.currentTime + i * (gap || dur)
        const osc = c.createOscillator()
        const gain = c.createGain()
        osc.connect(gain)
        gain.connect(c.destination)
        osc.type = type
        osc.frequency.setValueAtTime(f0, t0)
        if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.8)
        gain.gain.setValueAtTime(vol, t0)
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
        osc.start(t0)
        osc.stop(t0 + dur + 0.02)
      })
    } catch {
      // audio is best-effort
    }
  }
}

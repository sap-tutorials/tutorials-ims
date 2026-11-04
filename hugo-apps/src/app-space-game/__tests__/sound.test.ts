// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'

// These tests validate sound.ts behavior:
// 1. starts disabled
// 2. blip() does not throw when AudioContext is undefined
// 3. toggle() flips enabled
// 4. blip() is a no-op (no throw) while disabled

describe('createSound', () => {
  beforeEach(() => {
    // Ensure AudioContext is absent for safe testing
    // happy-dom may expose a stub — delete it so we test the no-AudioContext path
    if ('AudioContext' in window) {
      // @ts-expect-error deleting global
      delete (window as Record<string, unknown>).AudioContext
    }
    if ('webkitAudioContext' in window) {
      // @ts-expect-error deleting global
      delete (window as Record<string, unknown>).webkitAudioContext
    }
  })

  it('createSound().enabled is false (starts disabled)', async () => {
    // Re-import each time so module state is fresh
    const { createSound } = await import('../sound')
    const s = createSound()
    expect(s.enabled).toBe(false)
  })

  it('blip() does not throw when window.AudioContext is undefined', async () => {
    const { createSound } = await import('../sound')
    const s = createSound()
    // AudioContext is absent (deleted in beforeEach); blip must not throw
    expect(() => s.blip()).not.toThrow()
  })

  it('toggle() flips enabled false→true→false', async () => {
    const { createSound } = await import('../sound')
    const s = createSound()
    expect(s.enabled).toBe(false)
    s.toggle()
    expect(s.enabled).toBe(true)
    s.toggle()
    expect(s.enabled).toBe(false)
  })

  it('blip() is a no-op (no throw) while disabled', async () => {
    const { createSound } = await import('../sound')
    const s = createSound()
    // disabled by default; blip must not throw even if somehow AudioContext existed
    expect(() => s.blip()).not.toThrow()
    // ensure still disabled
    expect(s.enabled).toBe(false)
    // blip again still no throw
    expect(() => s.blip()).not.toThrow()
  })
})

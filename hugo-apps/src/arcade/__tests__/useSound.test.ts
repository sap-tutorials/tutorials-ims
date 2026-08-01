import { describe, it, expect, vi } from 'vitest'
import { useSound } from '../useSound'

describe('useSound', () => {
  it('starts muted / not playing (no autoplay)', () => {
    const { enabled } = useSound('/x.mp3')
    expect(enabled.value).toBe(false)
  })
  it('toggle() flips enabled and calls play/pause', () => {
    const play = vi.fn().mockResolvedValue(undefined)
    const pause = vi.fn()
    const audio = { play, pause, loop: false, muted: true } as any
    const { enabled, toggle } = useSound('/x.mp3', () => audio)
    toggle(); expect(enabled.value).toBe(true); expect(play).toHaveBeenCalled()
    toggle(); expect(enabled.value).toBe(false); expect(pause).toHaveBeenCalled()
  })
})

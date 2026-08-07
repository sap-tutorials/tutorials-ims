import { describe, it, expect } from 'vitest'
import { IMGLY_PUBLIC_PATH, STAGE_WIDTH, STAGE_HEIGHT, FRAME_LAYERING } from '../constants'

describe('selfie constants', () => {
  it('exposes a self-hosted imgly path (no CDN)', () => {
    expect(IMGLY_PUBLIC_PATH).toBe('/vendor/imgly/')
    expect(IMGLY_PUBLIC_PATH.startsWith('http')).toBe(false)
  })
  it('defines a square stage', () => {
    expect(STAGE_WIDTH).toBeGreaterThan(0)
    expect(STAGE_HEIGHT).toBe(STAGE_WIDTH)
  })
  it('records the frame layering decision', () => {
    expect(['overlay', 'background']).toContain(FRAME_LAYERING)
  })
})

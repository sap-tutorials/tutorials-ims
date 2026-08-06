// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shareOrDownload } from '../share'

describe('share.shareOrDownload', () => {
  beforeEach(() => {
    ;(globalThis.URL as any).createObjectURL = vi.fn(() => 'blob:x')
    ;(globalThis.URL as any).revokeObjectURL = vi.fn()
  })

  it('shares via navigator.share when files are shareable', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    ;(navigator as any).canShare = vi.fn(() => true)
    ;(navigator as any).share = share
    const out = await shareOrDownload(new Blob(['x'], { type: 'image/png' }))
    expect(out).toBe('shared')
    expect(share).toHaveBeenCalled()
  })

  it('falls back to download when share is unsupported', async () => {
    ;(navigator as any).canShare = undefined
    ;(navigator as any).share = undefined
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const out = await shareOrDownload(new Blob(['x'], { type: 'image/png' }))
    expect(out).toBe('downloaded')
    expect(clickSpy).toHaveBeenCalled()
  })
})

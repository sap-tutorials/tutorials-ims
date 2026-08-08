// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shareOrDownload, xIntentUrl, linkedInIntentUrl, SHARE_TEXT, SHARE_URL, copyImage } from '../share'

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

describe('share intent URLs', () => {
  it('xIntentUrl targets the X/Twitter intent host with encoded text and url', () => {
    const u = xIntentUrl()
    expect(u).toContain('https://twitter.com/intent/tweet?')
    const q = new URLSearchParams(u.split('?')[1])
    expect(q.get('text')).toBe(SHARE_TEXT)
    expect(q.get('url')).toBe(SHARE_URL)
  })

  it('linkedInIntentUrl targets share-offsite with only the url param', () => {
    const u = linkedInIntentUrl()
    expect(u).toContain('https://www.linkedin.com/sharing/share-offsite/?')
    const q = new URLSearchParams(u.split('?')[1])
    expect(q.get('url')).toBe(SHARE_URL)
    expect(q.get('text')).toBeNull()
    expect(q.get('summary')).toBeNull()
  })
})

describe('share.copyImage', () => {
  const png = new Blob(['x'], { type: 'image/png' })
  const setClipboard = (v: any) => Object.defineProperty(navigator, 'clipboard', { value: v, configurable: true })

  it('returns "copied" and calls clipboard.write when the API is present', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).ClipboardItem = class { constructor(_: any) {} }
    setClipboard({ write })
    expect(await copyImage(png)).toBe('copied')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('returns "unavailable" when ClipboardItem is missing (no throw)', async () => {
    ;(globalThis as any).ClipboardItem = undefined
    setClipboard({ write: vi.fn() })
    expect(await copyImage(png)).toBe('unavailable')
  })

  it('returns "unavailable" when clipboard.write rejects (fail-soft)', async () => {
    ;(globalThis as any).ClipboardItem = class { constructor(_: any) {} }
    setClipboard({ write: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await copyImage(png)).toBe('unavailable')
  })
})

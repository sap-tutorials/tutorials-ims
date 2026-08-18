// test/unit/publish-image-warm.test.js
//
// Unit tests for the publish-time image warm-orchestration utilities.
// No CAP boot, no network — all deps injected or pure.
//
// Run: npx vitest run --project unit test/unit/publish-image-warm.test.js

import { describe, it, expect, vi } from 'vitest'
import {
  channelFor,
  extractImgCdnUrls,
  warmImages,
} from '../../srv/lib/image-warm-utils.js'

// ---------------------------------------------------------------------------
// channelFor
// ---------------------------------------------------------------------------
describe('channelFor', () => {
  it('returns prod for a public repo URL', () => {
    expect(channelFor('https://raw.githubusercontent.com/sap-tutorials/btp-foundation/main/img.png'))
      .toBe('prod')
  })

  it('returns qa for a -Contribution/ URL', () => {
    expect(channelFor('https://raw.githubusercontent.com/sap-tutorials/btp-foundation-Contribution/main/img.png'))
      .toBe('qa')
  })

  it('is case-insensitive on -Contribution/', () => {
    expect(channelFor('https://raw.githubusercontent.com/sap-tutorials/foo-contribution/main/img.png'))
      .toBe('qa')
  })
})

// ---------------------------------------------------------------------------
// extractImgCdnUrls
// ---------------------------------------------------------------------------
describe('extractImgCdnUrls', () => {
  it('extracts and decodes u= params from /img-cdn URLs', () => {
    const img1 = 'https://raw.githubusercontent.com/sap/foo/main/img1.png'
    const img2 = 'https://raw.githubusercontent.com/sap/foo/main/img2.png'
    const html = `<img src="/img-cdn?u=${encodeURIComponent(img1)}&w=800">
      <img src="/img-cdn?u=${encodeURIComponent(img2)}&w=400">`
    const urls = extractImgCdnUrls(html)
    expect(urls).toHaveLength(2)
    expect(urls).toContain(img1)
    expect(urls).toContain(img2)
  })

  it('deduplicates the same URL appearing at different widths', () => {
    const img = 'https://raw.githubusercontent.com/sap/foo/main/img.png'
    const html = `<img src="/img-cdn?u=${encodeURIComponent(img)}&w=800">
      <img src="/img-cdn?u=${encodeURIComponent(img)}&w=400">`
    expect(extractImgCdnUrls(html)).toHaveLength(1)
  })

  it('returns empty array when no /img-cdn URLs are present', () => {
    expect(extractImgCdnUrls('<p>No images here</p>')).toEqual([])
  })

  it('handles u= as a non-first query parameter', () => {
    const img = 'https://raw.githubusercontent.com/sap/foo/main/img.png'
    const html = `<img src="/img-cdn?w=800&u=${encodeURIComponent(img)}">`
    const urls = extractImgCdnUrls(html)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe(img)
  })

  it('handles /content/img-cdn prefix', () => {
    const img = 'https://raw.githubusercontent.com/sap/foo/main/img.png'
    const html = `<img src="/content/img-cdn?u=${encodeURIComponent(img)}&w=800">`
    const urls = extractImgCdnUrls(html)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe(img)
  })
})

// ---------------------------------------------------------------------------
// warmImages — core warm-orchestration (injectable ingestFn)
// ---------------------------------------------------------------------------
describe('warmImages', () => {
  it('calls ingestFn for each URL with correct slug and channel', async () => {
    const prodUrl = 'https://raw.githubusercontent.com/sap/foo/main/img.png'
    const qaUrl = 'https://raw.githubusercontent.com/sap/foo-Contribution/main/img2.png'
    const ingestFn = vi.fn().mockResolvedValue({ action: 'stored' })

    await warmImages([prodUrl, qaUrl], { slug: 'my-tutorial', ingestFn })

    expect(ingestFn).toHaveBeenCalledTimes(2)
    expect(ingestFn).toHaveBeenCalledWith(prodUrl, { slug: 'my-tutorial', channel: 'prod' })
    expect(ingestFn).toHaveBeenCalledWith(qaUrl, { slug: 'my-tutorial', channel: 'qa' })
  })

  it('does not throw when one ingestFn call rejects (network error)', async () => {
    const url1 = 'https://raw.githubusercontent.com/sap/foo/main/img1.png'
    const url2 = 'https://raw.githubusercontent.com/sap/foo/main/img2.png'
    const ingestFn = vi.fn()
      .mockResolvedValueOnce({ action: 'stored' })
      .mockRejectedValueOnce(new Error('network error'))

    await expect(warmImages([url1, url2], { slug: 'test-slug', ingestFn }))
      .resolves.not.toThrow()
    expect(ingestFn).toHaveBeenCalledTimes(2)
  })

  it('does not throw when ingestFn returns failed status (e.g. 429)', async () => {
    const ingestFn = vi.fn().mockResolvedValue({ action: 'failed', status: 429 })
    const urls = ['https://raw.githubusercontent.com/sap/foo/main/img.png']
    await expect(warmImages(urls, { slug: 'test-slug', ingestFn })).resolves.not.toThrow()
  })

  it('continues processing remaining URLs after a failure', async () => {
    const url1 = 'https://raw.githubusercontent.com/sap/foo/main/img1.png'
    const url2 = 'https://raw.githubusercontent.com/sap/foo/main/img2.png'
    const ingestFn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ action: 'stored' })

    await warmImages([url1, url2], { slug: 'test-slug', ingestFn })
    expect(ingestFn).toHaveBeenCalledTimes(2)
    expect(ingestFn).toHaveBeenNthCalledWith(2, url2, { slug: 'test-slug', channel: 'prod' })
  })

  it('resolves immediately with an empty url list', async () => {
    const ingestFn = vi.fn()
    await warmImages([], { slug: 'empty-tutorial', ingestFn })
    expect(ingestFn).not.toHaveBeenCalled()
  })
})

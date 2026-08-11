import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const shouldProcessImage = require('../../approuter/lib/img-cdn-should-process')

// Regression guard for issue #1640: animated GIFs rendered static on production
// because the /img-cdn proxy re-encoded them through sharp (without
// `animated: true`), collapsing them to their first frame — and to a static WebP
// for WebP-capable browsers. Legacy AEM served GIF bytes verbatim, so they
// animated. The fix is to pass all `image/gif` through the proxy unmodified.
describe('shouldProcessImage (/img-cdn re-encode decision)', () => {
  const opts = { hasSharp: true, wantWidth: 1440, acceptsWebp: true }

  it('never processes animated/GIF content — passes GIFs through so animation survives', () => {
    expect(shouldProcessImage('image/gif', opts)).toBe(false)
  })

  it('still processes GIF even when the content-type carries parameters', () => {
    expect(shouldProcessImage('image/gif; charset=binary', opts)).toBe(false)
  })

  it('still processes PNG/JPEG/WebP/AVIF (resize + webp benefits retained)', () => {
    expect(shouldProcessImage('image/png', opts)).toBe(true)
    expect(shouldProcessImage('image/jpeg', opts)).toBe(true)
    expect(shouldProcessImage('image/webp', opts)).toBe(true)
    expect(shouldProcessImage('image/avif', opts)).toBe(true)
  })

  it('does not process when sharp is unavailable', () => {
    expect(shouldProcessImage('image/png', { ...opts, hasSharp: false })).toBe(false)
  })

  it('does not process when there is neither a width request nor a WebP accept', () => {
    expect(
      shouldProcessImage('image/png', { hasSharp: true, wantWidth: 0, acceptsWebp: false })
    ).toBe(false)
  })

  it('processes on a width request alone', () => {
    expect(
      shouldProcessImage('image/png', { hasSharp: true, wantWidth: 960, acceptsWebp: false })
    ).toBe(true)
  })

  it('processes on a WebP accept alone', () => {
    expect(
      shouldProcessImage('image/jpeg', { hasSharp: true, wantWidth: 0, acceptsWebp: true })
    ).toBe(true)
  })

  it('ignores non-image content types', () => {
    expect(shouldProcessImage('application/octet-stream', opts)).toBe(false)
    expect(shouldProcessImage('text/html', opts)).toBe(false)
  })
})

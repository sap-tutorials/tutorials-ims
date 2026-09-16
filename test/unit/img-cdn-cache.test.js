import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ImgCache, IMG_CDN_CACHE_CONTROL } = require('../../approuter/lib/img-cdn-cache')

// Guards the in-process image cache added to fix the mobile /img-cdn 429s:
// cold responsive-srcset width variants were re-fetched from GitHub per viewer
// and tripped its rate limiter. The cache must be bounded (bytes + TTL) and
// evict LRU so the memory-constrained approuter never OOMs.
describe('ImgCache', () => {
  const val = (tag) => ({ contentType: 'image/webp', buffer: Buffer.alloc(0), xImgCdn: tag })

  it('stores and returns a value by key', () => {
    const c = new ImgCache()
    c.set('a', val('a'), 100)
    expect(c.get('a').xImgCdn).toBe('a')
    expect(c.get('missing')).toBe(null)
  })

  it('tracks total bytes and evicts LRU when over the byte cap', () => {
    const c = new ImgCache({ maxBytes: 250 })
    c.set('a', val('a'), 100)
    c.set('b', val('b'), 100)
    expect(c.bytes).toBe(200)
    c.set('cc', val('cc'), 100) // 300 > 250 → evict oldest ('a')
    expect(c.get('a')).toBe(null)
    expect(c.get('b').xImgCdn).toBe('b')
    expect(c.get('cc').xImgCdn).toBe('cc')
    expect(c.bytes).toBe(200)
  })

  it('a read bumps recency so the just-read entry is not the next victim', () => {
    const c = new ImgCache({ maxBytes: 250 })
    c.set('a', val('a'), 100)
    c.set('b', val('b'), 100)
    expect(c.get('a').xImgCdn).toBe('a') // bump 'a' → 'b' is now LRU
    c.set('cc', val('cc'), 100) // evict LRU ('b')
    expect(c.get('b')).toBe(null)
    expect(c.get('a').xImgCdn).toBe('a')
  })

  it('expires entries past the TTL (injectable clock)', () => {
    let t = 1000
    const c = new ImgCache({ ttlMs: 500, now: () => t })
    c.set('a', val('a'), 100)
    t = 1400
    expect(c.get('a').xImgCdn).toBe('a') // 400ms < 500ms TTL
    t = 1600
    expect(c.get('a')).toBe(null) // 600ms > 500ms TTL → evicted
    expect(c.bytes).toBe(0)
  })

  it('never caches a single item larger than the whole budget', () => {
    const c = new ImgCache({ maxBytes: 100 })
    c.set('big', val('big'), 200)
    expect(c.get('big')).toBe(null)
    expect(c.bytes).toBe(0)
  })

  it('ignores non-positive sizes', () => {
    const c = new ImgCache()
    c.set('a', val('a'), 0)
    expect(c.get('a')).toBe(null)
  })

  it('overwriting a key does not double-count bytes', () => {
    const c = new ImgCache()
    c.set('a', val('a1'), 100)
    c.set('a', val('a2'), 150)
    expect(c.bytes).toBe(150)
    expect(c.get('a').xImgCdn).toBe('a2')
    expect(c.size).toBe(1)
  })

  // #2346 — default TTL must be 1h (not 6h) so the in-process cache is never
  // the longest-lived stale layer after the immutable/s-maxage=604800 fix.
  it('default TTL is 1 hour', () => {
    let t = 0
    const c = new ImgCache({ now: () => t })
    c.set('a', val('a'), 100)
    t = 60 * 60 * 1000 - 1          // 1ms before expiry → still fresh
    expect(c.get('a')).not.toBe(null)
    t = 60 * 60 * 1000 + 1          // 1ms after expiry → evicted
    expect(c.get('a')).toBe(null)
  })
})

// #2346 — IMG_CDN_CACHE_CONTROL must not contain `immutable` (a lie on a
// stable, non-content-hashed URL) and must express bounded, revalidating TTLs.
describe('IMG_CDN_CACHE_CONTROL', () => {
  it('is a public, bounded, revalidating directive with no immutable', () => {
    expect(IMG_CDN_CACHE_CONTROL).toMatch(/^public/)
    expect(IMG_CDN_CACHE_CONTROL).toMatch(/max-age=300\b/)
    expect(IMG_CDN_CACHE_CONTROL).toMatch(/s-maxage=3600\b/)
    expect(IMG_CDN_CACHE_CONTROL).toMatch(/stale-while-revalidate/)
    expect(IMG_CDN_CACHE_CONTROL).not.toMatch(/immutable/)
  })
})

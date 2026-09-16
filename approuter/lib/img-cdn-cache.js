'use strict'

/**
 * Bounded, in-process LRU for **processed** /img-cdn images (final bytes +
 * Content-Type), capped by total bytes and per-entry TTL.
 *
 * Why this exists: tutorial pages carry ~16 screenshots, and responsive
 * `srcset` makes mobile request a *different* width variant (e.g. w=960) than
 * desktop (w=1440). Those mobile-width variants are colder at the CDN, so each
 * cold viewer fell through to a live `raw.githubusercontent.com` fetch — and
 * under the approuter's shared CF egress IP that tripped GitHub's rate limiter
 * (HTTP 429), which the proxy relayed as a broken image. Caching the processed
 * bytes here means GitHub is hit at most once per (url,width,accepts-webp)
 * variant per instance until eviction, not once per cold viewer.
 *
 * The approuter is memory-constrained, so the cache is hard-capped by bytes and
 * evicts least-recently-used entries. It NEVER caches errors — only 200s.
 *
 * `now` is injectable for deterministic tests.
 */

// Cache-Control header for /img-cdn 200 responses.
//
// Images are referenced by branch-pinned raw.githubusercontent.com URLs
// rewritten to stable /img-cdn?u=…&w=… URLs — the URL never changes when an
// author edits a screenshot in place (same filename). Serving `immutable` on a
// stable, non-content-hashed URL is a lie: browsers never revalidate for 24h
// and the CDN never revalidates for 7 days even after the store is corrected
// (#2346). Per the "never raise the staleness ceiling without a purge"
// principle in srv/lib/edge-cache-headers.js, TTLs are kept short:
//   - max-age=300 (5 min browser): author sees their edit in minutes.
//   - s-maxage=3600 (1 h edge): worst-case edge staleness with no active purge.
//   - stale-while-revalidate=86400: serve stale instantly, revalidate async —
//     no user-facing latency penalty from dropping immutable.
// When image-purge-by-tag lands (EDGE_PURGE_ENABLED pattern), s-maxage can be
// raised; until then this ceiling is the only staleness bound.
const IMG_CDN_CACHE_CONTROL =
  'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'

class ImgCache {
  constructor({ maxBytes = 64 * 1024 * 1024, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
    this.maxBytes = maxBytes
    this.ttlMs = ttlMs
    this._now = now
    // Map preserves insertion order — we treat the first key as the LRU victim
    // and re-insert on read to bump recency.
    this.map = new Map()
    this.bytes = 0
  }

  get(key) {
    const e = this.map.get(key)
    if (!e) return null
    if (this._now() - e.at > this.ttlMs) {
      this._del(key, e)
      return null
    }
    // LRU bump: delete + re-set moves the entry to the most-recent position.
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key, value, size) {
    if (!(size > 0)) return
    // A single item larger than the whole budget is never cached (it would
    // immediately evict everything and still not fit reliably).
    if (size > this.maxBytes) return
    const existing = this.map.get(key)
    if (existing) this._del(key, existing)
    while (this.bytes + size > this.maxBytes && this.map.size) {
      const oldestKey = this.map.keys().next().value
      this._del(oldestKey, this.map.get(oldestKey))
    }
    this.map.set(key, { value, size, at: this._now() })
    this.bytes += size
  }

  _del(key, e) {
    if (this.map.delete(key)) this.bytes -= e.size
  }

  get size() {
    return this.map.size
  }
}

module.exports = { ImgCache, IMG_CDN_CACHE_CONTROL }

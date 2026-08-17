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
class ImgCache {
  constructor({ maxBytes = 64 * 1024 * 1024, ttlMs = 6 * 60 * 60 * 1000, now = Date.now } = {}) {
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

module.exports = { ImgCache }

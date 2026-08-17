import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isRetryableStatus, backoffMs, parseRetryAfterMs } = require('../../srv/lib/img-cdn-retry.cjs')

// Guards the retry policy added to fix mobile /img-cdn 429s: bursts of tutorial
// screenshot fetches from the shared CF egress IP trip GitHub's rate limiter,
// so a short jittered backoff rides out transient 429/5xx instead of relaying a
// broken image on the first failure.
describe('img-cdn retry policy', () => {
  describe('isRetryableStatus', () => {
    it('retries 429 and 5xx', () => {
      expect(isRetryableStatus(429)).toBe(true)
      expect(isRetryableStatus(500)).toBe(true)
      expect(isRetryableStatus(503)).toBe(true)
      expect(isRetryableStatus(599)).toBe(true)
    })
    it('does not retry terminal 2xx/4xx (incl. 404 private-repo signal)', () => {
      expect(isRetryableStatus(200)).toBe(false)
      expect(isRetryableStatus(401)).toBe(false)
      expect(isRetryableStatus(403)).toBe(false)
      expect(isRetryableStatus(404)).toBe(false)
    })
  })

  describe('backoffMs (equal-jitter exponential)', () => {
    it('never hot-loops: at least half the exponential window', () => {
      // attempt 0: window = min(2000, 200*1) = 200 → floor >= 100
      expect(backoffMs(0, { rand: () => 0 })).toBe(100)
      // attempt 1: window = 400 → >= 200
      expect(backoffMs(1, { rand: () => 0 })).toBe(200)
    })
    it('grows exponentially and is capped', () => {
      // attempt 5: 200*32 = 6400 capped to 2000 → half 1000, rand=1 → ~1999
      const v = backoffMs(5, { rand: () => 0.999 })
      expect(v).toBeGreaterThanOrEqual(1000)
      expect(v).toBeLessThanOrEqual(2000)
    })
    it('honors a Retry-After floor when larger than the jittered delay', () => {
      expect(backoffMs(0, { rand: () => 0, retryAfterMs: 1500 })).toBe(1500)
      // capped at the exponential cap even if Retry-After is huge
      expect(backoffMs(0, { rand: () => 0, retryAfterMs: 999999 })).toBe(2000)
    })
  })

  describe('parseRetryAfterMs', () => {
    it('parses delta-seconds to ms, capped at 300s', () => {
      expect(parseRetryAfterMs('2')).toBe(2000)
      expect(parseRetryAfterMs('600')).toBe(300000)
    })
    it('ignores empty / HTTP-date / garbage forms → 0', () => {
      expect(parseRetryAfterMs('')).toBe(0)
      expect(parseRetryAfterMs(null)).toBe(0)
      expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(0)
      expect(parseRetryAfterMs('soon')).toBe(0)
    })
  })
})

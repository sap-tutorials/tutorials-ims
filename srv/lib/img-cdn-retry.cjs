'use strict'

/**
 * Retry policy helpers for the /img-cdn upstream fetch to
 * raw.githubusercontent.com.
 *
 * The proxy egresses from a shared CF IP, so bursts of screenshot fetches (a
 * tutorial page has ~16) can trip GitHub's rate limiter (HTTP 429). A short
 * retry with jittered backoff rides out those transient limits instead of
 * relaying a broken image on the first failure.
 *
 * Kept pure and side-effect-free so the backoff/parse logic is unit-testable
 * without touching the network or the clock.
 */

// Transient upstream statuses worth retrying: GitHub rate limit (429) and
// any 5xx. 4xx other than 429 (401/403/404) are terminal — retrying won't help.
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

/**
 * Equal-jitter exponential backoff for a 0-based attempt index.
 * Returns a delay in ms of at least half the exponential window (so we never
 * hot-loop) plus random jitter, and never less than a capped Retry-After.
 *
 * @param {number} attempt   0 for the first retry, 1 for the second, ...
 * @param {object} [opts]
 * @param {number} [opts.base=200]        base window in ms
 * @param {number} [opts.cap=2000]        max exponential window in ms
 * @param {number} [opts.retryAfterMs=0]  server-advised delay (already parsed)
 * @param {() => number} [opts.rand=Math.random]  injectable RNG for tests
 */
function backoffMs(attempt, { base = 200, cap = 2000, retryAfterMs = 0, rand = Math.random } = {}) {
  const exp = Math.min(cap, base * 2 ** attempt)
  const half = exp / 2
  const jittered = Math.floor(half + rand() * half)
  return Math.max(jittered, Math.min(retryAfterMs, cap))
}

/**
 * Parse a Retry-After header. Only the delta-seconds form is honored (the
 * HTTP-date form is ignored → 0, since a clock-skew-sensitive absolute date is
 * riskier than falling back to our own jittered backoff). Capped at 300s so a
 * hostile/absurd value can't hang the image request.
 */
function parseRetryAfterMs(headerVal) {
  if (!headerVal) return 0
  const s = String(headerVal).trim()
  if (/^\d+$/.test(s)) return Math.min(parseInt(s, 10), 300) * 1000
  return 0
}

module.exports = { isRetryableStatus, backoffMs, parseRetryAfterMs }

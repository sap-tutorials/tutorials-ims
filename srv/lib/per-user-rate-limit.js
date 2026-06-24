// srv/lib/per-user-rate-limit.js
//
// Per-user sliding-window rate limiter — in-memory Map<key, number[]>.
//
// Same shape as the inline limiters in srv/lib/code-check-handler.js and
// srv/lib/validate-answer-handler.js, factored out for reuse by CAP service
// action handlers (which can't reuse those handlers directly — they're tied
// to express req/res with `Retry-After` header semantics).
//
// Bucket keys should be PREFIXED by caller (e.g. `reset:${sapId}`) so each
// feature's quota is independent.
//
// The bucket store is stashed on `globalThis` so vitest+Windows path
// normalization can't load this module twice and end up with two separate
// Map instances (the same pattern documented in the project memory entry
// "Module Singletons in vitest+CDS"). Production runs on Linux/Cloud
// Foundry where ESM module resolution is path-canonical and this guard is
// a no-op, but it prevents flake on dev workstations.

const BUCKETS_KEY = Symbol.for('com.sap.developers.ims.perUserRateLimit.buckets');
if (!globalThis[BUCKETS_KEY]) {
  globalThis[BUCKETS_KEY] = new Map();
}
const buckets = globalThis[BUCKETS_KEY];

/**
 * Check whether a request keyed by `key` is allowed under a sliding window.
 *
 * - Trims expired timestamps from the window.
 * - If `key` is at or over `limit` requests within `windowMs`, returns false
 *   (no new timestamp recorded — the caller already exceeded their quota).
 * - Otherwise records `now` and returns true.
 *
 * @param {string} key      Bucket key (caller-prefixed, e.g. `reset:sap-u1`).
 * @param {number} limit    Max allowed requests in the window.
 * @param {number} windowMs Sliding-window size in milliseconds.
 * @returns {boolean} true if allowed, false if rate-limited.
 */
export function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = (buckets.get(key) ?? []).filter(t => t > cutoff);
  if (arr.length >= limit) {
    // Persist the trimmed array so memory doesn't grow unbounded for an
    // over-quota user who keeps hammering us.
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

/**
 * Clear all bucket state. Test-only — production code must never call this.
 */
export function _resetForTests() {
  buckets.clear();
}

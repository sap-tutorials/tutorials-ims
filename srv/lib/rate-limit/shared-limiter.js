// srv/lib/rate-limit/shared-limiter.js
//
// Cross-instance fixed-window rate limiter (issue: origin-side abuse
// protection, assuming Akamai Bot Manager removal). Generalizes the
// single-process srv/lib/ip-rate-limit.js: the counter is backed by the
// `cds-caching` plugin (store:"cds" in hybrid/prod = HANA container shared
// across CF instances; memory in base/unit) so limits hold when we scale out.
//
// ── Design ────────────────────────────────────────────────────────────────
//   Counter keyed by (routeClass, tier, clientKey). Value is a
//   {count, windowStart} record. The window is governed by `windowStart`
//   INSIDE the value — NOT by the cache TTL. The TTL is set to 2x the window
//   purely as garbage-collection so idle keys evaporate; a mid-window write
//   therefore does NOT slide the window (which a TTL-as-window design would).
//
//   Fail-open: any caching-store fault (cold connect, store outage) is
//   warned-once-per-minute and degrades to a per-instance in-memory Map —
//   same shape as the old ip-rate-limit.js. If even that path throws we allow
//   the request. A rate limiter must never take down the surface it protects.
//
// ── Known limitation (documented on purpose) ────────────────────────────────
//   cds-caching exposes get/set only — there is NO atomic incr. Concurrent
//   cross-instance updates therefore read-modify-write the same record and can
//   UNDER-count (two racers both read count=5, both write 6). The effective
//   limit is thus LOOSER than configured, never tighter — acceptable for rate
//   limiting (errs toward allowing). Do NOT reuse this counter for anything
//   requiring exactness (quotas, billing, dedup).

import cds from '@sap/cds';

const LOG = cds.log('rate-limit');

// Key prefix inside the shared 'kg' caching namespace (kg-neighborhood-cache
// also lives there) — keeps rate-limit keys from colliding with cache entries
// and gives deleteByTag() a single tag to wipe all of them.
const KEY_PREFIX = 'rl';
const PRUNE_EVERY = 1024; // periodic GC of the in-memory fallback Map

// In-memory fallback + warn-window pinned to globalThis so module-singleton
// multiplicity (Vitest+CDS on Windows loads a file:// dup) shares ONE fallback
// Map across instances — same rationale as the feature-flags STATE cache.
const FALLBACK = (globalThis[Symbol.for('com.sap.developers.ims:rate-limit-fallback')] ??= {
  map: new Map(),
  writes: 0,
  warnedAt: 0,
});

let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/** Test seam: drop the memoized caching connection. */
export function _resetConnectionForTest() {
  _cachePromise = undefined;
}

/** Test seam: clear the in-memory fallback counters + warn-window. */
export function _resetFallbackForTest() {
  FALLBACK.map.clear();
  FALLBACK.writes = 0;
  FALLBACK.warnedAt = 0;
}

// Derive the originating client IP from the leftmost X-Forwarded-For entry
// (BTP Gorouter strips client-supplied XFF before AppRouter sees it, so the
// leftmost is trustworthy as long as ingress is constrained to AppRouter).
// Falls back to req.ip. Identical policy to ip-rate-limit.js.
export function clientIpFrom(req) {
  const xff = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return xff.length ? xff[0] : req.ip || 'unknown';
}

function makeKey({ routeClass, tier, clientKey }) {
  return `${KEY_PREFIX}:${routeClass}:${tier}:${clientKey}`;
}

// Pure fixed-window read-modify-decide over a {count, windowStart} record.
// Returns the (possibly new) record plus the decision. Never mutates its input
// beyond incrementing count on an allow.
function evaluate(rec, { windowMs, max, t }) {
  if (!rec || t - rec.windowStart >= windowMs) rec = { count: 0, windowStart: t };
  if (rec.count >= max) {
    const retryAfterSec = Math.max(1, Math.ceil((rec.windowStart + windowMs - t) / 1000));
    return { rec, allowed: false, retryAfterSec, count: rec.count };
  }
  rec.count += 1;
  return { rec, allowed: true, retryAfterSec: 0, count: rec.count };
}

function fallbackCheck(key, { windowMs, max, t }) {
  const { map } = FALLBACK;
  const res = evaluate(map.get(key), { windowMs, max, t });
  map.set(key, res.rec);
  if (++FALLBACK.writes >= PRUNE_EVERY) {
    FALLBACK.writes = 0;
    for (const [k, v] of map) if (t - v.windowStart >= windowMs) map.delete(k);
  }
  return res;
}

/**
 * Increment-and-check one counter. NEVER throws.
 *
 * @returns {Promise<{allowed:boolean, retryAfterSec:number, count:number, store:'cds'|'memory'}>}
 */
export async function checkRateLimit({ tier, clientKey, routeClass, windowMs, max, now = Date.now }) {
  const t = now();
  const key = makeKey({ routeClass, tier, clientKey });
  try {
    const c = await cache();
    const stored = await c.get(key);
    const res = evaluate(stored ?? null, { windowMs, max, t });
    // Only persist when the record actually changed (an allow, or a window
    // reset). A block within the same window leaves the record untouched, so
    // skipping the write saves a round-trip and can't lose state.
    if (res.allowed) {
      await c.set(key, res.rec, { ttl: windowMs * 2, tags: [{ value: KEY_PREFIX }] });
    }
    return { allowed: res.allowed, retryAfterSec: res.retryAfterSec, count: res.count, store: 'cds' };
  } catch (err) {
    const nowMs = Date.now();
    if (nowMs - FALLBACK.warnedAt > 60_000) {
      FALLBACK.warnedAt = nowMs;
      LOG.warn(`shared store unavailable; per-instance fallback in effect: ${err.message}`);
    }
    const res = fallbackCheck(key, { windowMs, max, t });
    return { allowed: res.allowed, retryAfterSec: res.retryAfterSec, count: res.count, store: 'memory' };
  }
}

// Test seam: exercise the pure window logic without a store.
export function _evaluateForTest(rec, opts) {
  return evaluate(rec, opts);
}

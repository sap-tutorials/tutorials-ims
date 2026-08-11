/**
 * content-cache-coherence.js  (issues #1592, #1621)
 *
 * Cross-instance invalidation for the process-local caches that front
 * DB-served content:
 *   - `ContentCache` in content-store.js — both the `render:<slug>` catalog
 *     (group/mission SSR) entries AND the bare-`<slug>` tutorial HTML entries.
 *   - the navigator response cache in navigator-catalog.js.
 *
 * THE PROBLEM (#1621, #1592)
 * --------------------------
 * These caches are plain in-process state. Their invalidators
 * (`cache.invalidate()` on publish/rollback/commit, `invalidateRenderCache()`
 * and `invalidateNavigatorCache()` on admin writes) run only inside the srv
 * instance that handled the request. With 2+ CF instances the *others* keep
 * serving stale HTML — a publish leaves an unpredictable subset of instances
 * serving old content until LRU eviction or `cf restart` (#1621), and an
 * Admin-UI reorder "didn't propagate" for the same reason (#1592).
 *
 * THE FIX (no pub/sub bus exists; websocket has no Redis adapter)
 * --------------------------------------------------------------
 * Keep the fast local caches for read latency, but publish a shared
 * *generation token* into the already-wired `caching` service. In hybrid/prod
 * that service uses `store: "cds"` — a shared HANA table — so a write from one
 * instance is visible to all. On each content/catalog serve an instance does a
 * TTL-gated (default 5s) read of the token; when it differs from what the
 * instance last saw, every registered local invalidator fires (content-store
 * registers a full `cache.invalidate()`, navigator registers its own clear).
 * Writers call `bumpCacheGeneration()` in addition to their existing immediate
 * local invalidation (which keeps the writing instance correct with zero delay).
 *
 * Cross-instance staleness is bounded by CHECK_TTL_MS (well under the ≤60s
 * admin-to-visitor delay already documented for Alerts). Everything is
 * fail-open: if the caching service is unavailable or throws, serves fall back
 * to today's behaviour (local cache only) — never a 500.
 *
 * In the default/test profile the caching store is `memory` (per-process), so
 * this degrades to a no-op across processes — correct, since unit tests run in
 * a single process anyway.
 */

import cds from '@sap/cds';

export const GEN_KEY = 'content-cache-generation';
export const CHECK_TTL_MS = Number(process.env.CONTENT_CACHE_CHECK_TTL_MS) || 5000;
const log = cds.log('content-cache-coherence');

// Registered local-cache invalidators (ContentCache, navigator cache, …).
const _invalidators = new Set();

let _lastGen;              // last generation token this instance has observed
let _lastCheck = 0;        // Date.now() of the last shared read (TTL gate)
let _inFlight = null;      // coalesce concurrent refreshes into one read
let _seq = 0;              // per-process disambiguator for bump tokens
let _cachePromise = null;  // memoized cds.connect.to('caching')
let _cachingOverride = null; // test seam

async function caching() {
  if (_cachingOverride) return _cachingOverride;
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/**
 * Register a local-cache invalidator, invoked when a *different* instance has
 * bumped the shared generation. Safe to call at module load.
 */
export function onCacheGenerationChange(fn) {
  if (typeof fn === 'function') _invalidators.add(fn);
}

function _fireInvalidators() {
  for (const fn of _invalidators) {
    try { fn(); } catch (err) { log.warn('invalidator threw:', err?.message ?? err); }
  }
}

/**
 * TTL-gated check of the shared generation. If it changed since this instance
 * last observed it, fire all registered local invalidators. Fail-open.
 * Returns a promise that resolves once the (at most one in-flight) check is done.
 */
export async function refreshCacheGeneration() {
  const now = Date.now();
  if (now - _lastCheck < CHECK_TTL_MS) return;
  if (_inFlight) return _inFlight;
  _lastCheck = now;
  _inFlight = (async () => {
    try {
      const c = await caching();
      const gen = await c.get(GEN_KEY);
      if (gen == null) return;            // no generation established yet
      if (gen !== _lastGen) {
        _lastGen = gen;                   // adopt the new generation…
        _fireInvalidators();              // …and drop possibly-stale local caches
      }
    } catch (err) {
      log.warn('generation read failed (fail-open):', err?.message ?? err);
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * Publish a new shared generation token so every *other* instance drops its
 * local caches on its next `refreshCacheGeneration()`. The calling instance
 * adopts the token immediately (so it does not re-invalidate itself) — callers
 * are expected to have already run their immediate local invalidation.
 * Fail-open: a caching outage means peers self-heal on the next write or restart.
 */
export async function bumpCacheGeneration() {
  const token = `${Date.now()}-${process.pid}-${++_seq}`;
  _lastGen = token;
  _lastCheck = Date.now();
  try {
    const c = await caching();
    await c.set(GEN_KEY, token);
  } catch (err) {
    log.warn('generation bump failed (fail-open):', err?.message ?? err);
  }
  return token;
}

// Test seams (mirrors kg-neighborhood-cache.js _resetConnection).
export function _setCachingForTest(fake) { _cachingOverride = fake; _cachePromise = null; }
export function _resetForTest() {
  _cachingOverride = null; _cachePromise = null;
  _lastGen = undefined; _lastCheck = 0; _inFlight = null; _seq = 0;
  _invalidators.clear();
}

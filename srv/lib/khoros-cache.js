// srv/lib/khoros-cache.js
//
// SAP Community (Khoros) user-profile cache, backed by the shared `caching`
// service (cds-caching plugin). ISSUE #1181 — replaces the former hand-rolled
// bounded LRU (module-scoped Map + manual TTL/eviction) so profile lookups get
// tag-based invalidation, metrics, and (in prod) a store shared across CF
// instances for free instead of each instance warming independently.
//
// ── Contract change from the LRU version ─────────────────────────────────
//   get(khorosId)          -> Promise<profile | null>
//   set(khorosId, profile) -> Promise<void>
//   evict(khorosId)        -> Promise<void>
// ...every function is now ASYNC (the caching service connects over the CAP
// runtime). All call sites in developer-service.js already run inside async
// handlers, so they simply `await`.
//
// Cache key: `khoros:<khorosId>` — namespaced with a `khoros:` prefix so this
// source's keys never collide with the other consumers of the shared store
// (`rss:`, `yt:`, `slice:`, `pat:`, kg-neighborhood). Each entry is tagged
// KHOROS_TAG so all profile entries can be busted together if needed.
//
// TTL (6h) is preserved from the LRU version; eviction/MAX_ENTRIES are now
// owned by the caching store, so the former insertion-order-LRU plumbing is
// gone.
//
// Spec: docs/superpowers/specs/2026-06-26-566-khoros-community-link-design.md
// Issue: #566 (original), #1181 (cds-caching migration)

import cds from '@sap/cds';

const TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const KHOROS_TAG = 'khoros-profile';

function khorosKey(khorosId) {
  return `khoros:${khorosId}`;
}

// Memoized connection to the caching service (same pattern as
// kg-neighborhood-cache.js / homepage-rss-fetcher.js, #1177/#1181).
let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/**
 * Look up a cached profile by Khoros user id.
 * Returns null on miss OR expired entry (TTL enforced by the store).
 * Fail-open: any caching-service fault resolves to null (cache miss), so the
 * caller falls through to the live upstream lookup rather than erroring.
 */
export async function get(khorosId) {
  try {
    const v = await (await cache()).get(khorosKey(khorosId));
    return v == null ? null : v;
  } catch (err) {
    cds.log('khoros').warn(`khoros-cache get failed, treating as miss: ${err.message}`);
    return null;
  }
}

/**
 * Store a profile under `khoros:<khorosId>`, tagged KHOROS_TAG, TTL 6h.
 * Fail-open: a store fault is logged and swallowed — a failed write just
 * means the next read misses and re-fetches from upstream.
 */
export async function set(khorosId, profile) {
  try {
    await (await cache()).set(khorosKey(khorosId), profile, {
      ttl: TTL_MS,
      tags: [{ value: KHOROS_TAG }],
    });
  } catch (err) {
    cds.log('khoros').warn(`khoros-cache set failed, entry not cached: ${err.message}`);
  }
}

/**
 * Evict a single profile entry (e.g. when a user re-links to a different
 * Khoros id). Fail-open: a delete fault is logged; the stale entry then
 * expires via TTL.
 */
export async function evict(khorosId) {
  try {
    await (await cache()).delete(khorosKey(khorosId));
  } catch (err) {
    cds.log('khoros').warn(`khoros-cache evict failed, relying on TTL: ${err.message}`);
  }
}

/**
 * Test-only: reset the memoized caching connection and clear the shared store
 * so a test booting a fresh cds runtime doesn't reuse a stale service handle
 * or entries from a previous test. Fail-open — an unconnected store no-ops.
 */
export async function _resetForTests() {
  try {
    // Connect-and-clear unconditionally (cds caches the connection). Gating on
    // `_cachePromise` would leak a prior test's entries when this module hasn't
    // re-connected yet — see homepage-rss-fetcher.js for the failure mode.
    await (await cds.connect.to('caching')).clear();
  } catch { /* store not configured in this test — ignore */ }
  _cachePromise = undefined;
}

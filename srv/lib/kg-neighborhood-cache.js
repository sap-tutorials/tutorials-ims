// srv/lib/kg-neighborhood-cache.js
//
// Response cache for /graph/neighborhood, backed by the `cds-caching`
// plugin (cap-js-community). PROTOTYPE for issue #1177 — replaces the former
// hand-rolled in-process LRU (Map + manual TTL/eviction) with a CAP caching
// service so we get tag-based invalidation, metrics, and (in prod) a shared
// store across CF instances for free.
//
// ── Contract preserved from the LRU version ──────────────────────────────
//   getCachedNeighborhood(slug, graphVersion, bucket?) -> value | undefined
//   setCachedNeighborhood(slug, graphVersion, value, bucket?) -> void
//   bustNeighborhoodCache() -> void   (wipes every bucket + version)
// ...except every function is now ASYNC (the caching service connects over
// the CAP runtime). All call sites already run inside async handlers, so
// they simply `await`.
//
// Cache key: `${bucket}\x1f${slug}\x1f${graphVersion}` — identical shape to
// the old module, so keys stay graphVersion- and bucket-aware. When
// graphVersion changes (nightly rebuild / admin publish) old-version keys are
// unreachable AND graphRebuild() calls bustNeighborhoodCache() to free them.
//
// Invalidation: every entry is tagged NEIGHBORHOOD_TAG. bustNeighborhoodCache()
// is a single deleteByTag() — matching the old global-wipe semantics (a graph
// rebuild invalidates both the 'default' and 'full' buckets together).
//
// TTL and eviction are now owned by the caching service (config in
// package.json under cds.requires.caching), NOT this module — so the former
// MAX_ENTRIES / insertion-order-LRU / fake-timer plumbing is gone.

import cds from '@sap/cds';

const TTL_MS = 5 * 60 * 1000;
const NEIGHBORHOOD_TAG = 'kg-neighborhood';

// Allowed bucket names — unchanged from the LRU version. 'default' = sidebar
// neighborhood handler; 'full' = neighborhoodFull handler. Validation is O(1)
// and cheap to extend when a third response shape lands.
const ALLOWED_BUCKETS = new Set(['default', 'full']);

function assertValidBucket(bucket) {
  if (!ALLOWED_BUCKETS.has(bucket)) {
    throw new Error(
      `kg-neighborhood-cache: unknown bucket ${JSON.stringify(bucket)}; ` +
        `allowed: ${[...ALLOWED_BUCKETS].map((b) => JSON.stringify(b)).join(', ')}`,
    );
  }
}

function makeKey(slug, graphVersion, bucket = 'default') {
  return `${bucket}\x1f${slug}\x1f${graphVersion ?? 'null'}`;
}

// Memoized connection to the caching service. cds.connect.to caches
// internally too, but we keep our own promise so a burst of concurrent
// lookups on a cold module shares one connect round-trip.
let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/**
 * Look up a cached NeighborhoodResult by (slug, graphVersion, bucket).
 * Returns undefined on miss OR expired entry (TTL enforced by the store).
 * Fail-open: any caching-service fault resolves to undefined (cache miss),
 * so the handler falls through to the DB path rather than erroring.
 */
export async function getCachedNeighborhood(slug, graphVersion, bucket = 'default') {
  assertValidBucket(bucket);
  try {
    const c = await cache();
    const v = await c.get(makeKey(slug, graphVersion, bucket));
    // cds-caching returns undefined/null on miss; normalize to undefined.
    return v == null ? undefined : v;
  } catch (err) {
    cds.log('kg-neighborhood-cache').warn(`get failed, treating as miss: ${err.message}`);
    return undefined;
  }
}

/**
 * Store a NeighborhoodResult. Tagged NEIGHBORHOOD_TAG so a single
 * bustNeighborhoodCache() (deleteByTag) wipes every bucket + version.
 * Fail-open: a store fault is logged and swallowed — a failed write just
 * means the next read misses and recomputes.
 */
export async function setCachedNeighborhood(slug, graphVersion, value, bucket = 'default') {
  assertValidBucket(bucket);
  try {
    const c = await cache();
    await c.set(makeKey(slug, graphVersion, bucket), value, {
      ttl: TTL_MS,
      tags: [{ value: NEIGHBORHOOD_TAG }],
    });
  } catch (err) {
    cds.log('kg-neighborhood-cache').warn(`set failed, entry not cached: ${err.message}`);
  }
}

/**
 * Bust every neighborhood entry (all buckets, all versions) via the shared
 * tag. Called by graphRebuild() after a new graphVersion is minted.
 * Fail-open: a bust fault is logged; stale entries then expire via TTL.
 */
export async function bustNeighborhoodCache() {
  try {
    const c = await cache();
    await c.deleteByTag(NEIGHBORHOOD_TAG);
  } catch (err) {
    cds.log('kg-neighborhood-cache').warn(`bust failed, relying on TTL: ${err.message}`);
  }
}

/**
 * Test seam: expose the key builder so tests can assert stability and
 * bucket-sensitivity without reaching into the caching store.
 */
export function _makeKey(slug, graphVersion, bucket = 'default') {
  return makeKey(slug, graphVersion, bucket);
}

/**
 * Test seam: reset the memoized connection so a test that boots a fresh
 * cds runtime doesn't reuse a stale service handle.
 */
export function _resetConnection() {
  _cachePromise = undefined;
}

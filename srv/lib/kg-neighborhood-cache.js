// srv/lib/kg-neighborhood-cache.js
//
// In-process LRU cache for /graph/neighborhood responses.
//
// Cache key: `${bucket}\x1f${slug}\x1f${graphVersion}`. When graphVersion
// changes (nightly rebuild, or admin publish action triggers an ad-hoc
// rebuild), previously cached entries become unreachable via lookup — and
// get evicted naturally as the LRU fills with new-version entries.
//
// The `bucket` parameter (default 'default') isolates responses served by
// different handlers over the same (slug, graphVersion). The
// `/graph/neighborhood` handler uses the 'default' bucket; the future
// `/graph/neighborhoodFull` handler will use 'full'. `bustNeighborhoodCache()`
// remains a global wipe — a graph rebuild invalidates both buckets together.
//
// The cache holds the FULL response body the handler returns, so a hit
// skips ALL remaining DB work (SPARQL, otherResources fan-out, title/publish
// lookups). Second-view latency for a warm entry is ~1ms.
//
// Wired into srv/knowledge-graph-service.js at the two TODO points the
// original author left: line 580 (lookup after SPARQL round-trip) and
// line 972 (store after everything is enriched).

const MAX_ENTRIES = 500;
const TTL_MS = 5 * 60 * 1000;

// Allowed bucket names. Kept as a Set at module scope so validation is O(1)
// and it's cheap to extend when a third response shape gets added.
const ALLOWED_BUCKETS = new Set(['default', 'full']);

function assertValidBucket(bucket) {
  if (!ALLOWED_BUCKETS.has(bucket)) {
    throw new Error(
      `kg-neighborhood-cache: unknown bucket ${JSON.stringify(bucket)}; ` +
        `allowed: ${[...ALLOWED_BUCKETS].map((b) => JSON.stringify(b)).join(', ')}`,
    );
  }
}

// Simple insertion-ordered LRU: Map iteration order is insertion order,
// so `map.keys().next()` gives us the oldest key when we need to evict.
// On every hit we re-insert to move to the tail.
const cache = new Map();

function makeKey(slug, graphVersion, bucket = 'default') {
  return `${bucket}\x1f${slug}\x1f${graphVersion ?? 'null'}`;
}

/**
 * Look up a cached NeighborhoodResult by (slug, graphVersion, bucket).
 * Returns undefined on miss OR on TTL-expired entry.
 * On a hit, moves the entry to the tail (LRU refresh).
 */
export function getCachedNeighborhood(slug, graphVersion, bucket = 'default') {
  assertValidBucket(bucket);
  const key = makeKey(slug, graphVersion, bucket);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt >= TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // LRU refresh: delete + re-insert moves to tail.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

/**
 * Store a NeighborhoodResult in the cache. Evicts the oldest entry if the
 * cache is at capacity.
 */
export function setCachedNeighborhood(slug, graphVersion, value, bucket = 'default') {
  assertValidBucket(bucket);
  const key = makeKey(slug, graphVersion, bucket);
  // If we're at capacity AND this key isn't already present, evict oldest.
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, cachedAt: Date.now() });
}

/**
 * Bust the entire cache. Called by graphRebuild() to free memory promptly
 * after a rebuild mints a new graphVersion (the old entries are already
 * unreachable via key lookup, but freeing them saves LRU headroom for
 * new-version entries). Wipes every bucket.
 */
export function bustNeighborhoodCache() {
  cache.clear();
}

/**
 * Test seam: introspect cache state. Not for production callers.
 */
export function _cacheStats() {
  return { size: cache.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}

/**
 * Test seam: expose the key builder so tests can assert stability and
 * bucket-sensitivity without reaching into cache internals.
 */
export function _makeKey(slug, graphVersion, bucket = 'default') {
  return makeKey(slug, graphVersion, bucket);
}

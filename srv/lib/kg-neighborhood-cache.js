// srv/lib/kg-neighborhood-cache.js
//
// In-process LRU cache for /graph/neighborhood responses.
//
// Cache key: `${slug}:${graphVersion}`. When graphVersion changes (nightly
// rebuild, or admin publish action triggers an ad-hoc rebuild), previously
// cached entries become unreachable via lookup — and get evicted naturally
// as the LRU fills with new-version entries.
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

// Simple insertion-ordered LRU: Map iteration order is insertion order,
// so `map.keys().next()` gives us the oldest key when we need to evict.
// On every hit we re-insert to move to the tail.
const cache = new Map();

function makeKey(slug, graphVersion) {
  return `${slug}\x1f${graphVersion ?? 'null'}`;
}

/**
 * Look up a cached NeighborhoodResult by (slug, graphVersion).
 * Returns undefined on miss OR on TTL-expired entry.
 * On a hit, moves the entry to the tail (LRU refresh).
 */
export function getCachedNeighborhood(slug, graphVersion) {
  const key = makeKey(slug, graphVersion);
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
export function setCachedNeighborhood(slug, graphVersion, value) {
  const key = makeKey(slug, graphVersion);
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
 * new-version entries).
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

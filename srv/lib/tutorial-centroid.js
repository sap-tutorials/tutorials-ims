// srv/lib/tutorial-centroid.js
//
// Compute + cache one embedding vector per tutorial (the "centroid" — mean
// of its step embeddings). Used by the tutorial-similarity path and the
// recommendation pipeline to compare tutorials in vector space without
// re-fetching all step embeddings on every request.
//
// Cache is a bounded module-level Map (Node = single-threaded, so no lock
// needed). TTL bounds staleness after a re-embed; `MAX_ENTRIES` bounds RAM.
// Eviction is FIFO by insertion order (not access-time LRU — cheaper and
// good enough for a warm working set of a few hundred tutorials).
const TTL_MS = 30 * 60 * 1000;   // 30 min — matches the reconciliation cadence
const MAX_ENTRIES = 256;         // ~256 * 1536f32 ≈ 1.5 MB steady state

const cache = new Map(); // key -> { value, at }

/** Test-only — clears the module-level cache between tests. */
export function __resetForTest() { cache.clear(); }

/**
 * Average N same-length vectors into one. Returns `null` for empty/nullish
 * input.
 *
 * Vectors with mismatched dimensionality are skipped (not padded/truncated).
 * The kept vectors are the ones matching the modal (most common) dimension —
 * this graceful-degrade path handles corpora that straddled an embedding
 * model change without failing the whole request. If nothing matches, `null`.
 *
 * @param {Float32Array[]} vectors
 * @returns {Float32Array | null}
 */
export function averageVectors(vectors) {
  if (!vectors || vectors.length === 0) return null;
  // Pick the modal dimension; skip rows that don't match.
  const dimCounts = new Map();
  for (const v of vectors) dimCounts.set(v.length, (dimCounts.get(v.length) ?? 0) + 1);
  let dim = 0, best = 0;
  for (const [d, c] of dimCounts) if (c > best) { best = c; dim = d; }
  const out = new Float32Array(dim);
  let kept = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
    kept += 1;
  }
  if (kept === 0) return null;
  for (let i = 0; i < dim; i++) out[i] /= kept;
  return out;
}

/**
 * Get one tutorial's centroid, caching for up to `TTL_MS`.
 *
 * `loadVectors` is a caller-supplied fetcher — typically
 * `loadStepVectors(id)` from step-vectors.js — so this module has no direct
 * DB dependency (easier to test, and lets callers plug in a bulk path).
 * The fetcher receives the tutorialId and MUST resolve to a
 * `Float32Array[]` (may be empty).
 *
 * Cache is FIFO-bounded: when size exceeds `MAX_ENTRIES` after an insert,
 * the oldest inserted entry is deleted. This is not a true LRU (no
 * access-time bookkeeping), but suffices for the recommend path's
 * hot-set of a few hundred tutorials.
 *
 * @param {string|number} tutorialId
 * @param {(id: string|number) => Promise<Float32Array[]>} loadVectors
 * @returns {Promise<Float32Array | null>}
 */
export async function getCentroid(tutorialId, loadVectors) {
  const now = Date.now();
  const hit = cache.get(tutorialId);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const vectors = await loadVectors(tutorialId);
  const value = averageVectors(vectors);

  cache.set(tutorialId, { value, at: now });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return value;
}

/**
 * Bulk variant of getCentroid. Returns Map<tutorialId, Float32Array | null>.
 *
 * Cache-aware: IDs already in the LRU & TTL-fresh come from memory; the
 * remainder are fetched in one round-trip via loadVectorsBulk, then their
 * computed centroids are stored in the same LRU. Used by branch loaders to
 * collapse N+1 sequential queries into one (issue #294).
 *
 * @param {Array<string|number>} tutorialIds
 * @param {(ids: Array) => Promise<Map<any, Float32Array[]>>} loadVectorsBulk
 */
export async function getCentroidBulk(tutorialIds, loadVectorsBulk) {
  const out = new Map();
  if (!tutorialIds || tutorialIds.length === 0) return out;

  const now = Date.now();
  const misses = [];
  for (const id of tutorialIds) {
    if (id == null || out.has(id)) continue;
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) {
      out.set(id, hit.value);
    } else {
      // Seed with null so the duplicate-id guard above (`out.has(id)`) skips
      // re-queueing this ID; the value is overwritten below from the bulk fetch.
      out.set(id, null);
      misses.push(id);
    }
  }

  if (misses.length > 0) {
    const vectorsByTid = await loadVectorsBulk(misses);
    for (const id of misses) {
      const value = averageVectors(vectorsByTid.get(id) || []);
      out.set(id, value);
      cache.set(id, { value, at: now });
    }
    // Trim LRU once after the batch.
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }
  return out;
}

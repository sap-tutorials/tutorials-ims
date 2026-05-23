// srv/lib/tutorial-centroid.js
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 256;

const cache = new Map(); // key -> { value, at }

export function __resetForTest() { cache.clear(); }

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

// srv/lib/kg-similarity.js
// Pure-function utilities for the consolidator job:
//   - cosineSim(a, b)             — Float32Array cosine similarity
//   - pickCanonical(a, b)         — deterministic merge winner
//   - findNearDuplicates(list, t) — pairwise scan above threshold
//
// No DB access — caller is responsible for loading concept embeddings into
// `embeddingVec` (Float32Array) and supplying `extractionCount` + `firstSeenAt`.
// HANA LOB-locator gymnastics live elsewhere (srv/lib/embedding-query.js
// pattern for raw-SQL BLOB retrieval).
//
// Plan ref: docs/superpowers/plans/2026-06-17-knowledge-graph-implementation.md (PR 3 / Task 3.2)

/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Returns a value in [-1, 1]. Returns 0 when either vector is the zero vector
 * (i.e. the divide-by-zero guard) — this is the right answer for the merge
 * use-case where "no information" should never look like "perfectly aligned".
 *
 * @param {ArrayLike<number>} a  — typically Float32Array
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function cosineSim(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineSim: vector dim mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Deterministically pick the canonical concept between two near-duplicates.
 *
 * Rule:
 *   1. Higher extractionCount wins (more tutorials reference it = stronger).
 *   2. Tie → older firstSeenAt (the one we've had longer is "more canonical").
 *   3. Equal on both → returns `a` (deterministic; matters for downstream
 *      tests and idempotent consolidator runs).
 *
 * @template {{ extractionCount: number, firstSeenAt: string|Date }} T
 * @param {T} a
 * @param {T} b
 * @returns {T}
 */
export function pickCanonical(a, b) {
  if (a.extractionCount !== b.extractionCount) {
    return a.extractionCount > b.extractionCount ? a : b;
  }
  const ta = new Date(a.firstSeenAt).getTime();
  const tb = new Date(b.firstSeenAt).getTime();
  return ta <= tb ? a : b;
}

/**
 * Pairwise near-duplicate detection.
 *
 * Scans all O(n²/2) unordered pairs of concepts, computes cosine similarity
 * over `embeddingVec`, and emits any pair with similarity strictly greater
 * than the threshold. Each emitted pair is augmented with the merge decision
 * via {@link pickCanonical}.
 *
 * Caller's responsibility: every concept must already carry `embeddingVec`
 * (Float32Array). This function does NOT fetch from DB.
 *
 * Output is sorted by `sim` descending so the consolidator can short-circuit
 * once the threshold drops below interest.
 *
 * @param {Array<{ID: string, embeddingVec: Float32Array, extractionCount: number, firstSeenAt: string|Date}>} concepts
 * @param {number} [threshold=0.92]
 * @returns {Array<{ canonical: object, loser: object, sim: number }>}
 */
export function findNearDuplicates(concepts, threshold = 0.92) {
  if (!Array.isArray(concepts) || concepts.length < 2) return [];
  const out = [];
  for (let i = 0; i < concepts.length; i++) {
    const a = concepts[i];
    if (!a || !a.embeddingVec) continue;
    for (let j = i + 1; j < concepts.length; j++) {
      const b = concepts[j];
      if (!b || !b.embeddingVec) continue;
      const sim = cosineSim(a.embeddingVec, b.embeddingVec);
      if (sim > threshold) {
        const canonical = pickCanonical(a, b);
        const loser = canonical === a ? b : a;
        out.push({ canonical, loser, sim });
      }
    }
  }
  out.sort((x, y) => y.sim - x.sim);
  return out;
}

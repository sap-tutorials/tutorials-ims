// test/unit/kg-similarity.test.js
// Unit tests for srv/lib/kg-similarity.js — pure-function utilities
// (cosine similarity, canonical picker, near-duplicate finder).

import { describe, it, expect } from 'vitest';
import {
  cosineSim,
  pickCanonical,
  findNearDuplicates,
} from '../../srv/lib/kg-similarity.js';

// ---------------------------------------------------------------------------
// cosineSim
// ---------------------------------------------------------------------------

describe('cosineSim', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSim(a, b)).toBeCloseTo(1.0, 6);
  });

  it('returns 1.0 for parallel (positive scaled) vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]);
    expect(cosineSim(a, b)).toBeCloseTo(1.0, 6);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(0.0, 6);
  });

  it('returns -1.0 for opposing vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSim(a, b)).toBeCloseTo(-1.0, 6);
  });

  it('returns 0 when the first vector is zero (no divide-by-zero throw)', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSim(a, b)).toBe(0);
  });

  it('returns 0 when the second vector is zero', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([0, 0, 0]);
    expect(cosineSim(a, b)).toBe(0);
  });

  it('returns 0 when both vectors are zero', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([0, 0, 0]);
    expect(cosineSim(a, b)).toBe(0);
  });

  it('throws on length mismatch', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    expect(() => cosineSim(a, b)).toThrow(/dim/i);
  });
});

// ---------------------------------------------------------------------------
// pickCanonical
// ---------------------------------------------------------------------------

describe('pickCanonical', () => {
  it('picks the one with higher extractionCount', () => {
    const a = { ID: 'a', extractionCount: 5, firstSeenAt: '2026-01-01T00:00:00Z' };
    const b = { ID: 'b', extractionCount: 10, firstSeenAt: '2026-02-01T00:00:00Z' };
    expect(pickCanonical(a, b)).toBe(b);
    expect(pickCanonical(b, a)).toBe(b);
  });

  it('breaks ties by older firstSeenAt', () => {
    const a = { ID: 'a', extractionCount: 7, firstSeenAt: '2026-01-15T00:00:00Z' };
    const b = { ID: 'b', extractionCount: 7, firstSeenAt: '2026-03-01T00:00:00Z' };
    expect(pickCanonical(a, b)).toBe(a);
    expect(pickCanonical(b, a)).toBe(a);
  });

  it('returns `a` deterministically when both extractionCount and firstSeenAt are equal', () => {
    const a = { ID: 'a', extractionCount: 4, firstSeenAt: '2026-01-01T00:00:00Z' };
    const b = { ID: 'b', extractionCount: 4, firstSeenAt: '2026-01-01T00:00:00Z' };
    expect(pickCanonical(a, b)).toBe(a);
    // ↑ deterministic — important so downstream tests depending on the picker
    //   don't see flaky ordering.
  });
});

// ---------------------------------------------------------------------------
// findNearDuplicates
// ---------------------------------------------------------------------------

function makeConcept(id, vec, extractionCount = 1, firstSeenAt = '2026-01-01T00:00:00Z') {
  return {
    ID: id,
    slug: id,
    embeddingVec: new Float32Array(vec),
    extractionCount,
    firstSeenAt,
  };
}

describe('findNearDuplicates', () => {
  it('returns an empty array when input is empty', () => {
    expect(findNearDuplicates([])).toEqual([]);
  });

  it('returns an empty array when input has only one concept', () => {
    expect(findNearDuplicates([makeConcept('a', [1, 0, 0])])).toEqual([]);
  });

  it('returns one pair for two identical-embedding concepts', () => {
    const a = makeConcept('a', [1, 2, 3], /*ext*/ 5);
    const b = makeConcept('b', [1, 2, 3], /*ext*/ 2);
    const dups = findNearDuplicates([a, b]);
    expect(dups).toHaveLength(1);
    expect(dups[0].sim).toBeCloseTo(1.0, 6);
    // Canonical = higher extractionCount = a
    expect(dups[0].canonical).toBe(a);
    expect(dups[0].loser).toBe(b);
  });

  it('ignores pairs below the threshold', () => {
    // Two roughly-orthogonal vectors → cosine ~0
    const a = makeConcept('a', [1, 0, 0]);
    const b = makeConcept('b', [0, 1, 0]);
    expect(findNearDuplicates([a, b], 0.92)).toEqual([]);
  });

  it('uses a default threshold of 0.92', () => {
    const a = makeConcept('a', [1, 1, 1]);
    const b = makeConcept('b', [1, 1, 1.05]); // very similar, sim > 0.99
    const c = makeConcept('c', [1, -1, 0]); // dissimilar
    const dups = findNearDuplicates([a, b, c]); // no explicit threshold → 0.92
    // Only (a,b) should be returned, not anything involving c
    expect(dups).toHaveLength(1);
    const ids = new Set([dups[0].canonical.ID, dups[0].loser.ID]);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(false);
  });

  it('returns multiple pairs sorted by similarity descending', () => {
    // (a,b) very similar (sim ~1.0); (a,c) just over threshold (~0.94)
    const a = makeConcept('a', [1, 0, 0]);
    const b = makeConcept('b', [1, 0, 0]); // identical to a → sim=1.0
    // pick c so cos(a,c) is between 0.92 and 1.0 but distinct
    const c = makeConcept('c', [3, 1, 0]); // cos(a,c) = 3/sqrt(10) ≈ 0.9486
    // also engineer (b,c) similar: same vector as (a,c)
    const dups = findNearDuplicates([a, b, c], 0.92);
    expect(dups.length).toBeGreaterThanOrEqual(2);
    // Sorted descending by sim
    for (let i = 1; i < dups.length; i++) {
      expect(dups[i - 1].sim).toBeGreaterThanOrEqual(dups[i].sim);
    }
    // The (a,b) pair (sim=1.0) must be first
    expect(dups[0].sim).toBeCloseTo(1.0, 6);
  });

  it('each returned pair has { canonical, loser, sim } with canonical chosen by pickCanonical', () => {
    const a = makeConcept('a', [1, 1, 1], /*ext*/ 3, '2026-01-10T00:00:00Z');
    const b = makeConcept('b', [1, 1, 1], /*ext*/ 8, '2026-02-01T00:00:00Z');
    const dups = findNearDuplicates([a, b], 0.92);
    expect(dups).toHaveLength(1);
    const pair = dups[0];
    expect(pair).toHaveProperty('canonical');
    expect(pair).toHaveProperty('loser');
    expect(pair).toHaveProperty('sim');
    expect(pair.canonical).toBe(b); // higher extractionCount
    expect(pair.loser).toBe(a);
  });

  it('skips concepts whose embeddingVec is missing/null/undefined without throwing', () => {
    // Two well-formed concepts that would normally pair (sim=1.0)…
    const a = makeConcept('a', [1, 2, 3], /*ext*/ 5);
    const b = makeConcept('b', [1, 2, 3], /*ext*/ 2);
    // …plus three concepts with broken embeddings: missing, null, undefined.
    const missing = {
      ID: 'missing',
      slug: 'missing',
      // embeddingVec is absent entirely
      extractionCount: 1,
      firstSeenAt: '2026-01-01T00:00:00Z',
    };
    const nullVec = {
      ID: 'null-vec',
      slug: 'null-vec',
      embeddingVec: null,
      extractionCount: 1,
      firstSeenAt: '2026-01-01T00:00:00Z',
    };
    const undefVec = {
      ID: 'undef-vec',
      slug: 'undef-vec',
      embeddingVec: undefined,
      extractionCount: 1,
      firstSeenAt: '2026-01-01T00:00:00Z',
    };

    let dups;
    expect(() => {
      dups = findNearDuplicates([missing, a, nullVec, b, undefVec], 0.92);
    }).not.toThrow();

    // Only the (a, b) pair survives — the broken concepts are skipped silently
    expect(dups).toHaveLength(1);
    const ids = new Set([dups[0].canonical.ID, dups[0].loser.ID]);
    expect(ids).toEqual(new Set(['a', 'b']));
  });
});

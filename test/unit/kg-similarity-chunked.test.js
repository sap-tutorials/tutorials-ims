// test/unit/kg-similarity-chunked.test.js
// findNearDuplicatesChunked must produce identical output to the sync
// findNearDuplicates (the weekly consolidator's finder) while yielding to
// the event loop, so the interactive preview path can never drift from cron.

import { describe, it, expect, vi } from 'vitest';
import {
  findNearDuplicates,
  findNearDuplicatesChunked,
} from '../../srv/lib/kg-similarity.js';

function makeConcept(id, vec, extractionCount = 1, firstSeenAt = '2026-01-01') {
  return { ID: id, slug: id, name: id, extractionCount, firstSeenAt, embeddingVec: new Float32Array(vec) };
}

// A deterministic fixture with a couple of near-duplicate clusters.
const fixture = [
  makeConcept('a', [1, 0, 0]),
  makeConcept('b', [0.99, 0.01, 0], 5),      // ~dup of a; higher extractionCount
  makeConcept('c', [0, 1, 0]),
  makeConcept('d', [0, 0.98, 0.02], 2),      // ~dup of c
  makeConcept('e', [0.5, 0.5, 0.7071]),      // unrelated
];

describe('findNearDuplicatesChunked', () => {
  it('returns identical pairs and order to the sync finder', async () => {
    const threshold = 0.9;
    const sync = findNearDuplicates(fixture, threshold);
    const chunked = await findNearDuplicatesChunked(fixture, threshold, { chunkSize: 2 });
    const norm = (arr) => arr.map((p) => ({ c: p.canonical.ID, l: p.loser.ID, s: Number(p.sim.toFixed(6)) }));
    expect(norm(chunked)).toEqual(norm(sync));
  });

  it('invokes onYield at least once when concepts exceed chunkSize', async () => {
    const onYield = vi.fn();
    await findNearDuplicatesChunked(fixture, 0.9, { chunkSize: 2, onYield });
    expect(onYield).toHaveBeenCalled();
  });

  it('returns [] for fewer than 2 concepts', async () => {
    expect(await findNearDuplicatesChunked([], 0.9)).toEqual([]);
    expect(await findNearDuplicatesChunked([fixture[0]], 0.9)).toEqual([]);
  });
});

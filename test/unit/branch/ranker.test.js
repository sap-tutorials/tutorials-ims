import { describe, it, expect } from 'vitest';
import { rankBranches } from '../../../srv/lib/branch/ranker.js';

const STATE = Object.freeze({
  completedSlugs: new Set(['intro-tutorial']),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: 'cloud', role: 'developer', cloud: 'btp' })
});

describe('rankBranches', () => {
  it('returns empty when no branch has an embeddingHint', async () => {
    const bp = { id: 'x', branches: [{ key: 'a' }, { key: 'b' }] };
    const deps = {
      loadCentroidBySlug: async () => null,
      loadUserCentroid:   async () => null,
      loadCoCompletions:  async () => ({}),
    };
    const out = await rankBranches(bp, STATE, {}, deps);
    expect(out).toEqual([]);
  });

  it('ranks higher-cosine branch above lower-cosine branch', async () => {
    const bp = {
      id: 'x',
      branches: [
        { key: 'a', embeddingHint: 'tut-a' },
        { key: 'b', embeddingHint: 'tut-b' },
      ],
    };
    const deps = {
      loadCentroidBySlug: async (slug) => {
        if (slug === 'tut-a') return [0.1, 0.99, 0];
        if (slug === 'tut-b') return [0.99, 0.1, 0];
        return null;
      },
      loadUserCentroid: async () => [1, 0, 0],
      loadCoCompletions: async () => ({}),
    };
    const out = await rankBranches(bp, STATE, {}, deps);
    expect(out[0].key).toBe('b');
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('ignores branches whose embeddingHint resolves to null', async () => {
    const bp = {
      id: 'x',
      branches: [
        { key: 'a', embeddingHint: 'missing' },
        { key: 'b', embeddingHint: 'tut-b' },
      ],
    };
    const deps = {
      loadCentroidBySlug: async (slug) => slug === 'tut-b' ? [1, 0, 0] : null,
      loadUserCentroid: async () => [0.9, 0.1, 0],
      loadCoCompletions: async () => ({}),
    };
    const out = await rankBranches(bp, STATE, {}, deps);
    expect(out.find(r => r.key === 'a').score).toBe(0);
  });

  it('returns zero scores for anonymous user (no user centroid)', async () => {
    const bp = {
      id: 'x',
      branches: [{ key: 'a', embeddingHint: 'tut-a' }, { key: 'b', embeddingHint: 'tut-b' }],
    };
    const deps = {
      loadCentroidBySlug: async () => [1, 0, 0],
      loadUserCentroid:   async () => null,
      loadCoCompletions:  async () => ({}),
    };
    const out = await rankBranches(bp, { completedSlugs: new Set(), completedMissionSlugs: new Set(), profile: {} }, {}, deps);
    expect(out.every(r => r.score === 0)).toBe(true);
  });
});

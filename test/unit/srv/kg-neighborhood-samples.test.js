// test/unit/srv/kg-neighborhood-samples.test.js
//
// Phase 4.6 (#747): neighborhood otherResources widens to 6 types (adds sample).
// Mirrors test/unit/srv/kg-neighborhood-merge.test.js pattern.

import { describe, it, expect } from 'vitest';
import { mergeOtherResources, MAX_OTHER_RESOURCES } from '../../../srv/lib/kg-neighborhood-merge.js';

describe('kg-neighborhood-merge with samples (6-array)', () => {
  it('6-array merge respects overlapCount sort across all types', () => {
    const result = mergeOtherResources(
      [{ type: 'learning-journey', slug: 'lj-1', title: 'LJ', url: 'x', overlapCount: 5 }],
      [{ type: 'blog-post', slug: 'bp-1', title: 'BP', url: 'x', overlapCount: 3 }],
      [{ type: 'discovery-mission', slug: 'dm-1', title: 'DM', url: 'x', overlapCount: 4 }],
      [{ type: 'video', slug: 'vd-1', title: 'V', url: 'x', overlapCount: 2 }],
      [{ type: 'api-doc', slug: 'ad-1', title: 'AD', url: 'x', overlapCount: 6 }],
      [{ type: 'sample', slug: 'sa-1', title: 'SA', url: 'x', overlapCount: 7 }],
    );
    expect(result.map(r => r.type)).toEqual(['sample', 'api-doc', 'learning-journey', 'discovery-mission', 'blog-post']);
  });

  it('sample type discriminant + language/stars/lastCommitAt preserved', () => {
    const result = mergeOtherResources([], [], [], [], [], [{
      type: 'sample', slug: 'sa-1', title: 'SA', url: 'x',
      language: 'JavaScript', stars: 100, lastCommitAt: '2026-06-01T00:00:00Z',
      overlapCount: 1,
    }]);
    expect(result[0]).toMatchObject({
      type: 'sample', language: 'JavaScript', stars: 100,
      lastCommitAt: '2026-06-01T00:00:00Z',
    });
  });

  it('top-K cap applies across 6 types when one type dominates', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      type: 'sample', slug: `sa-${i}`, title: `SA${i}`, url: 'x', overlapCount: 10 - i,
    }));
    const result = mergeOtherResources([], [], [], [], [], many);
    expect(result).toHaveLength(MAX_OTHER_RESOURCES);   // #1089
  });
});

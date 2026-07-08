// test/unit/srv/kg-neighborhood-api-docs.test.js
//
// Phase 4.5 (#746): assert mergeOtherResources widens to a 5-array merge
// without per-type quota. Helper itself is variadic since Phase 4.3, so this
// is a sanity test that the 5th type co-exists with the prior 4.

import { describe, it, expect } from 'vitest';
import { mergeOtherResources, MAX_OTHER_RESOURCES } from '../../../srv/lib/kg-neighborhood-merge.js';

describe('kg-neighborhood-merge with api-docs', () => {
  it('5-array merge respects overlapCount sort across all types', () => {
    const result = mergeOtherResources(
      [{ type: 'learning-journey', slug: 'lj-1', title: 'LJ', url: 'x', overlapCount: 5 }],
      [{ type: 'blog-post', slug: 'bp-1', title: 'BP', url: 'x', overlapCount: 3 }],
      [{ type: 'discovery-mission', slug: 'dm-1', title: 'DM', url: 'x', overlapCount: 4 }],
      [{ type: 'video', slug: 'vd-1', title: 'V', url: 'x', overlapCount: 2 }],
      [{ type: 'api-doc', slug: 'ad-1', title: 'AD', url: 'x', overlapCount: 6 }],
    );
    expect(result.map(r => r.type)).toEqual([
      'api-doc', 'learning-journey', 'discovery-mission', 'blog-post', 'video',
    ]);
  });

  it('api-doc type discriminant + category + apiType fields preserved', () => {
    const result = mergeOtherResources([], [], [], [], [{
      type: 'api-doc', slug: 'ad-1', title: 'AD', url: 'x',
      category: 'CAP', apiType: 'reference', overlapCount: 1,
    }]);
    expect(result[0]).toMatchObject({
      type: 'api-doc', category: 'CAP', apiType: 'reference',
    });
  });

  it('top-K cap applies across 5 types when one type dominates', () => {
    const apiDocs = Array.from({ length: 10 }, (_, i) => ({
      type: 'api-doc', slug: `ad-${i}`, title: `AD${i}`, url: 'x', overlapCount: 10 - i,
    }));
    const result = mergeOtherResources([], [], [], [], apiDocs);
    expect(result).toHaveLength(MAX_OTHER_RESOURCES);   // #1089
  });
});

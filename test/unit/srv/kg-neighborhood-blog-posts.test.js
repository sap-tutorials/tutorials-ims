// test/unit/srv/kg-neighborhood-blog-posts.test.js
//
// Phase 4.2 (#447 §9): neighborhood().otherResources widens to include
// blog-post rows in addition to learning-journey rows. Top-5 across both
// types, sorted by overlapCount.
//
// Unit-test scope: the JS-side merge-and-cap step is now exercised by a
// pure helper to keep this test independent of the HANA-only KG_QUERY
// procedure (which the full neighborhood handler depends on). The hybrid
// test for the neighborhood path lives at the integration layer.

import { describe, it, expect } from 'vitest';
import { mergeOtherResources, MAX_OTHER_RESOURCES } from '../../../srv/lib/kg-neighborhood-merge.js';

describe('mergeOtherResources — Phase 4.2 cross-type ranking', () => {
  it('unions journey + blog rows, sorts by overlap desc, caps top-5', () => {
    const journeys = [
      { type: 'learning-journey', slug: 'j1', title: 'J1', overlapCount: 3 },
      { type: 'learning-journey', slug: 'j2', title: 'J2', overlapCount: 1 },
    ];
    const blogs = [
      { type: 'blog-post', slug: 'bp-1', title: 'B1', overlapCount: 2 },
      { type: 'blog-post', slug: 'bp-2', title: 'B2', overlapCount: 1 },
    ];

    const result = mergeOtherResources(journeys, blogs);
    expect(result).toHaveLength(4);
    expect(result.map(x => x.slug)).toEqual(['j1', 'bp-1', 'j2', 'bp-2']);
  });

  it('caps at MAX_OTHER_RESOURCES total when there are more than that many rows across both types', () => {
    const journeys = Array.from({ length: 4 }, (_, i) => ({
      type: 'learning-journey', slug: `j${i}`, overlapCount: 10 - i,
    }));
    const blogs = Array.from({ length: 4 }, (_, i) => ({
      type: 'blog-post', slug: `bp-${i}`, overlapCount: 8 - i,
    }));

    const result = mergeOtherResources(journeys, blogs);
    expect(result).toHaveLength(MAX_OTHER_RESOURCES);   // #1089
    // First five by overlap desc: j0(10), j1(9), j2(8), bp-0(8), j3(7) → top-5
    expect(result[0]).toMatchObject({ slug: 'j0', overlapCount: 10 });
    expect(result[4].overlapCount).toBeGreaterThanOrEqual(7);
  });

  it('handles empty inputs gracefully', () => {
    expect(mergeOtherResources([], [])).toEqual([]);
    expect(mergeOtherResources([{ type: 'learning-journey', overlapCount: 1 }], [])).toHaveLength(1);
    expect(mergeOtherResources([], [{ type: 'blog-post', overlapCount: 1 }])).toHaveLength(1);
  });

  it('treats missing overlapCount as 0 (places at end)', () => {
    const result = mergeOtherResources(
      [{ type: 'learning-journey', slug: 'j1' }],
      [{ type: 'blog-post', slug: 'bp-1', overlapCount: 1 }],
    );
    expect(result[0].slug).toBe('bp-1');
    expect(result[1].slug).toBe('j1');
  });
});

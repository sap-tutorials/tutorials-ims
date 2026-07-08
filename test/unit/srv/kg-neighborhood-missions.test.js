// Extends the existing kg-neighborhood-merge-helper test (4.2) to cover
// 3-array merge with mission rows under the new variadic signature.
import { describe, it, expect } from 'vitest';
import { mergeOtherResources, MAX_OTHER_RESOURCES } from '../../../srv/lib/kg-neighborhood-merge.js';

describe('mergeOtherResources — 3-array variadic (Phase 4.3)', () => {
  it('merges journey + blog + mission arrays via positional args; top-5 by overlapCount', () => {
    const journeys = [
      { type: 'learning-journey', slug: 'j1', overlapCount: 5 },
      { type: 'learning-journey', slug: 'j2', overlapCount: 3 },
    ];
    const blogs = [
      { type: 'blog-post', slug: 'b1', overlapCount: 7 },
      { type: 'blog-post', slug: 'b2', overlapCount: 2 },
    ];
    const missions = [
      { type: 'discovery-mission', slug: 'm1', overlapCount: 9 },
      { type: 'discovery-mission', slug: 'm2', overlapCount: 8 },
    ];

    const result = mergeOtherResources(journeys, blogs, missions);
    expect(result).toHaveLength(MAX_OTHER_RESOURCES);   // #1089
    expect(result[0].slug).toBe('m1');  // overlap=9
    expect(result[1].slug).toBe('m2');  // overlap=8
    expect(result[2].slug).toBe('b1');  // overlap=7
    expect(result[3].slug).toBe('j1');  // overlap=5
    expect(result[4].slug).toBe('j2');  // overlap=3
  });

  it('preserves type discriminant + content-type-specific fields for downstream rendering', () => {
    const missions = [
      { type: 'discovery-mission', slug: 'm1', overlapCount: 5,
        effortLevel: 2, categoryLabel: 'Onboarding' },
    ];
    const result = mergeOtherResources([], [], missions);
    expect(result[0]).toMatchObject({
      type: 'discovery-mission',
      effortLevel: 2,
      categoryLabel: 'Onboarding',
    });
  });

  it('caps top-5 even when one type dominates', () => {
    const missions = Array.from({ length: 8 }, (_, i) => ({
      type: 'discovery-mission',
      slug: `m${i}`,
      overlapCount: 10 - i,
    }));
    const result = mergeOtherResources([], [], missions);
    expect(result).toHaveLength(MAX_OTHER_RESOURCES);
    expect(result.every(r => r.type === 'discovery-mission')).toBe(true);
  });

  it('still accepts 2-arg calls (Phase 4.2 backward-compat)', () => {
    // Phase 4.2's existing call site shape: mergeOtherResources(journeys, blogs)
    const journeys = [{ type: 'learning-journey', slug: 'j1', overlapCount: 5 }];
    const blogs = [{ type: 'blog-post', slug: 'b1', overlapCount: 7 }];
    const result = mergeOtherResources(journeys, blogs);
    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe('b1');
  });
});

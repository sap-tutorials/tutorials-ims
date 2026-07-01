// test/unit/srv/kg-neighborhood-help-docs.test.js
//
// Phase 4.7 (#748): assert the variadic mergeOtherResources helper
// handles 7 row-arrays cleanly (Phase 4.7 adds a 7th type: help-doc).
// The merge helper is already variadic (Phase 4.3); this test locks in
// the top-5 total behavior with 7 types present.

import { describe, it, expect } from 'vitest';
import { mergeOtherResources } from '../../../srv/lib/kg-neighborhood-merge.js';

describe('kg-neighborhood-merge with help-docs (7-array)', () => {
  it('7-array merge respects overlapCount sort across all types', () => {
    const result = mergeOtherResources(
      [{ type: 'learning-journey', slug: 'lj-1', title: 'LJ', url: 'x', overlapCount: 5 }],
      [{ type: 'blog-post', slug: 'bp-1', title: 'BP', url: 'x', overlapCount: 3 }],
      [{ type: 'discovery-mission', slug: 'dm-1', title: 'DM', url: 'x', overlapCount: 4 }],
      [{ type: 'video', slug: 'vd-1', title: 'V', url: 'x', overlapCount: 2 }],
      [{ type: 'api-doc', slug: 'ad-1', title: 'AD', url: 'x', overlapCount: 6 }],
      [{ type: 'sample', slug: 'sa-1', title: 'SA', url: 'x', overlapCount: 7 }],
      [{ type: 'help-doc', slug: 'hd-1', title: 'HD', url: 'x', overlapCount: 8 }],
    );
    // Top-5 by overlapCount desc: 8 (help-doc), 7 (sample), 6 (api-doc), 5 (learning-journey), 4 (discovery-mission)
    expect(result.map(r => r.type)).toEqual([
      'help-doc', 'sample', 'api-doc', 'learning-journey', 'discovery-mission',
    ]);
  });

  it('help-doc type discriminant + source/anchor preserved', () => {
    const result = mergeOtherResources([], [], [], [], [], [], [{
      type: 'help-doc',
      slug: 'hd-cap-cloud-sap__docs__node_js__handlers',
      title: 'Handlers',
      url: 'https://cap.cloud.sap/docs/node.js/handlers',
      source: 'cap-cloud-sap',
      sourceLabel: 'CAP',
      anchor: 'before-create',
      overlapCount: 1,
    }]);
    expect(result[0]).toMatchObject({
      type: 'help-doc',
      source: 'cap-cloud-sap',
      sourceLabel: 'CAP',
      anchor: 'before-create',
    });
  });

  it('top-5 cap applies across 7 types when help-doc dominates', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      type: 'help-doc', slug: `hd-${i}`, title: `HD${i}`, url: 'x', overlapCount: 10 - i,
    }));
    const result = mergeOtherResources([], [], [], [], [], [], many);
    expect(result).toHaveLength(5);
  });
});

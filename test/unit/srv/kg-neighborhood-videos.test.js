// test/unit/srv/kg-neighborhood-videos.test.js
//
// Phase 4.4 (#447) PR-2: widens the kg-neighborhood-missions test (4.3) to
// cover the 4-array variadic merge with video rows. mergeOtherResources is
// already variadic — this test confirms the new 4th positional arg works,
// preserves the type discriminant + video-specific fields, and caps at top-5.

import { describe, it, expect } from 'vitest';
import { mergeOtherResources, MAX_OTHER_RESOURCES } from '../../../srv/lib/kg-neighborhood-merge.js';

describe('mergeOtherResources — 4-array variadic (Phase 4.4)', () => {
  it('merges journey + blog + mission + video arrays via positional args; top-5 by overlapCount across all 4', () => {
    const journeys = [
      { type: 'learning-journey', slug: 'j1', overlapCount: 3 },
    ];
    const blogs = [
      { type: 'blog-post', slug: 'b1', overlapCount: 4 },
    ];
    const missions = [
      { type: 'discovery-mission', slug: 'm1', overlapCount: 6 },
    ];
    const videos = [
      { type: 'video', slug: 'vd-abc12345', overlapCount: 9 },
      { type: 'video', slug: 'vd-xyz67890', overlapCount: 8 },
      { type: 'video', slug: 'vd-jkl00000', overlapCount: 7 },
    ];

    const result = mergeOtherResources(journeys, blogs, missions, videos);
    expect(result).toHaveLength(MAX_OTHER_RESOURCES);   // #1089
    expect(result.map(r => r.slug)).toEqual([
      'vd-abc12345',  // overlap=9
      'vd-xyz67890',  // overlap=8
      'vd-jkl00000',  // overlap=7
      'm1',           // overlap=6
      'b1',           // overlap=4
    ]);
  });

  it('preserves type discriminant + video-specific fields (channelTitle, publishedAt, thumbnailUrl)', () => {
    const videos = [
      { type: 'video', slug: 'vd-abc12345', overlapCount: 5,
        title: 'Developer News', url: 'https://www.youtube.com/watch?v=abc12345',
        channelTitle: 'SAP Developers', publishedAt: '2026-06-01T10:00:00Z',
        thumbnailUrl: 'https://i.ytimg.com/vi/abc12345/hqdefault.jpg' },
    ];
    const result = mergeOtherResources([], [], [], videos);
    expect(result[0]).toMatchObject({
      type: 'video',
      slug: 'vd-abc12345',
      channelTitle: 'SAP Developers',
      publishedAt: '2026-06-01T10:00:00Z',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc12345/hqdefault.jpg',
    });
  });

  it('caps top-5 even when one type (video) dominates across 4-array merge', () => {
    const videos = Array.from({ length: 8 }, (_, i) => ({
      type: 'video',
      slug: `vd-${i.toString().padStart(11, '0')}`,
      overlapCount: 10 - i,
    }));
    const result = mergeOtherResources([], [], [], videos);
    expect(result).toHaveLength(MAX_OTHER_RESOURCES);
    expect(result.every(r => r.type === 'video')).toBe(true);
  });
});

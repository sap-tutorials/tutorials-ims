import { describe, it, expect } from 'vitest';
import {
  CONTENT_TYPES, hrefFor, isNewFrom, computeRank, rankAndCap, TOTAL_ITEMS_PER_CARD,
} from '../../../srv/lib/topic-cluster-content.js';

describe('topic-cluster-content helpers', () => {
  it('registry covers all 11 kinds with a valid tier + source', () => {
    const kinds = CONTENT_TYPES.map(t => t.kind).sort();
    expect(kinds).toEqual([
      'api-doc','blog-post','community-event','discovery-mission','group',
      'help-doc','learning-journey','mission','sample','tutorial','video',
    ]);
    for (const t of CONTENT_TYPES) {
      expect(['stable','volatile']).toContain(t.tier);
      expect(['direct','concept']).toContain(t.source);
    }
    // Only blogs/videos/events are volatile.
    expect(CONTENT_TYPES.filter(t => t.tier === 'volatile').map(t => t.kind).sort())
      .toEqual(['blog-post','community-event','video']);
  });

  it('hrefFor synthesizes direct paths and passes external urls through', () => {
    expect(hrefFor('tutorial', 'abc', null)).toBe('/tutorials/abc');
    expect(hrefFor('mission', 'abc', null)).toBe('/tutorials/mission-abc');
    expect(hrefFor('group', 'abc', null)).toBe('/tutorials/group-abc');
    expect(hrefFor('blog-post', 'x', 'https://community.sap.com/p/1')).toBe('https://community.sap.com/p/1');
  });

  it('isNewFrom flags recent dates only', () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    expect(isNewFrom('2026-08-10T00:00:00Z', now)).toBe(true);
    expect(isNewFrom('2026-05-01T00:00:00Z', now)).toBe(false);
    expect(isNewFrom(null, now)).toBe(false);
  });

  it('computeRank blends confidence, recency and optional pagerank', () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const base = { kind: 'blog-post', slug: 's', confidence: 0.8, dateMs: now };
    const old = { kind: 'blog-post', slug: 's', confidence: 0.8, dateMs: Date.parse('2020-01-01Z') };
    expect(computeRank(base, null)).toBeGreaterThan(computeRank(old, null));
    const withPR = computeRank({ kind: 'tutorial', slug: 't', confidence: 1, dateMs: null },
      { tutorialRank: new Map([['t', 1.0]]), conceptRank: new Map() });
    const noPR = computeRank({ kind: 'tutorial', slug: 't', confidence: 1, dateMs: null }, null);
    expect(withPR).toBeGreaterThan(noPR);
  });

  it('rankAndCap enforces per-type caps then total cap, sorted by rank', () => {
    const items = [];
    for (let i = 0; i < 10; i++) items.push({ kind: 'tutorial', slug: `t${i}`, title: `T${i}`, rank: i });
    for (let i = 0; i < 10; i++) items.push({ kind: 'blog-post', slug: `b${i}`, title: `B${i}`, rank: 100 + i });
    const out = rankAndCap(items, { perType: { tutorial: 3, 'blog-post': 2 }, total: 4 });
    expect(out.length).toBe(4);                       // total cap
    expect(out.filter(x => x.kind === 'blog-post').length).toBeLessThanOrEqual(2);
    expect(out[0].rank).toBeGreaterThanOrEqual(out[1].rank); // rank desc
  });

  it('TOTAL_ITEMS_PER_CARD is 8', () => expect(TOTAL_ITEMS_PER_CARD).toBe(8));
});

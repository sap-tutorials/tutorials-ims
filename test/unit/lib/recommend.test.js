// test/unit/lib/recommend.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __resetForTest as resetCentroid } from '../../../srv/lib/tutorial-centroid.js';
import { recommend, RANKING_WEIGHTS, __resetForTest as resetRecommend } from '../../../srv/lib/recommend.js';

const f = (...nums) => new Float32Array(nums);

// Three "tutorials": current + two candidates. Centroids chosen so c1 is more similar.
const centroids = {
  cur: f(1, 0, 0),
  c1:  f(0.9, 0.1, 0),
  c2:  f(0, 1, 0)
};
const candidates = [
  { ID: 'cur-id', slug: 'cur', title: 'Current', primaryTag: 'CAP', published: true, time: 30 },
  { ID: 'c1-id',  slug: 'c1',  title: 'Cand One', primaryTag: 'CAP', published: true, time: 20 },
  { ID: 'c2-id',  slug: 'c2',  title: 'Cand Two', primaryTag: 'BTP', published: true, time: 45 }
];

const deps = {
  loadAllTutorials: async () => candidates,
  loadCentroid: async (id) => {
    if (id === 'cur-id') return centroids.cur;
    if (id === 'c1-id')  return centroids.c1;
    if (id === 'c2-id')  return centroids.c2;
    return null;
  },
  loadCoCompletions: async () => ({ cur: [{ slug: 'c1', score: 5 }, { slug: 'c2', score: 1 }] }),
  loadUserProgress: async (user) => user
    ? { completedSlugs: ['c2'] }
    : { completedSlugs: [] }
};

beforeEach(() => { resetCentroid(); resetRecommend(); });

describe('recommend()', () => {
  it('weights similarity 0.6 and co-completion 0.4', () => {
    expect(RANKING_WEIGHTS).toEqual({ sim: 0.6, co: 0.4 });
  });

  it('returns top-K with current slug excluded', async () => {
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, deps);
    expect(r.recommendations.map(x => x.slug)).not.toContain('cur');
  });

  it('filters completed slugs for authed user, includes them for anon', async () => {
    const authed = await recommend({ currentSlug: 'cur', user: { id: 'u1' }, limit: 3 }, deps);
    const anon = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, deps);
    expect(authed.recommendations.map(x => x.slug)).not.toContain('c2');
    expect(anon.recommendations.map(x => x.slug)).toContain('c2');
  });

  it('marks personalized=true only when completed-filter actually removed something', async () => {
    const authed = await recommend({ currentSlug: 'cur', user: { id: 'u1' }, limit: 3 }, deps);
    expect(authed.personalized).toBe(true);
    const anon = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, deps);
    expect(anon.personalized).toBe(false);
  });

  it('orders by blended score; c1 (more similar + higher co) ranks above c2', async () => {
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, deps);
    expect(r.recommendations[0].slug).toBe('c1');
  });

  it('returns reason=no_embedding when current centroid is null', async () => {
    const noEmb = { ...deps, loadCentroid: async (id) => id === 'cur-id' ? null : centroids.c1 };
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, noEmb);
    expect(r).toEqual({ currentSlug: 'cur', personalized: false, recommendations: [], reason: 'no_embedding' });
  });

  it('falls back to similarity-only when co-completion map is empty', async () => {
    const noCo = { ...deps, loadCoCompletions: async () => ({}) };
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, noCo);
    expect(r.recommendations[0].slug).toBe('c1');
  });

  it('skips unpublished candidates', async () => {
    const unpub = {
      ...deps,
      loadAllTutorials: async () => candidates.map(c => c.slug === 'c1' ? { ...c, published: false } : c)
    };
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, unpub);
    expect(r.recommendations.map(x => x.slug)).not.toContain('c1');
  });

  it('clamps limit to 6 max', async () => {
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 99 }, deps);
    expect(r.recommendations.length).toBeLessThanOrEqual(6);
  });

  it('tiebreak prefers same primaryTag, then title-asc', async () => {
    // Two candidates with identical scores; one shares primaryTag with current.
    const tied = {
      loadAllTutorials: async () => ([
        { ID: 'cur-id', slug: 'cur', title: 'Current', primaryTag: 'CAP', published: true },
        { ID: 'a-id', slug: 'a-twin', title: 'Twin A', primaryTag: 'BTP', published: true },
        { ID: 'b-id', slug: 'b-twin', title: 'Twin B', primaryTag: 'CAP', published: true }
      ]),
      loadCentroid: async () => f(1, 0, 0),
      loadCoCompletions: async () => ({}),
      loadUserProgress: async () => ({ completedSlugs: [] })
    };
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, tied);
    expect(r.recommendations[0].slug).toBe('b-twin');
  });

  it('caches identical (slug,user) requests within TTL', async () => {
    let coCalls = 0;
    const counted = { ...deps, loadCoCompletions: async () => { coCalls++; return {}; } };
    await recommend({ currentSlug: 'cur', user: null, limit: 3 }, counted);
    await recommend({ currentSlug: 'cur', user: null, limit: 3 }, counted);
    expect(coCalls).toBe(1);
  });
});

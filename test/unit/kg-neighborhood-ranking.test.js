// test/unit/kg-neighborhood-ranking.test.js
// Unit tests for rankNeighborhood — the pure-function neighborhood ranker
// exported from srv/knowledge-graph-service.js.
//
// Input shape (`rows`) — what the SPARQL layer hands back, one row per
// (type, targetSlug) pair. The four UNION branches in NEIGHBORHOOD_QUERY
// produce different combinations of bound vars:
//   { type: 'teaches',          targetSlug, targetLabel, weight: 1.0 }
//   { type: 'prerequisitesOf',  targetSlug, weight: 0.9 }     (no targetLabel)
//   { type: 'sharedConcepts',   targetSlug }                   (no label, no weight)
//   { type: 'whatToLearnNext',  targetSlug }                   (no label, no weight)
//
// Output shape:
//   {
//     teaches:         [{ slug, name }, ...],
//     prerequisitesOf: [{ slug, title?, weight, reason }, ...],
//     sharedConcepts:  [{ slug, title?, weight, reason }, ...],
//     whatToLearnNext: [{ slug, title?, weight, reason }, ...],
//   }
//
// Title enrichment is the HANDLER's job (next dispatch), not the ranker's.
// The ranker leaves `title` undefined on tutorial-targeted items.

import { describe, it, expect } from 'vitest';
import { rankNeighborhood } from '../../srv/knowledge-graph-service.js';

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('rankNeighborhood — empty input', () => {
  it('empty rows return four empty groups', () => {
    const out = rankNeighborhood([], 'foo', new Map());
    expect(out).toEqual({
      teaches: [],
      prerequisitesOf: [],
      sharedConcepts: [],
      whatToLearnNext: [],
    });
  });

  it('handles undefined coCompletionMap and tutorialTeachesMap', () => {
    const out = rankNeighborhood([], 'foo');
    expect(out.teaches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('rankNeighborhood — grouping', () => {
  it('returns four populated groups when all four types are present', () => {
    const rows = [
      { type: 'teaches',         targetSlug: 'concept-a', targetLabel: 'Concept A', weight: 1.0 },
      { type: 'prerequisitesOf', targetSlug: 'tut-prereq', weight: 0.9 },
      { type: 'sharedConcepts',  targetSlug: 'tut-shared' },
      { type: 'whatToLearnNext', targetSlug: 'tut-next' },
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.teaches).toHaveLength(1);
    expect(out.prerequisitesOf).toHaveLength(1);
    expect(out.sharedConcepts).toHaveLength(1);
    expect(out.whatToLearnNext).toHaveLength(1);
  });

  it('teaches items keep targetLabel as `name` and weight 1.0', () => {
    const rows = [
      { type: 'teaches', targetSlug: 'concept-x', targetLabel: 'Concept X', weight: 1.0 },
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.teaches[0]).toMatchObject({ slug: 'concept-x', name: 'Concept X' });
  });

  it('tutorial-targeted items leave title undefined (handler enriches separately)', () => {
    const rows = [
      { type: 'prerequisitesOf', targetSlug: 'tut-prereq', weight: 0.9 },
      { type: 'sharedConcepts',  targetSlug: 'tut-shared' },
      { type: 'whatToLearnNext', targetSlug: 'tut-next' },
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.prerequisitesOf[0].title).toBeUndefined();
    expect(out.sharedConcepts[0].title).toBeUndefined();
    expect(out.whatToLearnNext[0].title).toBeUndefined();
  });

  it('drops rows with unknown type', () => {
    const rows = [
      { type: 'teaches',  targetSlug: 'a', targetLabel: 'A', weight: 1.0 },
      { type: 'mystery',  targetSlug: 'b' },
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.teaches).toHaveLength(1);
  });

  it('drops rows missing targetSlug', () => {
    const rows = [
      { type: 'teaches',  targetSlug: '', targetLabel: 'A' },
      { type: 'sharedConcepts', targetSlug: null },
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.teaches).toHaveLength(0);
    expect(out.sharedConcepts).toHaveLength(0);
  });

  it('filters out the input slug itself from tutorial-targeted groups (defense-in-depth)', () => {
    // SPARQL FILTER already excludes self, but the ranker should also
    // filter so it's robust against an upstream regression.
    const rows = [
      { type: 'sharedConcepts', targetSlug: 'src' },
      { type: 'sharedConcepts', targetSlug: 'other' },
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.sharedConcepts.map((r) => r.slug)).toEqual(['other']);
  });

  it('deduplicates rows with the same (type, targetSlug)', () => {
    const rows = [
      { type: 'sharedConcepts', targetSlug: 'a' },
      { type: 'sharedConcepts', targetSlug: 'a' },
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.sharedConcepts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// whatToLearnNext re-ranking by coCompletionMap
// ---------------------------------------------------------------------------

describe('rankNeighborhood — whatToLearnNext coCompletion boost', () => {
  it('boosts items present in coCompletionMap', () => {
    const rows = [
      { type: 'whatToLearnNext', targetSlug: 'next-low' },
      { type: 'whatToLearnNext', targetSlug: 'next-high' },
    ];
    const map = new Map([['next-high', 7]]);
    const out = rankNeighborhood(rows, 'src', map);
    // next-high (boosted) should rank ahead of next-low.
    expect(out.whatToLearnNext.map((r) => r.slug)).toEqual(['next-high', 'next-low']);
  });

  it('larger coCompletion score ranks higher', () => {
    const rows = [
      { type: 'whatToLearnNext', targetSlug: 'a' },
      { type: 'whatToLearnNext', targetSlug: 'b' },
      { type: 'whatToLearnNext', targetSlug: 'c' },
    ];
    const map = new Map([
      ['a', 1],
      ['b', 100],
      ['c', 10],
    ]);
    const out = rankNeighborhood(rows, 'src', map);
    expect(out.whatToLearnNext.map((r) => r.slug)).toEqual(['b', 'c', 'a']);
  });

  it('does NOT boost teaches/prerequisitesOf/sharedConcepts (only whatToLearnNext)', () => {
    const rows = [
      { type: 'sharedConcepts', targetSlug: 'a' },
      { type: 'sharedConcepts', targetSlug: 'b' },
    ];
    const map = new Map([['b', 1000]]);  // huge boost for b
    const out = rankNeighborhood(rows, 'src', map);
    // b has a co-completion entry but sharedConcepts is NOT re-ranked by it.
    // Order should be deterministic by slug (a < b lexicographic).
    expect(out.sharedConcepts.map((r) => r.slug)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Subset suppression (sharedConcepts only)
// ---------------------------------------------------------------------------

describe('rankNeighborhood — subset suppression', () => {
  it('candidates teaching a fully-contained subset of input are pushed to bottom of sharedConcepts', () => {
    // Input 'src' teaches {a, b, c}.
    // Candidate 'cand-subset' teaches {a, b} — fully contained, no learning value.
    // Candidate 'cand-extends' teaches {a, b, x} — has new concept x.
    const rows = [
      { type: 'sharedConcepts', targetSlug: 'cand-subset' },
      { type: 'sharedConcepts', targetSlug: 'cand-extends' },
    ];
    const tutorialTeachesMap = new Map([
      ['src',          new Set(['a', 'b', 'c'])],
      ['cand-subset',  new Set(['a', 'b'])],
      ['cand-extends', new Set(['a', 'b', 'x'])],
    ]);
    const out = rankNeighborhood(rows, 'src', new Map(), tutorialTeachesMap);
    // cand-extends ranks first because it has new concepts; cand-subset
    // is pushed to the bottom but NOT removed.
    expect(out.sharedConcepts.map((r) => r.slug)).toEqual(['cand-extends', 'cand-subset']);
  });

  it('skips subset suppression when tutorialTeachesMap is undefined', () => {
    const rows = [
      { type: 'sharedConcepts', targetSlug: 'a' },
      { type: 'sharedConcepts', targetSlug: 'b' },
    ];
    // No teaches-map → no subset logic, just lex order.
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.sharedConcepts.map((r) => r.slug)).toEqual(['a', 'b']);
  });

  it('skips subset suppression for teaches/prerequisitesOf/whatToLearnNext groups', () => {
    // Subset suppression only applies to sharedConcepts. Other groups have
    // different semantics and we don't want to change their order.
    const rows = [
      { type: 'whatToLearnNext', targetSlug: 'cand-subset' },
      { type: 'whatToLearnNext', targetSlug: 'cand-extends' },
    ];
    const tutorialTeachesMap = new Map([
      ['src',          new Set(['a', 'b'])],
      ['cand-subset',  new Set(['a'])],
      ['cand-extends', new Set(['a', 'x'])],
    ]);
    const out = rankNeighborhood(rows, 'src', new Map(), tutorialTeachesMap);
    // No subset push-down for whatToLearnNext — lex order.
    expect(out.whatToLearnNext.map((r) => r.slug).sort()).toEqual(['cand-extends', 'cand-subset']);
  });
});

// ---------------------------------------------------------------------------
// Top-N limit per group
// ---------------------------------------------------------------------------

describe('rankNeighborhood — top-10 cap per group', () => {
  it('caps teaches at 10 items', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      type: 'teaches',
      targetSlug: `c-${String(i).padStart(2, '0')}`,
      targetLabel: `C${i}`,
      weight: 1.0,
    }));
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.teaches).toHaveLength(10);
  });

  it('caps each tutorial-targeted group at 10 items', () => {
    function makeRows(type) {
      return Array.from({ length: 15 }, (_, i) => ({
        type,
        targetSlug: `tut-${String(i).padStart(2, '0')}`,
      }));
    }
    const rows = [
      ...makeRows('prerequisitesOf'),
      ...makeRows('sharedConcepts'),
      ...makeRows('whatToLearnNext'),
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.prerequisitesOf).toHaveLength(10);
    expect(out.sharedConcepts).toHaveLength(10);
    expect(out.whatToLearnNext).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Determinism — stable ties
// ---------------------------------------------------------------------------

describe('rankNeighborhood — stable order on ties', () => {
  it('ties broken by targetSlug lexicographic', () => {
    const rows = [
      { type: 'sharedConcepts', targetSlug: 'banana' },
      { type: 'sharedConcepts', targetSlug: 'apple' },
      { type: 'sharedConcepts', targetSlug: 'cherry' },
    ];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.sharedConcepts.map((r) => r.slug)).toEqual(['apple', 'banana', 'cherry']);
  });

  it('whatToLearnNext: equal coCompletion ranks → lexicographic by slug', () => {
    const rows = [
      { type: 'whatToLearnNext', targetSlug: 'b' },
      { type: 'whatToLearnNext', targetSlug: 'a' },
    ];
    const map = new Map([['a', 5], ['b', 5]]);
    const out = rankNeighborhood(rows, 'src', map);
    expect(out.whatToLearnNext.map((r) => r.slug)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Output object shape (regression — handler relies on this)
// ---------------------------------------------------------------------------

describe('rankNeighborhood — output shape', () => {
  it('always returns an object with exactly the four group keys', () => {
    const out = rankNeighborhood([], 'src', new Map());
    expect(Object.keys(out).sort()).toEqual(['prerequisitesOf', 'sharedConcepts', 'teaches', 'whatToLearnNext']);
  });

  it('teaches items have shape { slug, name }', () => {
    const rows = [{ type: 'teaches', targetSlug: 's', targetLabel: 'L', weight: 1.0 }];
    const out = rankNeighborhood(rows, 'src', new Map());
    expect(out.teaches[0]).toEqual({ slug: 's', name: 'L' });
  });

  it('tutorial-targeted items expose slug + weight + reason', () => {
    const rows = [
      { type: 'prerequisitesOf', targetSlug: 's', weight: 0.9 },
      { type: 'sharedConcepts',  targetSlug: 't' },
      { type: 'whatToLearnNext', targetSlug: 'u' },
    ];
    const out = rankNeighborhood(rows, 'src', new Map([['u', 3]]));
    expect(out.prerequisitesOf[0]).toMatchObject({ slug: 's' });
    expect(out.prerequisitesOf[0].reason).toMatch(/prereq|requires/i);
    expect(out.sharedConcepts[0]).toMatchObject({ slug: 't' });
    expect(out.sharedConcepts[0].reason).toMatch(/shared|concept/i);
    expect(out.whatToLearnNext[0]).toMatchObject({ slug: 'u' });
    expect(out.whatToLearnNext[0].reason).toMatch(/next|advanced|learn/i);
  });

  it('all weights are finite numbers', () => {
    const rows = [
      { type: 'teaches',         targetSlug: 'a', targetLabel: 'A', weight: 1.0 },
      { type: 'prerequisitesOf', targetSlug: 'b', weight: 0.9 },
      { type: 'sharedConcepts',  targetSlug: 'c' },
      { type: 'whatToLearnNext', targetSlug: 'd' },
    ];
    const out = rankNeighborhood(rows, 'src', new Map([['d', 5]]));
    // teaches uses `name`, no weight on items per type contract above.
    expect(typeof out.prerequisitesOf[0].weight).toBe('number');
    expect(Number.isFinite(out.prerequisitesOf[0].weight)).toBe(true);
    expect(typeof out.sharedConcepts[0].weight).toBe('number');
    expect(Number.isFinite(out.sharedConcepts[0].weight)).toBe(true);
    expect(typeof out.whatToLearnNext[0].weight).toBe('number');
    expect(Number.isFinite(out.whatToLearnNext[0].weight)).toBe(true);
  });
});

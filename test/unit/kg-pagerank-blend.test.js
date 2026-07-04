// test/unit/kg-pagerank-blend.test.js
//
// Unit tests for the PageRank multiplicative blend added to
// rankNeighborhood by #916. The pure ranker gets an extra 5th positional
// argument — an object with { conceptRank, tutorialRank, _normalizeTut } —
// and multiplicatively blends the tutorial-side PageRank into all three
// tutorial-targeted arm weights. The 5th arg is polymorphic: numbers
// still mean maxResults (backwards-compat with all pre-#916 callers).
//
// Fail-open properties are the guarantee: empty maps or missing entries
// collapse the multiplier to 1.0, so a KG_PAGERANK_ENABLED=false path
// behaves identically to today.

import { describe, it, expect } from 'vitest';
import { rankNeighborhood } from '../../srv/knowledge-graph-service.js';

// Helper — build a rankMaps object matching what loadRankMaps returns.
function makeRankMaps(tutorialEntries = [], conceptEntries = []) {
  const conceptRank = new Map(conceptEntries);
  const tutorialRank = new Map(tutorialEntries);
  let tMin = Infinity, tMax = -Infinity;
  for (const s of tutorialRank.values()) {
    if (s < tMin) tMin = s;
    if (s > tMax) tMax = s;
  }
  const range = tMax - tMin;
  const _normalizeTut = range > 0
    ? (s) => (s - tMin) / range
    : () => 0;
  return { conceptRank, tutorialRank, _normalizeTut };
}

describe('rankNeighborhood — #916 PageRank blend', () => {
  it('does not change ordering when the tutorial rank map is empty', () => {
    const rows = [
      { type: 'prerequisitesOf', targetSlug: 'a', weight: 0.9 },
      { type: 'prerequisitesOf', targetSlug: 'b', weight: 0.9 },
    ];
    const noPr = rankNeighborhood(rows, 'src', new Map());
    const withEmpty = rankNeighborhood(rows, 'src', new Map(), undefined, makeRankMaps([]));
    expect(withEmpty.prerequisitesOf.map(x => x.slug))
      .toEqual(noPr.prerequisitesOf.map(x => x.slug));
    expect(withEmpty.prerequisitesOf[0].weight).toBeCloseTo(0.9);
    expect(withEmpty.prerequisitesOf[1].weight).toBeCloseTo(0.9);
  });

  it('lifts a high-PR tutorial above equal-weighted peers in prerequisitesOf', () => {
    const rows = [
      { type: 'prerequisitesOf', targetSlug: 'lowpr',  weight: 0.9 },
      { type: 'prerequisitesOf', targetSlug: 'highpr', weight: 0.9 },
    ];
    // highpr has a much higher PageRank; normalize maps lowpr→0, highpr→1.
    const maps = makeRankMaps([
      ['lowpr',  0.001],
      ['highpr', 0.10],
    ]);
    const out = rankNeighborhood(rows, 'src', new Map(), undefined, maps);
    // First arm item is highpr (weight ~ 0.9 × (1 + 1.0×1.0) = 1.8).
    expect(out.prerequisitesOf[0].slug).toBe('highpr');
    expect(out.prerequisitesOf[0].weight).toBeCloseTo(1.8, 6);
    // Second is lowpr (weight ~ 0.9 × (1 + 1.0×0.0) = 0.9).
    expect(out.prerequisitesOf[1].slug).toBe('lowpr');
    expect(out.prerequisitesOf[1].weight).toBeCloseTo(0.9, 6);
  });

  it('compounds coCompletion boost × PageRank blend on whatToLearnNext', () => {
    const rows = [
      { type: 'whatToLearnNext', targetSlug: 'both' },   // co + PR
      { type: 'whatToLearnNext', targetSlug: 'coOnly' }, // co only
      { type: 'whatToLearnNext', targetSlug: 'prOnly' }, // PR only
      { type: 'whatToLearnNext', targetSlug: 'neither' },
    ];
    const coMap = new Map([
      ['both',   9],
      ['coOnly', 9],
    ]);
    const maps = makeRankMaps([
      ['both',    0.10],
      ['coOnly',  0.001],
      ['prOnly',  0.10],
      ['neither', 0.001],
    ]);
    const out = rankNeighborhood(rows, 'src', coMap, undefined, maps);
    // both:    0.5 × (1 + log10(10)) × (1 + 1×1)    = 0.5 × 2 × 2 = 2.0
    // coOnly:  0.5 × 2 × (1 + 1×0)                 = 0.5 × 2 × 1 = 1.0
    // prOnly:  0.5 × 1 × (1 + 1×1)                 = 0.5 × 1 × 2 = 1.0
    // neither: 0.5 × 1 × 1                          = 0.5
    const bySlug = Object.fromEntries(out.whatToLearnNext.map(i => [i.slug, i.weight]));
    expect(bySlug.both).toBeCloseTo(2.0, 6);
    expect(bySlug.coOnly).toBeCloseTo(1.0, 6);
    expect(bySlug.prOnly).toBeCloseTo(1.0, 6);
    expect(bySlug.neither).toBeCloseTo(0.5, 6);
    // Ordering: both first.
    expect(out.whatToLearnNext[0].slug).toBe('both');
  });

  it('leaves weight unchanged for a tutorial not in the tutorial-rank map', () => {
    const rows = [
      { type: 'sharedConcepts', targetSlug: 'unknown' },
    ];
    const maps = makeRankMaps([
      ['other', 0.5],
    ]);
    const out = rankNeighborhood(rows, 'src', new Map(), undefined, maps);
    expect(out.sharedConcepts[0].weight).toBeCloseTo(0.5, 6); // DEFAULT_WEIGHT unchanged
  });

  it('sorts teaches by concept PageRank when conceptRank is populated', () => {
    const rows = [
      { type: 'teaches', targetSlug: 'aardvark', targetLabel: 'A', weight: 1.0 },
      { type: 'teaches', targetSlug: 'zebra',    targetLabel: 'Z', weight: 1.0 },
      { type: 'teaches', targetSlug: 'middle',   targetLabel: 'M', weight: 1.0 },
    ];
    // Without conceptRank, teaches is lex order → aardvark, middle, zebra.
    const outLex = rankNeighborhood(rows, 'src', new Map());
    expect(outLex.teaches.map(t => t.slug)).toEqual(['aardvark', 'middle', 'zebra']);

    // With conceptRank, sort by score desc. zebra highest, middle, aardvark.
    const maps = makeRankMaps([], [
      ['aardvark', 0.01],
      ['middle',   0.05],
      ['zebra',    0.10],
    ]);
    const outPr = rankNeighborhood(rows, 'src', new Map(), undefined, maps);
    expect(outPr.teaches.map(t => t.slug)).toEqual(['zebra', 'middle', 'aardvark']);
  });

  it('backwards-compat: 5th arg is still treated as maxResults when numeric', () => {
    // Simulate the pre-#916 signature: pass 3 as maxResults in position 5.
    const rows = Array.from({ length: 20 }, (_, i) => ({
      type: 'prerequisitesOf',
      targetSlug: `t${String(i).padStart(2, '0')}`,
      weight: 0.9,
    }));
    const out = rankNeighborhood(rows, 'src', new Map(), undefined, 3);
    expect(out.prerequisitesOf.length).toBe(3);
  });

  it('backwards-compat: rankMaps + maxResults both passed uses 6th arg as cap', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      type: 'prerequisitesOf',
      targetSlug: `t${String(i).padStart(2, '0')}`,
      weight: 0.9,
    }));
    const maps = makeRankMaps([]);   // empty → no blend
    const out = rankNeighborhood(rows, 'src', new Map(), undefined, maps, 5);
    expect(out.prerequisitesOf.length).toBe(5);
  });

  it('collapses to identity when normalize returns 0 (all-equal PageRank)', () => {
    const rows = [
      { type: 'prerequisitesOf', targetSlug: 'a', weight: 0.9 },
      { type: 'prerequisitesOf', targetSlug: 'b', weight: 0.9 },
    ];
    // All scores identical → range === 0 → normalize returns 0 → multiplier 1.0.
    const maps = makeRankMaps([
      ['a', 0.05],
      ['b', 0.05],
    ]);
    const out = rankNeighborhood(rows, 'src', new Map(), undefined, maps);
    expect(out.prerequisitesOf[0].weight).toBeCloseTo(0.9, 6);
    expect(out.prerequisitesOf[1].weight).toBeCloseTo(0.9, 6);
  });
});

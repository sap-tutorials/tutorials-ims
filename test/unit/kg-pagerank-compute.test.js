// test/unit/kg-pagerank-compute.test.js
//
// Unit tests for the pure-function PageRank core (computePageRank).
// Uses synthetic in-memory graphs — no DB, no CDS model. Runs on every
// `npm test` invocation, so any algorithm regression surfaces before
// hybrid or smoke.
//
// The DB-integrated path (runKgPageRank against real KG_PG_EDGES_V) is
// covered by the hybrid test at test/hybrid/kg-pagerank.test.js.

import { describe, it, expect } from 'vitest';
import { computePageRank } from '../../srv/jobs/kg-pagerank-job.js';

describe('computePageRank — pure function core', () => {
  it('returns an empty rank map for an empty vertex set', () => {
    const { rank, iterations, converged } = computePageRank([], []);
    expect(rank.size).toBe(0);
    expect(iterations).toBe(0);
    expect(converged).toBe(true);
  });

  it('assigns rank 1.0 to a single isolated vertex', () => {
    const { rank } = computePageRank(['a'], []);
    expect(rank.size).toBe(1);
    expect(rank.get('a')).toBeCloseTo(1, 6);
  });

  it('assigns equal rank to two symmetric vertices', () => {
    // a — b (undirected). Both endpoints see identical neighborhoods,
    // so their ranks must match by symmetry.
    const { rank, converged } = computePageRank(
      ['a', 'b'],
      [['a', 'b']],
    );
    expect(converged).toBe(true);
    expect(rank.get('a')).toBeCloseTo(rank.get('b'), 6);
    // And each is 0.5.
    expect(rank.get('a')).toBeCloseTo(0.5, 6);
  });

  it('total probability mass sums to ~1.0 on a connected graph', () => {
    // Triangle a—b—c—a.
    const { rank } = computePageRank(
      ['a', 'b', 'c'],
      [['a', 'b'], ['b', 'c'], ['c', 'a']],
    );
    const total = [...rank.values()].reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('conserves mass when the graph contains dangling vertices', () => {
    // b and c are dangling — no incident edges. Without dangling-mass
    // redistribution, iteration would leak probability and the total
    // would drift below 1.
    const { rank } = computePageRank(
      ['a', 'b', 'c', 'd'],
      [['a', 'd']],
    );
    const total = [...rank.values()].reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('gives a hub vertex strictly higher rank than its symmetric leaves', () => {
    // Hub-and-spoke:
    //   hub connected to leaf1, leaf2, leaf3
    // With undirected PageRank the hub has degree 3, each leaf has
    // degree 1. Hub must rank strictly above every leaf.
    const { rank } = computePageRank(
      ['hub', 'leaf1', 'leaf2', 'leaf3'],
      [['hub', 'leaf1'], ['hub', 'leaf2'], ['hub', 'leaf3']],
    );
    expect(rank.get('hub')).toBeGreaterThan(rank.get('leaf1'));
    expect(rank.get('hub')).toBeGreaterThan(rank.get('leaf2'));
    expect(rank.get('hub')).toBeGreaterThan(rank.get('leaf3'));
    // Leaves are symmetric — same rank to within convergence tolerance.
    expect(rank.get('leaf1')).toBeCloseTo(rank.get('leaf2'), 6);
    expect(rank.get('leaf2')).toBeCloseTo(rank.get('leaf3'), 6);
  });

  it('ranks the concept hub above its leaves; spoke tutorials tie by symmetry', () => {
    // Hub-and-spoke topology matching the KG shape (all edges undirected):
    //   - hub-concept connected to leaf-c1, leaf-c2, leaf-c3 (requires)
    //   - hub-tutorial teaches hub-concept
    //   - spoke-t1/2/3 teach leaf-c1/2/3 respectively
    //
    // Under undirected PageRank (matches KG_SHORTEST_PATH_GRAPH's
    // direction='ANY' convention and matches coCompletedWith's inherent
    // symmetry), the steady state has a closed form:
    //
    //   H (hub-concept) ≈ 0.263      — dominant
    //   L (each leaf)   ≈ 0.142      — 1.85× smaller than H
    //   T (hub-tutorial)≈ 0.075      — H/4 dilution (hub has degree 4)
    //   S (each spoke)  ≈ 0.079      — L/2 dilution (leaves have degree 2)
    //
    // Note: hub-tutorial < spoke by ~5% here because the 4× dilution at
    // hub-concept beats the 1.85× H/L rank ratio. This is a property of
    // this teaches-only fixture, NOT of real KG data — real production
    // tutorials have direct coCompletedWith links between hot tutorials
    // (~20k such edges) that lift real hubs decisively. The design
    // spec's earlier assertion "hub-tutorial > spoke" was derived from
    // a directed-PageRank mental model; undirected PageRank on this
    // topology says spokes tie among themselves and hub-tutorial sits
    // slightly below. Keeping the algorithm undirected matches the rest
    // of the KG navigation surface (see KG_SHORTEST_PATH_GRAPH).
    const vertices = [
      'hub-concept', 'leaf-c1', 'leaf-c2', 'leaf-c3',
      'hub-tutorial', 'spoke-t1', 'spoke-t2', 'spoke-t3',
    ];
    const edges = [
      ['leaf-c1', 'hub-concept'],
      ['leaf-c2', 'hub-concept'],
      ['leaf-c3', 'hub-concept'],
      ['hub-tutorial', 'hub-concept'],
      ['spoke-t1', 'leaf-c1'],
      ['spoke-t2', 'leaf-c2'],
      ['spoke-t3', 'leaf-c3'],
    ];
    const { rank } = computePageRank(vertices, edges);

    // Concept-tier: hub outranks each leaf. This IS the ordering signal
    // the whatToLearnNext ranker cares about — concepts closer to the
    // graph's structural center rise to the top.
    expect(rank.get('hub-concept')).toBeGreaterThan(rank.get('leaf-c1'));
    expect(rank.get('hub-concept')).toBeGreaterThan(rank.get('leaf-c2'));
    expect(rank.get('hub-concept')).toBeGreaterThan(rank.get('leaf-c3'));

    // Tutorial-tier: three spoke tutorials tie exactly (topology-symmetric).
    // hub-tutorial sits slightly below spokes on this fixture.
    expect(rank.get('spoke-t1')).toBeCloseTo(rank.get('spoke-t2'), 6);
    expect(rank.get('spoke-t2')).toBeCloseTo(rank.get('spoke-t3'), 6);

    // Sanity: every score is a finite positive number in (0, 1).
    for (const v of vertices) {
      const r = rank.get(v);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan(1);
    }

    // Total probability mass = 1 (dangling-mass conservation).
    const total = [...rank.values()].reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('drops self-loops without corrupting the score distribution', () => {
    // A→A self-loop should be silently ignored. Compare against the
    // same graph without the self-loop and expect identical ranks.
    const vertices = ['a', 'b'];
    const withLoop = computePageRank(vertices, [['a', 'a'], ['a', 'b']]);
    const clean = computePageRank(vertices, [['a', 'b']]);
    expect(withLoop.rank.get('a')).toBeCloseTo(clean.rank.get('a'), 6);
    expect(withLoop.rank.get('b')).toBeCloseTo(clean.rank.get('b'), 6);
    expect(withLoop.selfLoops).toBe(1);
  });

  it('drops orphan edges (endpoints missing from vertex set) safely', () => {
    // Edge references 'ghost' — not in vertex list. Should skip silently
    // and report via danglingOrphans counter.
    const { rank, danglingOrphans } = computePageRank(
      ['a', 'b'],
      [['a', 'b'], ['a', 'ghost']],
    );
    expect(danglingOrphans).toBe(1);
    expect(rank.size).toBe(2);
    const total = [...rank.values()].reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('converges within the default iteration cap on a moderate graph', () => {
    // Random-ish 50-vertex graph. Should converge well below the 100
    // iteration cap. Deterministic edge list — no Math.random.
    const vertices = Array.from({ length: 50 }, (_, i) => `v${i}`);
    const edges = [];
    for (let i = 0; i < 50; i++) {
      for (let j = 1; j <= 3; j++) {
        edges.push([`v${i}`, `v${(i + j) % 50}`]);
      }
    }
    const { converged, iterations } = computePageRank(vertices, edges);
    expect(converged).toBe(true);
    expect(iterations).toBeLessThan(100);
  });
});

// test/unit/kg-wcc-compute.test.js
//
// Unit tests for the pure-function WCC core (computeWcc).
// Synthetic in-memory graphs — no DB, no CDS model. Any algorithm
// regression surfaces on every `npm test` before hybrid or smoke.
//
// The DB-integrated path (runKgWcc against real KG_PG_EDGES_V) is
// covered by the hybrid test at test/hybrid/kg-wcc.test.js.
//
// Spec:  docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
// Issue: #918

import { describe, it, expect } from 'vitest';
import { computeWcc } from '../../srv/jobs/kg-wcc-job.js';

describe('computeWcc — pure function core', () => {
  it('returns empty result for an empty vertex set', () => {
    const { components, componentCount } = computeWcc([], []);
    expect(components).toEqual([]);
    expect(componentCount).toBe(0);
  });

  it('flags every isolated vertex as its own component', () => {
    const { components, componentCount } = computeWcc(['a', 'b', 'c'], []);
    expect(componentCount).toBe(3);
    for (const c of components) {
      expect(c.componentSize).toBe(1);
      expect(c.componentId).toBe(c.vertexKey);
    }
  });

  it('unions two vertices joined by one edge', () => {
    const { components, componentCount } = computeWcc(
      ['a', 'b'],
      [['a', 'b']],
    );
    expect(componentCount).toBe(1);
    expect(components[0].componentSize).toBe(2);
    expect(components[1].componentSize).toBe(2);
    expect(components[0].componentId).toBe(components[1].componentId);
  });

  it('separates two disconnected clusters', () => {
    // a-b-c cluster, d-e cluster, f isolated.
    const { components, componentCount } = computeWcc(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      [['a', 'b'], ['b', 'c'], ['d', 'e']],
    );
    expect(componentCount).toBe(3);
    const byKey = new Map(components.map((c) => [c.vertexKey, c]));
    expect(byKey.get('a').componentSize).toBe(3);
    expect(byKey.get('b').componentSize).toBe(3);
    expect(byKey.get('c').componentSize).toBe(3);
    expect(byKey.get('a').componentId).toBe(byKey.get('b').componentId);
    expect(byKey.get('a').componentId).toBe(byKey.get('c').componentId);
    expect(byKey.get('d').componentSize).toBe(2);
    expect(byKey.get('e').componentSize).toBe(2);
    expect(byKey.get('d').componentId).toBe(byKey.get('e').componentId);
    expect(byKey.get('f').componentSize).toBe(1);
    expect(byKey.get('a').componentId).not.toBe(byKey.get('d').componentId);
    expect(byKey.get('a').componentId).not.toBe(byKey.get('f').componentId);
  });

  it('treats directed edges as undirected (a→b and c→b unify all three)', () => {
    // Guards against a future refactor accidentally adding direction-awareness.
    const { componentCount } = computeWcc(
      ['a', 'b', 'c'],
      [['a', 'b'], ['c', 'b']],
    );
    expect(componentCount).toBe(1);
  });

  it('skips self-loops without merging anything', () => {
    // a-a is a self-loop; a stays a singleton component.
    const { components, componentCount } = computeWcc(
      ['a', 'b'],
      [['a', 'a']],
    );
    expect(componentCount).toBe(2);
    const byKey = new Map(components.map((c) => [c.vertexKey, c]));
    expect(byKey.get('a').componentSize).toBe(1);
    expect(byKey.get('b').componentSize).toBe(1);
  });

  it('skips orphan edges (source or target not in vertex set)', () => {
    // Edge [a, 'nonexistent'] should be dropped, not throw.
    const { components, componentCount } = computeWcc(
      ['a', 'b'],
      [['a', 'nonexistent'], ['b', 'also-missing']],
    );
    expect(componentCount).toBe(2);
    const byKey = new Map(components.map((c) => [c.vertexKey, c]));
    expect(byKey.get('a').componentSize).toBe(1);
    expect(byKey.get('b').componentSize).toBe(1);
  });

  it('handles a long chain (100 vertices) as one component', () => {
    // Regression guard for union-by-rank / path-compression correctness at
    // depth. Without both, this pathological chain would still be a single
    // component but find() would be O(N) per call.
    const N = 100;
    const vertices = Array.from({ length: N }, (_, i) => `v${i}`);
    const edges = Array.from({ length: N - 1 }, (_, i) => [`v${i}`, `v${i + 1}`]);
    const { components, componentCount } = computeWcc(vertices, edges);
    expect(componentCount).toBe(1);
    const rootIds = new Set(components.map((c) => c.componentId));
    expect(rootIds.size).toBe(1);
    for (const c of components) expect(c.componentSize).toBe(N);
  });
});

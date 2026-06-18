// test/unit/kg-cycles.test.js
// Unit tests for findCycles in srv/lib/kg-cycles.js — pure DFS over a
// :requires edge graph. Inputs are plain JS objects; no DB / async / mocks.
//
// Caller filters edges to predicate==='requires' before passing. The
// `confidence` field is used for weakest-edge selection (lowest wins).
// Determinism rule: when confidences tie, weakest is the lowest edge id
// lexicographically.

import { describe, it, expect } from 'vitest';
import { findCycles } from '../../srv/lib/kg-cycles.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const e = (id, source, target, confidence = 0.9) => ({
  id,
  source,
  target,
  predicate: 'requires',
  confidence,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findCycles — empty / acyclic', () => {
  it('returns empty result for empty input', () => {
    const result = findCycles([]);
    expect(result).toEqual({ cycles: [], weakestEdges: [] });
  });

  it('returns empty result for a single non-cyclic edge', () => {
    const result = findCycles([e('e1', 'A', 'B', 0.9)]);
    expect(result).toEqual({ cycles: [], weakestEdges: [] });
  });

  it('returns empty result for a longer DAG (A → B → C → D)', () => {
    const edges = [
      e('e1', 'A', 'B', 0.9),
      e('e2', 'B', 'C', 0.85),
      e('e3', 'C', 'D', 0.8),
    ];
    const result = findCycles(edges);
    expect(result.cycles).toEqual([]);
    expect(result.weakestEdges).toEqual([]);
  });
});

describe('findCycles — direct cycle (length 2)', () => {
  it('flags A → B → A and picks the lower-confidence edge as weakest', () => {
    const edges = [
      e('e1', 'A', 'B', 0.9),
      e('e2', 'B', 'A', 0.7),
    ];
    const result = findCycles(edges);
    expect(result.cycles.length).toBe(1);
    expect(result.cycles[0].length).toBe(2);
    expect(result.weakestEdges).toEqual(['e2']);
  });
});

describe('findCycles — indirect cycle (length 3)', () => {
  it('flags A → B → C → A and picks the lowest-confidence edge', () => {
    const edges = [
      e('e1', 'A', 'B', 0.9),
      e('e2', 'B', 'C', 0.6),  // weakest
      e('e3', 'C', 'A', 0.85),
    ];
    const result = findCycles(edges);
    expect(result.cycles.length).toBe(1);
    expect(result.cycles[0].length).toBe(3);
    expect(result.weakestEdges).toEqual(['e2']);
  });
});

describe('findCycles — multiple disjoint cycles', () => {
  it('returns BOTH cycles, each with its own weakest edge', () => {
    const edges = [
      // cycle 1: A↔B
      e('e1', 'A', 'B', 0.9),
      e('e2', 'B', 'A', 0.7),  // weakest of cycle 1
      // cycle 2: C↔D
      e('e3', 'C', 'D', 0.5),  // weakest of cycle 2
      e('e4', 'D', 'C', 0.95),
    ];
    const result = findCycles(edges);
    expect(result.cycles.length).toBe(2);
    expect(new Set(result.weakestEdges)).toEqual(new Set(['e2', 'e3']));
    expect(result.weakestEdges.length).toBe(2);
  });
});

describe('findCycles — self-loop', () => {
  it('flags A → A as a length-1 cycle and that edge is its own weakest', () => {
    const edges = [e('e1', 'A', 'A', 0.8)];
    const result = findCycles(edges);
    expect(result.cycles.length).toBe(1);
    expect(result.cycles[0].length).toBe(1);
    expect(result.cycles[0][0].id).toBe('e1');
    expect(result.weakestEdges).toEqual(['e1']);
  });
});

describe('findCycles — cycle plus non-cycle edges', () => {
  it('does not include tree-branch edges in the cycle path', () => {
    const edges = [
      // cycle: A → B → C → A
      e('e1', 'A', 'B', 0.9),
      e('e2', 'B', 'C', 0.85),
      e('e3', 'C', 'A', 0.6),  // weakest
      // tree branches off the cycle
      e('e4', 'B', 'D', 0.95),
      e('e5', 'D', 'E', 0.95),
    ];
    const result = findCycles(edges);
    expect(result.cycles.length).toBe(1);
    expect(result.cycles[0].length).toBe(3);
    const ids = result.cycles[0].map((x) => x.id).sort();
    expect(ids).toEqual(['e1', 'e2', 'e3']);
    expect(result.weakestEdges).toEqual(['e3']);
  });
});

describe('findCycles — confidence tie-break determinism', () => {
  it('lowest edge id lexicographically when confidences tie', () => {
    const edges = [
      e('eB', 'A', 'B', 0.7),
      e('eA', 'B', 'A', 0.7),  // same confidence; lower id wins
    ];
    const result = findCycles(edges);
    expect(result.cycles.length).toBe(1);
    expect(result.weakestEdges).toEqual(['eA']);
  });
});

describe('findCycles — same edge in multiple cycles', () => {
  it('dedupes weakestEdges; both cycles still returned', () => {
    // Two cycles share edge e1 (A → B):
    //   cycle 1: A → B → A           (e1, e2)
    //   cycle 2: A → B → C → A       (e1, e3, e4)
    // e1 is the weakest in both.
    const edges = [
      e('e1', 'A', 'B', 0.4),  // weakest in BOTH cycles
      e('e2', 'B', 'A', 0.9),
      e('e3', 'B', 'C', 0.8),
      e('e4', 'C', 'A', 0.85),
    ];
    const result = findCycles(edges);
    expect(result.cycles.length).toBe(2);
    expect(result.weakestEdges).toEqual(['e1']);
  });
});

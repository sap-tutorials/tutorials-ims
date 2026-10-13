// hugo-apps/src/shared/goalCompletion.test.ts
import { describe, it, expect } from 'vitest';
import { goalCompletion } from './goalCompletion';

describe('goalCompletion', () => {
  it('reports zero progress when nothing is completed', () => {
    const r = goalCompletion(['a', 'b', 'c'], new Set());
    expect(r).toEqual({ completed: 0, total: 3, percent: 0, complete: false });
  });

  it('reports partial progress and rounds the percent', () => {
    const r = goalCompletion(['a', 'b', 'c'], new Set(['a']));
    // 1/3 = 33.33… → rounded to 33
    expect(r).toEqual({ completed: 1, total: 3, percent: 33, complete: false });
  });

  it('reports complete when every tutorial is done', () => {
    const r = goalCompletion(['a', 'b'], new Set(['a', 'b']));
    expect(r).toEqual({ completed: 2, total: 2, percent: 100, complete: true });
  });

  it('ignores completed slugs that are not part of this goal', () => {
    const r = goalCompletion(['a', 'b'], new Set(['a', 'x', 'y']));
    expect(r).toEqual({ completed: 1, total: 2, percent: 50, complete: false });
  });

  it('de-duplicates repeated slugs in the goal list', () => {
    const r = goalCompletion(['a', 'a', 'b'], new Set(['a']));
    // unique tutorials: a, b → 1 of 2
    expect(r).toEqual({ completed: 1, total: 2, percent: 50, complete: false });
  });

  it('lower-cases slugs on both sides before comparing', () => {
    // tutorial slugs are lowercase-canonical; guard against mixed-case drift
    const r = goalCompletion(['Abc', 'DEF'], new Set(['abc']));
    expect(r).toEqual({ completed: 1, total: 2, percent: 50, complete: false });
  });

  it('returns an empty, not-complete result for an empty goal', () => {
    const r = goalCompletion([], new Set(['a']));
    expect(r).toEqual({ completed: 0, total: 0, percent: 0, complete: false });
  });
});

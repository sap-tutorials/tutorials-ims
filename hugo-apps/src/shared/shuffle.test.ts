import { describe, it, expect } from 'vitest';
import { shuffleArray } from './shuffle';

describe('shuffleArray', () => {
  it('returns a permutation: same length and same multiset of elements', () => {
    const input = ['a', 'b', 'c', 'd'];
    const out = shuffleArray(input);
    expect(out).toHaveLength(4);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    const copy = [...input];
    shuffleArray(input);
    expect(input).toEqual(copy);
  });

  it('is deterministic under an injected rng', () => {
    // rng returns 0 every step → Fisher-Yates swaps i with index 0 each time.
    // With the standard descending-i loop (i = n-1 .. 1), j = floor(0 * (i+1)) = 0,
    // producing a fixed, reproducible permutation. We assert the exact output so a
    // future refactor of the loop that changes the permutation is caught.
    const out = shuffleArray(['a', 'b', 'c', 'd'], () => 0);
    expect(out).toEqual(['b', 'c', 'd', 'a']);
  });

  it('handles empty and single-element arrays', () => {
    expect(shuffleArray([])).toEqual([]);
    expect(shuffleArray(['only'])).toEqual(['only']);
  });
});

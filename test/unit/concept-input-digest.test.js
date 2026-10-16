// test/unit/concept-input-digest.test.js
import { describe, it, expect, vi } from 'vitest';
import { digestFromProbes } from '../../srv/lib/concept-input-digest.js';

describe('digestFromProbes', () => {
  const base = [{ t: 'Concepts', max: '2026-10-01T00:00:00Z', n: 5946 }, { t: 'ConceptEdges', max: '2026-09-30T00:00:00Z', n: 12000 }];
  it('is stable for identical probes', () => expect(digestFromProbes(base)).toBe(digestFromProbes(base)));
  it('changes when a count changes', () => {
    const bumped = [{ ...base[0], n: 5947 }, base[1]];
    expect(digestFromProbes(bumped)).not.toBe(digestFromProbes(base));
  });
  it('changes when a max timestamp changes', () => {
    const bumped = [{ ...base[0], max: '2026-10-02T00:00:00Z' }, base[1]];
    expect(digestFromProbes(bumped)).not.toBe(digestFromProbes(base));
  });
  it('is order-independent', () => expect(digestFromProbes([base[1], base[0]])).toBe(digestFromProbes(base)));
});

import { describe, it, expect } from 'vitest';
import { visibleCollections, type Collection } from './collections';

const rows: Collection[] = [
  { slug: 'a', title: 'A', intro: 'ia', sortOrder: 20, items: [{ url: 'u1', name: 'n1' }] },
  { slug: 'b', title: 'B', intro: 'ib', sortOrder: 10, items: [] },
  { slug: 'c', title: 'C', intro: 'ic', sortOrder: 5, items: [{ url: 'u2', name: 'n2' }] },
];

describe('visibleCollections', () => {
  it('drops empty collections and sorts by sortOrder', () => {
    const out = visibleCollections(rows);
    expect(out.map((c) => c.slug)).toEqual(['c', 'a']); // b dropped (no items), sorted 5,20
  });
  it('returns [] for undefined input', () => {
    expect(visibleCollections(undefined)).toEqual([]);
  });
});

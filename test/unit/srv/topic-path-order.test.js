import { describe, it, expect } from 'vitest';
import { orderConcepts } from '../../../srv/lib/topic-path-order.js';

const rank = new Map([['a',0.9],['b',0.5],['c',0.3],['d',0.1]]);

describe('orderConcepts', () => {
  it('puts prerequisites before dependents (path mode)', () => {
    const concepts = [{slug:'a',name:'A'},{slug:'b',name:'B'},{slug:'c',name:'C'},{slug:'d',name:'D'}];
    // c requires a; d requires c; b requires a  => a before b/c, c before d
    const requiresEdges = [{source:'c',target:'a'},{source:'d',target:'c'},{source:'b',target:'a'}];
    const { ordered, mode } = orderConcepts({ concepts, requiresEdges, rankBySlug: rank });
    expect(mode).toBe('path');
    const pos = (s) => ordered.findIndex((x) => x.slug === s);
    expect(pos('a')).toBeLessThan(pos('c'));
    expect(pos('c')).toBeLessThan(pos('d'));
    expect(pos('a')).toBeLessThan(pos('b'));
  });

  it('falls back to PageRank order (ranked mode) when requires data is too thin', () => {
    const concepts = [{slug:'a',name:'A'},{slug:'b',name:'B'},{slug:'c',name:'C'},{slug:'d',name:'D'}];
    const requiresEdges = []; // no edges
    const { ordered, mode } = orderConcepts({ concepts, requiresEdges, rankBySlug: rank });
    expect(mode).toBe('ranked');
    expect(ordered.map((x) => x.slug)).toEqual(['a','b','c','d']); // pagerank desc
  });

  it('breaks cycles by higher PageRank first without dropping nodes', () => {
    const concepts = [{slug:'a',name:'A'},{slug:'b',name:'B'},{slug:'c',name:'C'}];
    const requiresEdges = [{source:'a',target:'b'},{source:'b',target:'a'},{source:'c',target:'a'}]; // a<->b cycle
    const { ordered } = orderConcepts({ concepts, requiresEdges, rankBySlug: rank });
    expect(ordered).toHaveLength(3); // all present despite cycle
    expect(new Set(ordered.map((x) => x.slug))).toEqual(new Set(['a','b','c']));
  });
});

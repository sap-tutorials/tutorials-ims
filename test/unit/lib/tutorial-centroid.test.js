// test/unit/lib/tutorial-centroid.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { __resetForTest, averageVectors, getCentroid, getCentroidBulk } from '../../../srv/lib/tutorial-centroid.js';

beforeEach(() => __resetForTest());

describe('averageVectors', () => {
  it('averages element-wise into Float32Array', () => {
    const v1 = new Float32Array([1, 2, 3]);
    const v2 = new Float32Array([3, 4, 5]);
    const out = averageVectors([v1, v2]);
    expect(Array.from(out)).toEqual([2, 3, 4]);
    expect(out).toBeInstanceOf(Float32Array);
  });

  it('returns null on empty input', () => {
    expect(averageVectors([])).toBeNull();
  });

  it('skips dim-mismatched rows but keeps going', () => {
    const v1 = new Float32Array([1, 1, 1]);
    const bad = new Float32Array([5, 5]);
    const v2 = new Float32Array([3, 3, 3]);
    const out = averageVectors([v1, bad, v2]);
    expect(Array.from(out)).toEqual([2, 2, 2]);
  });
});

describe('getCentroid LRU', () => {
  it('returns same Float32Array reference on second call within TTL (cache hit)', async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return [new Float32Array([1, 2, 3])];
    };
    const a = await getCentroid('tutA', loader);
    const b = await getCentroid('tutA', loader);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('returns null when loader yields no rows', async () => {
    const out = await getCentroid('empty', async () => []);
    expect(out).toBeNull();
  });
});

describe('getCentroidBulk', () => {
  it('returns one centroid per requested ID in a single bulk call', async () => {
    let bulkCalls = 0;
    const loadBulk = async (ids) => {
      bulkCalls += 1;
      const m = new Map();
      for (const id of ids) m.set(id, [new Float32Array([id, id, id])]);
      return m;
    };
    const out = await getCentroidBulk([1, 2, 3], loadBulk);
    expect(bulkCalls).toBe(1);
    expect(Array.from(out.get(1))).toEqual([1, 1, 1]);
    expect(Array.from(out.get(2))).toEqual([2, 2, 2]);
    expect(Array.from(out.get(3))).toEqual([3, 3, 3]);
  });

  it('serves cache hits without invoking the bulk loader', async () => {
    // Warm cache via getCentroid
    await getCentroid('A', async () => [new Float32Array([1, 0, 0])]);
    let bulkCalls = 0;
    const loadBulk = async () => { bulkCalls += 1; return new Map(); };
    const out = await getCentroidBulk(['A'], loadBulk);
    expect(bulkCalls).toBe(0);
    expect(Array.from(out.get('A'))).toEqual([1, 0, 0]);
  });

  it('only fetches the cache-miss subset', async () => {
    await getCentroid('warm', async () => [new Float32Array([2, 0, 0])]);
    const seen = [];
    const loadBulk = async (ids) => {
      seen.push(...ids);
      const m = new Map();
      m.set('cold', [new Float32Array([0, 3, 0])]);
      return m;
    };
    const out = await getCentroidBulk(['warm', 'cold'], loadBulk);
    expect(seen).toEqual(['cold']);
    expect(Array.from(out.get('warm'))).toEqual([2, 0, 0]);
    expect(Array.from(out.get('cold'))).toEqual([0, 3, 0]);
  });

  it('records nulls for IDs with no embeddings and caches them', async () => {
    let bulkCalls = 0;
    const loadBulk = async () => { bulkCalls += 1; return new Map(); };
    const first = await getCentroidBulk(['missing'], loadBulk);
    expect(first.get('missing')).toBeNull();
    // Second call: null is cached, no bulk fetch.
    const second = await getCentroidBulk(['missing'], loadBulk);
    expect(second.get('missing')).toBeNull();
    expect(bulkCalls).toBe(1);
  });

  it('returns an empty map for empty / nullish input', async () => {
    const a = await getCentroidBulk([], async () => new Map());
    expect(a.size).toBe(0);
    const b = await getCentroidBulk(null, async () => new Map());
    expect(b.size).toBe(0);
  });

  it('dedups duplicate IDs', async () => {
    const seen = [];
    const loadBulk = async (ids) => {
      seen.push([...ids]);
      const m = new Map();
      for (const id of ids) m.set(id, [new Float32Array([id, 0, 0])]);
      return m;
    };
    const out = await getCentroidBulk([7, 7, 7], loadBulk);
    expect(seen).toEqual([[7]]);
    expect(out.size).toBe(1);
    expect(Array.from(out.get(7))).toEqual([7, 0, 0]);
  });
});

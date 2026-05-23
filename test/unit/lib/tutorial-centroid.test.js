// test/unit/lib/tutorial-centroid.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { __resetForTest, averageVectors, getCentroid } from '../../../srv/lib/tutorial-centroid.js';

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

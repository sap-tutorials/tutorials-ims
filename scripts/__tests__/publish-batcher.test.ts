import { describe, it, expect, vi } from 'vitest';
import { chunk, runConcurrent } from '../lib/publish-batcher.js';

describe('chunk', () => {
  it('splits into batches of given size with the last batch potentially smaller', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1], 5)).toEqual([[1]]);
  });
});

describe('runConcurrent', () => {
  it('honors the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 12 }, (_, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    const results = await runConcurrent(tasks, 4);
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('a failing task does not starve the pool — fail-fast on first error', async () => {
    const tasks = [
      async () => { throw new Error('boom'); },
      async () => 'a',
      async () => 'b',
    ];
    await expect(runConcurrent(tasks, 2)).rejects.toThrow('boom');
  });

  it('returns results in input order', async () => {
    const tasks = [10, 20, 30, 40].map((n, i) => async () => {
      await new Promise(r => setTimeout(r, n));
      return i;
    });
    const results = await runConcurrent(tasks, 2);
    expect(results).toEqual([0, 1, 2, 3]);
  });
});

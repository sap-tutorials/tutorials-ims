// srv/lib/__tests__/category-seed-embeddings.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the embedding-client BEFORE the cache module imports it.
vi.mock('../embedding-client.js', () => ({
  embed: vi.fn(async (inputs) =>
    inputs.map((_, i) => new Float32Array([0.1 * (i + 1), 0.2, 0.3]))
  ),
}));

// Mock cds — getSeedEmbeddings reads Categories rows.
vi.mock('@sap/cds', () => {
  const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });
  log.info = vi.fn();
  return {
    default: {
      log,
      entities: () => ({
        Categories: { name: 'Categories' },
      }),
    },
  };
});

// Stub global SELECT used by the cache.
beforeEach(() => {
  globalThis.SELECT = {
    from: () => ({
      columns: () => Promise.resolve([
        { ID: 'cat-1', seedDescription: 'AI and ML' },
        { ID: 'cat-2', seedDescription: 'CAP and ABAP' },
      ]),
    }),
  };
});

import { getSeedEmbeddings, invalidateSeedEmbedding, embedAdHoc, _resetCache } from '../category-seed-embeddings.js';
import { embed } from '../embedding-client.js';

describe('category-seed-embeddings', () => {
  beforeEach(() => {
    _resetCache();
    embed.mockClear();
  });

  it('lazy-loads on first call and caches', async () => {
    const m1 = await getSeedEmbeddings();
    const m2 = await getSeedEmbeddings();
    expect(m1).toBe(m2);                         // same Map instance
    expect(m1.size).toBe(2);
    expect(embed).toHaveBeenCalledTimes(1);      // not called twice
  });

  it('invalidates one entry and recomputes only that one on next call', async () => {
    await getSeedEmbeddings();
    invalidateSeedEmbedding('cat-1');
    const m = await getSeedEmbeddings();
    expect(m.has('cat-1')).toBe(true);
    // Two embed calls: first batch of 2, then 1 for the recompute.
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('embedAdHoc returns a Float32Array', async () => {
    const v = await embedAdHoc('hello world');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBeGreaterThan(0);
  });

  it('skips empty seedDescription entries', async () => {
    globalThis.SELECT = {
      from: () => ({
        columns: () => Promise.resolve([
          { ID: 'cat-3', seedDescription: '' },
          { ID: 'cat-4', seedDescription: 'real text' },
        ]),
      }),
    };
    _resetCache();
    embed.mockClear();
    const m = await getSeedEmbeddings();
    expect(m.has('cat-3')).toBe(false);          // skipped
    expect(m.has('cat-4')).toBe(true);
  });
});

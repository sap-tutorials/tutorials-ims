import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PreviewCache } from '../../../srv/lib/tag-import/preview-cache.js';

describe('PreviewCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stores and retrieves a value by token', () => {
    const cache = new PreviewCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.set('tok1', { rows: [1, 2] });
    expect(cache.get('tok1')).toEqual({ rows: [1, 2] });
  });

  it('returns undefined for unknown token', () => {
    const cache = new PreviewCache({ ttlMs: 60_000, maxEntries: 10 });
    expect(cache.get('nope')).toBeUndefined();
  });

  it('expires entries after ttlMs', () => {
    const cache = new PreviewCache({ ttlMs: 1000, maxEntries: 10 });
    cache.set('tok1', { rows: [] });
    vi.advanceTimersByTime(1001);
    expect(cache.get('tok1')).toBeUndefined();
  });

  it('evicts oldest entry once maxEntries exceeded (FIFO)', () => {
    const cache = new PreviewCache({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('lazily removes expired entry on read', () => {
    const cache = new PreviewCache({ ttlMs: 1000, maxEntries: 10 });
    cache.set('tok1', { rows: [] });
    vi.advanceTimersByTime(1001);
    cache.get('tok1');
    expect(cache.size()).toBe(0);
  });
});

// test/unit/kg-neighborhood-cache.test.js
//
// Unit tests for the neighborhood LRU response cache. Pure JS, no DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedNeighborhood,
  setCachedNeighborhood,
  bustNeighborhoodCache,
  _cacheStats,
  _makeKey,
} from '../../srv/lib/kg-neighborhood-cache.js';

beforeEach(() => {
  bustNeighborhoodCache();
});

describe('kg-neighborhood-cache', () => {
  it('returns undefined on miss', () => {
    expect(getCachedNeighborhood('any-slug', 'v1')).toBeUndefined();
  });

  it('returns the stored value on hit', () => {
    const value = { tutorial: { slug: 'a', title: 'A' }, teaches: [] };
    setCachedNeighborhood('a', 'v1', value);
    expect(getCachedNeighborhood('a', 'v1')).toBe(value);
  });

  it('keys are graphVersion-aware: same slug + different version = miss', () => {
    setCachedNeighborhood('a', 'v1', { tag: 'v1' });
    expect(getCachedNeighborhood('a', 'v2')).toBeUndefined();
    expect(getCachedNeighborhood('a', 'v1')).toEqual({ tag: 'v1' });
  });

  it('keys are slug-aware: same version + different slug = miss', () => {
    setCachedNeighborhood('a', 'v1', { tag: 'a' });
    expect(getCachedNeighborhood('b', 'v1')).toBeUndefined();
  });

  it('bustNeighborhoodCache clears every entry', () => {
    setCachedNeighborhood('a', 'v1', 1);
    setCachedNeighborhood('b', 'v1', 2);
    setCachedNeighborhood('c', 'v2', 3);
    bustNeighborhoodCache();
    expect(getCachedNeighborhood('a', 'v1')).toBeUndefined();
    expect(getCachedNeighborhood('b', 'v1')).toBeUndefined();
    expect(getCachedNeighborhood('c', 'v2')).toBeUndefined();
    expect(_cacheStats().size).toBe(0);
  });

  it('TTL expiry: entries older than 5 min return undefined', () => {
    vi.useFakeTimers();
    try {
      setCachedNeighborhood('a', 'v1', { fresh: true });
      // Just under TTL — still cached.
      vi.advanceTimersByTime(4 * 60 * 1000 + 59_000);
      expect(getCachedNeighborhood('a', 'v1')).toEqual({ fresh: true });
      // Cross the boundary.
      vi.advanceTimersByTime(2_000);
      expect(getCachedNeighborhood('a', 'v1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('LRU: at capacity, oldest entry is evicted on new insert', () => {
    const { maxEntries } = _cacheStats();
    // Fill to capacity. slug-0 is oldest by insertion order.
    for (let i = 0; i < maxEntries; i++) {
      setCachedNeighborhood(`slug-${i}`, 'v1', i);
    }
    expect(_cacheStats().size).toBe(maxEntries);
    // Insert one more — slug-0 (oldest, never touched since insert) gets evicted.
    setCachedNeighborhood(`slug-${maxEntries}`, 'v1', maxEntries);
    expect(getCachedNeighborhood('slug-0', 'v1')).toBeUndefined();
    // slug-1 still cached.
    expect(getCachedNeighborhood('slug-1', 'v1')).toBe(1);
    // Cache remained at capacity — new entry replaced the evicted one.
    expect(_cacheStats().size).toBe(maxEntries);
  });

  it('LRU: hit moves entry to tail (fresh eviction pressure)', () => {
    const { maxEntries } = _cacheStats();
    for (let i = 0; i < maxEntries; i++) {
      setCachedNeighborhood(`slug-${i}`, 'v1', i);
    }
    // Touch slug-0 — should move to tail, no longer the eviction candidate.
    expect(getCachedNeighborhood('slug-0', 'v1')).toBe(0);
    // Insert one more; slug-1 (now the oldest) should be evicted, not slug-0.
    setCachedNeighborhood(`slug-${maxEntries}`, 'v1', maxEntries);
    expect(getCachedNeighborhood('slug-0', 'v1')).toBe(0);
    expect(getCachedNeighborhood('slug-1', 'v1')).toBeUndefined();
  });

  it('re-setting the same key does not double-count against capacity', () => {
    const { maxEntries } = _cacheStats();
    for (let i = 0; i < maxEntries; i++) {
      setCachedNeighborhood(`slug-${i}`, 'v1', i);
    }
    setCachedNeighborhood('slug-5', 'v1', 'updated');
    expect(_cacheStats().size).toBe(maxEntries);
    expect(getCachedNeighborhood('slug-5', 'v1')).toBe('updated');
  });

  describe('bucket parameter', () => {
    it('bucket isolation: setting in "full" does not populate "default"', () => {
      const x = { tag: 'full-value' };
      setCachedNeighborhood('a', 'v1', x, 'full');
      expect(getCachedNeighborhood('a', 'v1', 'default')).toBeUndefined();
      expect(getCachedNeighborhood('a', 'v1', 'full')).toBe(x);
    });

    it('cross-bucket isolation: default and full hold independent values for the same (slug, version)', () => {
      const X = { bucket: 'default' };
      const Y = { bucket: 'full' };
      setCachedNeighborhood('a', 'v1', X, 'default');
      setCachedNeighborhood('a', 'v1', Y, 'full');
      expect(getCachedNeighborhood('a', 'v1', 'default')).toBe(X);
      expect(getCachedNeighborhood('a', 'v1', 'full')).toBe(Y);
    });

    it('global bust wipes every bucket', () => {
      setCachedNeighborhood('a', 'v1', 1, 'default');
      setCachedNeighborhood('a', 'v1', 2, 'full');
      bustNeighborhoodCache();
      expect(getCachedNeighborhood('a', 'v1', 'default')).toBeUndefined();
      expect(getCachedNeighborhood('a', 'v1', 'full')).toBeUndefined();
      expect(_cacheStats().size).toBe(0);
    });

    it('backward-compat: 2-arg get/set behaves like the implicit "default" bucket', () => {
      const x = { legacy: true };
      setCachedNeighborhood('a', 'v1', x);
      // Explicit 'default' should find the same entry the legacy call wrote.
      expect(getCachedNeighborhood('a', 'v1', 'default')).toBe(x);
      // And the legacy get finds an entry written with explicit 'default'.
      const y = { legacy: false };
      setCachedNeighborhood('b', 'v1', y, 'default');
      expect(getCachedNeighborhood('b', 'v1')).toBe(y);
    });

    it('_makeKey is stable/deterministic and bucket-sensitive', () => {
      expect(_makeKey('a', 'v1', 'full')).toBe(_makeKey('a', 'v1', 'full'));
      expect(_makeKey('a', 'v1', 'full')).not.toBe(_makeKey('a', 'v1', 'default'));
      // Legacy 2-arg call collapses to the 'default' bucket.
      expect(_makeKey('a', 'v1')).toBe(_makeKey('a', 'v1', 'default'));
    });

    it('rejects unknown bucket names on set', () => {
      expect(() => setCachedNeighborhood('a', 'v1', 1, 'nope')).toThrow(/bucket/i);
    });

    it('rejects unknown bucket names on get', () => {
      expect(() => getCachedNeighborhood('a', 'v1', 'nope')).toThrow(/bucket/i);
    });
  });
});

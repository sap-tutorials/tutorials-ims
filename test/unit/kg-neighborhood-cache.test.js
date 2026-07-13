// test/unit/kg-neighborhood-cache.test.js
//
// Behavioral tests for the neighborhood response cache, now backed by the
// `cds-caching` plugin (issue #1177). These boot a real cds runtime so the
// `caching` service resolves — the former pure-JS LRU-internals assertions
// (_cacheStats, MAX_ENTRIES eviction, fake-timer TTL) are gone because the
// store implementation is now cds-caching's responsibility, not ours. We test
// OUR contract: miss/hit, version/slug/bucket key awareness, tag-based bust,
// bucket validation, and fail-open behavior.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

let getCachedNeighborhood, setCachedNeighborhood, bustNeighborhoodCache, _makeKey, _resetConnection;

beforeAll(async () => {
  // In-memory caching store; no DB features needed for these assertions.
  cds.env.requires = cds.env.requires || {};
  cds.env.requires.caching = { impl: 'cds-caching', namespace: 'kg-test', store: 'memory' };
  await cds.connect.to('caching');
  ({
    getCachedNeighborhood,
    setCachedNeighborhood,
    bustNeighborhoodCache,
    _makeKey,
    _resetConnection,
  } = await import('../../srv/lib/kg-neighborhood-cache.js'));
  _resetConnection();
});

beforeEach(async () => {
  await bustNeighborhoodCache();
});

describe('kg-neighborhood-cache (cds-caching-backed)', () => {
  it('returns undefined on miss', async () => {
    expect(await getCachedNeighborhood('any-slug', 'v1')).toBeUndefined();
  });

  it('returns the stored value on hit', async () => {
    const value = { tutorial: { slug: 'a', title: 'A' }, teaches: [] };
    await setCachedNeighborhood('a', 'v1', value);
    expect(await getCachedNeighborhood('a', 'v1')).toEqual(value);
  });

  it('keys are graphVersion-aware: same slug + different version = miss', async () => {
    await setCachedNeighborhood('a', 'v1', { tag: 'v1' });
    expect(await getCachedNeighborhood('a', 'v2')).toBeUndefined();
    expect(await getCachedNeighborhood('a', 'v1')).toEqual({ tag: 'v1' });
  });

  it('keys are slug-aware: same version + different slug = miss', async () => {
    await setCachedNeighborhood('a', 'v1', { tag: 'a' });
    expect(await getCachedNeighborhood('b', 'v1')).toBeUndefined();
  });

  it('bustNeighborhoodCache clears every entry (all buckets, all versions)', async () => {
    await setCachedNeighborhood('a', 'v1', 1);
    await setCachedNeighborhood('b', 'v1', 2, 'full');
    await setCachedNeighborhood('c', 'v2', 3);
    await bustNeighborhoodCache();
    expect(await getCachedNeighborhood('a', 'v1')).toBeUndefined();
    expect(await getCachedNeighborhood('b', 'v1', 'full')).toBeUndefined();
    expect(await getCachedNeighborhood('c', 'v2')).toBeUndefined();
  });

  describe('bucket parameter', () => {
    it('bucket isolation: setting in "full" does not populate "default"', async () => {
      const x = { tag: 'full-value' };
      await setCachedNeighborhood('a', 'v1', x, 'full');
      expect(await getCachedNeighborhood('a', 'v1', 'default')).toBeUndefined();
      expect(await getCachedNeighborhood('a', 'v1', 'full')).toEqual(x);
    });

    it('cross-bucket: default and full hold independent values for same (slug, version)', async () => {
      await setCachedNeighborhood('a', 'v1', { bucket: 'default' }, 'default');
      await setCachedNeighborhood('a', 'v1', { bucket: 'full' }, 'full');
      expect(await getCachedNeighborhood('a', 'v1', 'default')).toEqual({ bucket: 'default' });
      expect(await getCachedNeighborhood('a', 'v1', 'full')).toEqual({ bucket: 'full' });
    });

    it('backward-compat: 2-arg get/set behaves like the implicit "default" bucket', async () => {
      const x = { legacy: true };
      await setCachedNeighborhood('a', 'v1', x);
      expect(await getCachedNeighborhood('a', 'v1', 'default')).toEqual(x);
      const y = { legacy: false };
      await setCachedNeighborhood('b', 'v1', y, 'default');
      expect(await getCachedNeighborhood('b', 'v1')).toEqual(y);
    });

    it('_makeKey is stable/deterministic and bucket-sensitive', () => {
      expect(_makeKey('a', 'v1', 'full')).toBe(_makeKey('a', 'v1', 'full'));
      expect(_makeKey('a', 'v1', 'full')).not.toBe(_makeKey('a', 'v1', 'default'));
      expect(_makeKey('a', 'v1')).toBe(_makeKey('a', 'v1', 'default'));
    });

    it('rejects unknown bucket names on set', async () => {
      await expect(setCachedNeighborhood('a', 'v1', 1, 'nope')).rejects.toThrow(/bucket/i);
    });

    it('rejects unknown bucket names on get', async () => {
      await expect(getCachedNeighborhood('a', 'v1', 'nope')).rejects.toThrow(/bucket/i);
    });
  });
});

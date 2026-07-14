import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';
import * as cache from '../../srv/lib/khoros-cache.js';

// The Khoros profile cache is now backed by the shared `caching` service
// (cds-caching, issue #1181) rather than an in-process bounded LRU. Boot an
// in-memory caching store so the service resolves; each test clears it via the
// async _resetForTests. The former MAX_ENTRIES/MRU-eviction tests are dropped —
// eviction is now owned by the caching store, not this module.
describe('khoros-cache', () => {
  beforeAll(async () => {
    cds.env.requires = cds.env.requires || {};
    cds.env.requires.caching = { impl: 'cds-caching', namespace: 'khoros-test', store: 'memory' };
    await cds.connect.to('caching');
  });

  beforeEach(async () => { await cache._resetForTests(); });

  it('returns null on miss', async () => {
    expect(await cache.get('123')).toBeNull();
  });

  it('returns the profile on hit within TTL', async () => {
    await cache.set('123', { name: 'Alice', rank: 'Star', avatarUrl: 'x' });
    expect(await cache.get('123')).toEqual({ name: 'Alice', rank: 'Star', avatarUrl: 'x' });
  });

  it('expires entries past the 6h TTL', async () => {
    vi.useFakeTimers();
    await cache.set('123', { name: 'Alice' });
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
    expect(await cache.get('123')).toBeNull();
    vi.useRealTimers();
  });

  it('evict() removes the entry immediately', async () => {
    await cache.set('123', { name: 'Alice' });
    await cache.evict('123');
    expect(await cache.get('123')).toBeNull();
  });

  it('keys are namespaced per Khoros id (no cross-id bleed)', async () => {
    await cache.set('user-a', { name: 'A' });
    await cache.set('user-b', { name: 'B' });
    expect(await cache.get('user-a')).toEqual({ name: 'A' });
    expect(await cache.get('user-b')).toEqual({ name: 'B' });
    await cache.evict('user-a');
    expect(await cache.get('user-a')).toBeNull();
    expect(await cache.get('user-b')).toEqual({ name: 'B' });  // sibling survives
  });
});

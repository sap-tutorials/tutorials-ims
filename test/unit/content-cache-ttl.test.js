import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContentCache, DEFAULT_CONTENT_CACHE_TTL_MS } from '../../srv/lib/content-store.js';

// #2232: the content LRU must not strand stale HTML indefinitely when a
// cross-instance coherence bump (#1621) is missed on this instance. A per-entry
// TTL is the time-based backstop — an entry expires on read after
// CONTENT_CACHE_TTL_MS even though invalidate()/bumpCacheGeneration() was never
// observed here. Deterministic time via fake timers so the TTL is exercised
// without real waits.

describe('ContentCache TTL backstop (#2232)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('serves a fresh entry within the TTL window', () => {
    const cache = new ContentCache(1024, 5000);
    cache.set('slug', Buffer.from('html'), 'hash1');
    vi.setSystemTime(4999);
    const hit = cache.get('slug');
    expect(hit).not.toBeNull();
    expect(hit.hash).toBe('hash1');
  });

  it('expires a stranded entry on read after the TTL (missed coherence bump)', () => {
    const cache = new ContentCache(1024, 5000);
    // Populate with stale bytes as if a peer instance later republished but
    // this instance never observed the generation bump — no invalidate() call.
    cache.set('slug', Buffer.from('stale-bytes'), 'stale-hash');
    vi.setSystemTime(5000);
    // Time-based backstop kicks in: read returns a miss, so the caller reloads
    // the current bytes from the DB instead of serving stale forever.
    expect(cache.get('slug')).toBeNull();
    // Byte accounting is reclaimed so the LRU budget stays accurate.
    expect(cache.totalBytes).toBe(0);
  });

  it('a re-set entry refreshes its expiry (active republish never expires mid-serve)', () => {
    const cache = new ContentCache(1024, 5000);
    cache.set('slug', Buffer.from('v1'), 'h1');
    vi.setSystemTime(3000);
    cache.set('slug', Buffer.from('v2'), 'h2'); // fresh publish repopulates
    vi.setSystemTime(7000);                      // 4s after the re-set, inside TTL
    expect(cache.get('slug')?.hash).toBe('h2');
  });

  it('ttlMs <= 0 disables expiry (entries live until evict/invalidate)', () => {
    const cache = new ContentCache(1024, 0);
    cache.set('slug', Buffer.from('html'), 'h');
    vi.setSystemTime(60 * 60 * 1000); // an hour later
    expect(cache.get('slug')?.hash).toBe('h');
  });

  it('applies the same TTL to render:<slug> catalog entries', () => {
    const cache = new ContentCache(1024, 5000);
    cache.set('render:group-foo', Buffer.from('catalog'), 'ch');
    vi.setSystemTime(5001);
    expect(cache.get('render:group-foo')).toBeNull();
  });

  it('defaults to a bounded 5-minute window', () => {
    expect(DEFAULT_CONTENT_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    const cache = new ContentCache();
    expect(cache.ttlMs).toBe(DEFAULT_CONTENT_CACHE_TTL_MS);
  });
});

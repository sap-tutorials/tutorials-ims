import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as cache from '../../srv/lib/khoros-cache.js';

describe('khoros-cache', () => {
  beforeEach(() => { cache._resetForTests(); });

  it('returns null on miss', () => {
    expect(cache.get('123')).toBeNull();
  });

  it('returns the profile on hit within TTL', () => {
    cache.set('123', { name: 'Alice', rank: 'Star', avatarUrl: 'x' });
    expect(cache.get('123')).toEqual({ name: 'Alice', rank: 'Star', avatarUrl: 'x' });
  });

  it('expires entries past the 6h TTL', () => {
    vi.useFakeTimers();
    cache.set('123', { name: 'Alice' });
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
    expect(cache.get('123')).toBeNull();
    vi.useRealTimers();
  });

  it('bumps an entry to MRU on get', () => {
    for (let i = 0; i < 500; i++) cache.set(`k${i}`, { i });
    cache.get('k0');                              // k0 → MRU
    cache.set('k500', { i: 500 });                // forces an eviction
    expect(cache.get('k0')).not.toBeNull();       // k0 survived
    expect(cache.get('k1')).toBeNull();           // k1 was the new oldest
  });

  it('evicts the oldest entry when over capacity', () => {
    for (let i = 0; i < 501; i++) cache.set(`k${i}`, { i });
    expect(cache.get('k0')).toBeNull();
    expect(cache.get('k500')).toEqual({ i: 500 });
  });

  it('evict() removes the entry immediately', () => {
    cache.set('123', { name: 'Alice' });
    cache.evict('123');
    expect(cache.get('123')).toBeNull();
  });
});

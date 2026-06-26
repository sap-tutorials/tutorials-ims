import { describe, it, expect, beforeEach } from 'vitest';
import { getCached, setCached, invalidate, _resetForTests } from '../alerts-cache.js';

describe('alerts-cache', () => {
  beforeEach(() => _resetForTests());

  it('returns null on cache miss', () => {
    expect(getCached('public:anon')).toBeNull();
  });

  it('returns stored value within TTL', () => {
    setCached('public:anon', [{ id: 'a' }]);
    expect(getCached('public:anon')).toEqual([{ id: 'a' }]);
  });

  it('invalidate() drops all entries', () => {
    setCached('public:anon', [{ id: 'a' }]);
    setCached('me:authenticated', [{ id: 'b' }]);
    invalidate();
    expect(getCached('public:anon')).toBeNull();
    expect(getCached('me:authenticated')).toBeNull();
  });

  it('respects TTL (default 60s)', async () => {
    setCached('k', [1], 50); // 50ms TTL for test speed
    expect(getCached('k')).toEqual([1]);
    await new Promise(r => setTimeout(r, 70));
    expect(getCached('k')).toBeNull();
  });
});

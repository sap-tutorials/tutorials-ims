import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as coherence from '../../srv/lib/content-cache-coherence.js';

// Unit tests for the cross-instance catalog-cache generation (#1592).
// Single-process: we simulate a "peer instance" by writing the shared token
// directly into the fake caching store, bypassing our own bump (which would
// otherwise adopt the token locally). Deterministic time via fake timers so
// the TTL gate is exercised without real waits.

function makeFakeCaching() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.get(k); },
    async set(k, v) { store.set(k, v); },
  };
}

describe('content-cache-coherence (#1592, #1621)', () => {
  beforeEach(() => {
    coherence._resetForTest();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    coherence._resetForTest();
  });

  it('fires local invalidators when a peer bumps the generation', async () => {
    const fake = makeFakeCaching();
    coherence._setCachingForTest(fake);
    let fired = 0;
    coherence.onCacheGenerationChange(() => { fired += 1; });

    await fake.set(coherence.GEN_KEY, 'peer-gen-1'); // peer instance bumped
    vi.setSystemTime(coherence.CHECK_TTL_MS + 1);     // past the TTL gate
    await coherence.refreshCacheGeneration();
    expect(fired).toBe(1);

    // Unchanged generation → past TTL again → no additional fire.
    vi.setSystemTime((coherence.CHECK_TTL_MS + 1) * 2);
    await coherence.refreshCacheGeneration();
    expect(fired).toBe(1);
  });

  it('is TTL-gated: at most one shared read per window', async () => {
    const fake = makeFakeCaching();
    const getSpy = vi.spyOn(fake, 'get');
    coherence._setCachingForTest(fake);

    vi.setSystemTime(coherence.CHECK_TTL_MS + 1);
    await coherence.refreshCacheGeneration(); // reads
    await coherence.refreshCacheGeneration(); // within TTL → gated, no read
    await coherence.refreshCacheGeneration();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-invalidate the instance that bumped', async () => {
    const fake = makeFakeCaching();
    coherence._setCachingForTest(fake);
    let fired = 0;
    coherence.onCacheGenerationChange(() => { fired += 1; });

    vi.setSystemTime(coherence.CHECK_TTL_MS + 1);
    await coherence.bumpCacheGeneration();     // this instance adopts the token
    vi.setSystemTime((coherence.CHECK_TTL_MS + 1) * 2);
    await coherence.refreshCacheGeneration();  // reads own token → no change
    expect(fired).toBe(0);
  });

  it('detects a peer bump that lands after our own bump', async () => {
    const fake = makeFakeCaching();
    coherence._setCachingForTest(fake);
    let fired = 0;
    coherence.onCacheGenerationChange(() => { fired += 1; });

    vi.setSystemTime(coherence.CHECK_TTL_MS + 1);
    await coherence.bumpCacheGeneration();       // local token adopted, no fire
    await fake.set(coherence.GEN_KEY, 'peer-newer'); // peer overwrites
    vi.setSystemTime((coherence.CHECK_TTL_MS + 1) * 2);
    await coherence.refreshCacheGeneration();
    expect(fired).toBe(1);
  });

  it('fail-open: a caching read error never throws and never invalidates', async () => {
    const fake = { async get() { throw new Error('caching down'); }, async set() {} };
    coherence._setCachingForTest(fake);
    let fired = 0;
    coherence.onCacheGenerationChange(() => { fired += 1; });

    vi.setSystemTime(coherence.CHECK_TTL_MS + 1);
    await expect(coherence.refreshCacheGeneration()).resolves.toBeUndefined();
    expect(fired).toBe(0);
  });

  it('fail-open: a caching write error never throws out of bump', async () => {
    const fake = { async get() { return undefined; }, async set() { throw new Error('caching down'); } };
    coherence._setCachingForTest(fake);
    vi.setSystemTime(coherence.CHECK_TTL_MS + 1);
    await expect(coherence.bumpCacheGeneration()).resolves.toMatch(/^\d+-\d+-\d+$/);
  });

  it('no-op while the generation was never established (null token)', async () => {
    const fake = makeFakeCaching(); // empty store → get returns undefined
    coherence._setCachingForTest(fake);
    let fired = 0;
    coherence.onCacheGenerationChange(() => { fired += 1; });
    vi.setSystemTime(coherence.CHECK_TTL_MS + 1);
    await coherence.refreshCacheGeneration();
    expect(fired).toBe(0);
  });
});

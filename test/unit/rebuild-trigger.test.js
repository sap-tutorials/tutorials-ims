/**
 * Unit tests for #429 — opts-based scheduleRebuild + mode-merge + slug-accumulate
 * + credstore-backed token + env fallback.
 *
 * Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md §3
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Note: rebuild-trigger.js imports './credstore.js' lazily inside getDispatchToken.
// vi.mock the module so unit tests don't need a real BTP binding.
vi.mock('../../srv/lib/credstore.js', () => ({
  readSecret: vi.fn().mockResolvedValue(null),  // default: credstore has no value
}));

import { scheduleRebuild, _resetForTests, invalidateDispatchTokenCache } from '../../srv/lib/rebuild-trigger.js';

describe('scheduleRebuild — opts-based signature (#429)', () => {
  let captured;
  let mockDispatch;

  beforeEach(async () => {
    captured = [];
    mockDispatch = vi.fn().mockImplementation(async (inputs) => {
      captured.push(inputs);
      return { status: 204 };
    });
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: 'test-token' });
    // Reset credstore mock
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue(null);
  });

  it('dispatches with mode=full by default (back-compat)', async () => {
    await scheduleRebuild('admin-write');
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
  });

  it('dispatches with mode=catalog-only when passed in opts', async () => {
    await scheduleRebuild('admin-write', { mode: 'catalog-only' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('catalog-only');
  });

  it('upgrades catalog-only → full when a full trigger fires during the window', async () => {
    await scheduleRebuild('a', { mode: 'catalog-only' });
    await scheduleRebuild('b', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
  });

  it('does NOT downgrade full → catalog-only', async () => {
    await scheduleRebuild('a', { mode: 'full' });
    await scheduleRebuild('b', { mode: 'catalog-only' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
  });

  it('upgrades catalog-only → slug-targeted (rank-2 beats rank-1)', async () => {
    await scheduleRebuild('a', { mode: 'catalog-only' });
    await scheduleRebuild('b', { mode: 'slug-targeted', slug: 'tut-x' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('slug-targeted');
    expect(captured[0].slugs).toBe('tut-x');
  });

  it('accumulates slugs across multiple slug-targeted calls', async () => {
    await scheduleRebuild('a', { mode: 'slug-targeted', slug: 'tut-a' });
    await scheduleRebuild('b', { mode: 'slug-targeted', slug: 'tut-b' });
    await scheduleRebuild('c', { mode: 'slug-targeted', slug: 'tut-c' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    const slugs = captured[0].slugs.split(',').sort();
    expect(slugs).toEqual(['tut-a', 'tut-b', 'tut-c']);
  });

  it('dedupes repeated slugs in the accumulator', async () => {
    await scheduleRebuild('a', { mode: 'slug-targeted', slug: 'tut-a' });
    await scheduleRebuild('b', { mode: 'slug-targeted', slug: 'tut-a' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured[0].slugs).toBe('tut-a');
  });

  it('upgrades slug-targeted → full when slug accumulator exceeds 50', async () => {
    for (let i = 0; i < 51; i++) {
      await scheduleRebuild('bulk', { mode: 'slug-targeted', slug: `tut-${i}` });
    }
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
    expect(captured[0].slugs).toBeUndefined();  // slugs cleared on cap
  });

  it('forceCapRefetch is sticky (once set, stays set)', async () => {
    await scheduleRebuild('a', { mode: 'full', forceCapRefetch: true });
    await scheduleRebuild('b', { mode: 'full', forceCapRefetch: false });
    await new Promise(r => setTimeout(r, 30));
    expect(captured[0]['force-cap-refetch']).toBe(true);
  });

  it('does NOT include force-cap-refetch input when never set', async () => {
    await scheduleRebuild('a', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured[0]['force-cap-refetch']).toBeUndefined();
  });

  it('upgrades slug-targeted → full and drops slugs from inputs', async () => {
    await scheduleRebuild('a', { mode: 'slug-targeted', slug: 'tut-x' });
    await scheduleRebuild('b', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('full');
    expect(captured[0].slugs).toBeUndefined();  // slugs only emitted for slug-targeted mode
  });

  it('stays catalog-only across multiple catalog-only calls', async () => {
    await scheduleRebuild('a', { mode: 'catalog-only' });
    await scheduleRebuild('b', { mode: 'catalog-only' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe('catalog-only');
  });
});

describe('scheduleRebuild — token resolution (#429)', () => {
  let captured;
  let mockDispatch;

  beforeEach(() => {
    captured = [];
    mockDispatch = vi.fn().mockImplementation(async (inputs) => {
      captured.push(inputs);
      return { status: 204 };
    });
  });

  it('no-op when neither credstore nor env has a token', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue(null);
    delete process.env.GITHUB_DISPATCH_TOKEN;
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('x', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(0);
  });

  it('uses env fallback when credstore returns null', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue(null);
    process.env.GITHUB_DISPATCH_TOKEN = 'env-token';
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('x', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    delete process.env.GITHUB_DISPATCH_TOKEN;
  });

  it('uses credstore value when available (takes precedence over env)', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue('credstore-token');
    process.env.GITHUB_DISPATCH_TOKEN = 'env-token';
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('x', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(credstore.readSecret).toHaveBeenCalledWith('GITHUB_DISPATCH_TOKEN');
    delete process.env.GITHUB_DISPATCH_TOKEN;
  });

  it('caches the credstore lookup within the 5-min TTL window', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue('cached-token');
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('a', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    await scheduleRebuild('b', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(2);
    // Both dispatches happened, but credstore was only consulted once thanks
    // to the in-memory TTL cache.
    expect(credstore.readSecret).toHaveBeenCalledTimes(1);
  });

  it('falls back to env when credstore throws', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockRejectedValue(new Error('credstore unavailable'));
    process.env.GITHUB_DISPATCH_TOKEN = 'env-fallback';
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });
    await scheduleRebuild('x', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    delete process.env.GITHUB_DISPATCH_TOKEN;
  });
});

describe('invalidateDispatchTokenCache (#429)', () => {
  it('forces the next dispatch to re-read from credstore', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    const mockDispatch = vi.fn().mockResolvedValue({ status: 204 });
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValueOnce('token-v1');
    credstore.readSecret.mockResolvedValueOnce('token-v2');
    _resetForTests({ dispatchFn: mockDispatch, debounceMs: 10, token: null });

    await scheduleRebuild('a', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    expect(credstore.readSecret).toHaveBeenCalledTimes(1);

    invalidateDispatchTokenCache();
    await scheduleRebuild('b', { mode: 'full' });
    await new Promise(r => setTimeout(r, 30));
    // After invalidation, the second dispatch re-reads credstore.
    expect(credstore.readSecret).toHaveBeenCalledTimes(2);
  });
});

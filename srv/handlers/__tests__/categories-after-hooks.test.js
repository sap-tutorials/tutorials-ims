import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decideOnUpdate, makeDebouncedDispatcher } from '../categories-after-hooks.js';

describe('decideOnUpdate', () => {
  it('returns reclassify for title change', () => {
    expect(decideOnUpdate({ title: ['old', 'new'] })).toBe('reclassify');
  });
  it('returns reclassify for description change', () => {
    expect(decideOnUpdate({ description: ['old', 'new'] })).toBe('reclassify');
  });
  it('returns reclassify for primaryTag change', () => {
    expect(decideOnUpdate({ primaryTag: ['old', 'new'] })).toBe('reclassify');
  });
  it('returns skip for unrelated field change', () => {
    expect(decideOnUpdate({ featuredOrder: [1, 2] })).toBe('skip');
  });
  it('returns skip for empty diff', () => {
    expect(decideOnUpdate(null)).toBe('skip');
    expect(decideOnUpdate({})).toBe('skip');
  });
});

describe('makeDebouncedDispatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses two calls within 5s into one', async () => {
    const calls = [];
    const dispatch = makeDebouncedDispatcher({ delayMs: 5000, run: (kind, id) => { calls.push([kind, id]); } });
    dispatch('mission', 'm1');
    vi.advanceTimersByTime(2000);
    dispatch('mission', 'm1');
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['mission', 'm1']]);
  });

  it('separate items debounce independently', () => {
    const calls = [];
    const dispatch = makeDebouncedDispatcher({ delayMs: 5000, run: (kind, id) => { calls.push([kind, id]); } });
    dispatch('mission', 'm1');
    dispatch('mission', 'm2');
    vi.advanceTimersByTime(5000);
    expect(calls.sort()).toEqual([['mission', 'm1'], ['mission', 'm2']]);
  });
});

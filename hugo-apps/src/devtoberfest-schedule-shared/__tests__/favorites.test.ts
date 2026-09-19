import { describe, it, expect, vi, beforeEach } from 'vitest';
import { favKey, isFavorite, favSet, toggleFavorite, loadFavorites } from '../favorites';

describe('favorites store', () => {
  beforeEach(() => { favSet.value = new Set(); vi.restoreAllMocks(); });

  it('favKey is a stable composite', () => {
    expect(favKey('TECHED', 'ai-001')).toBe('TECHED:ai-001');
  });

  it('loadFavorites seeds the set from the feed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, headers: { get: () => 'application/json' },
      json: async () => ({ value: [{ sourceType: 'TECHED', sessionRef: 'ai-001' }] }),
    }));
    await loadFavorites();
    expect(isFavorite('TECHED', 'ai-001')).toBe(true);
    expect(isFavorite('TECHED', 'nope')).toBe(false);
  });

  it('toggleFavorite optimistically adds then reverts on a failed POST', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, headers: { get: () => 'application/json' } }));
    await toggleFavorite('TECHED', 'x-1');
    expect(isFavorite('TECHED', 'x-1')).toBe(false); // reverted
  });

  it('toggleFavorite keeps the change on a successful POST', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, headers: { get: () => 'application/json' }, json: async () => ({ favorited: true }),
    }));
    await toggleFavorite('DEVTOBERFEST', 'd-1');
    expect(isFavorite('DEVTOBERFEST', 'd-1')).toBe(true);
  });
});

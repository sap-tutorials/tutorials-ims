import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchExcludedSlugs } from '../publish-client.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('fetchExcludedSlugs', () => {
  it('returns a lowercased Set of slugs from {slugs:[...]}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ slugs: ['Foo-Bar', 'baz'] }),
    })));
    const set = await fetchExcludedSlugs({ baseUrl: 'http://x' });
    expect(set.has('foo-bar')).toBe(true);
    expect(set.has('baz')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('fails open to empty Set on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const set = await fetchExcludedSlugs({ baseUrl: 'http://x' });
    expect(set.size).toBe(0);
  });

  it('fails open to empty Set on network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const set = await fetchExcludedSlugs({ baseUrl: 'http://x' });
    expect(set.size).toBe(0);
  });
});

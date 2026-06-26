import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveUser, KHOROS_TENANT_PREFIX } from '../../srv/lib/khoros-client.js';

const okEnvelope = (author) => ({
  status: 'success', data: { items: author ? [{ author }] : [] }
});

function mockFetchOnce(body, opts = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: opts.ok !== false,
    status: opts.status || 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

describe('khoros-client.resolveUser', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('fingerprints numeric input as author.id', async () => {
    mockFetchOnce(okEnvelope({
      id: '12345', login: 'thomas_jung',
      first_name: 'Thomas', last_name: 'Jung',
      rank: { name: 'Star' }, avatar: { profile: 'https://x/a.png' }
    }));
    const result = await resolveUser('12345');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('author.id');
    expect(url).toContain('12345');
    expect(result).toEqual({
      id: '12345', login: 'thomas_jung',
      name: 'Thomas Jung', rank: 'Star',
      avatarUrl: 'https://x/a.png'
    });
  });

  it('fingerprints slug input as author.login with dot-to-underscore normalisation', async () => {
    mockFetchOnce(okEnvelope({
      id: '12345', login: 'thomas_jung',
      first_name: 'Thomas', last_name: 'Jung'
    }));
    await resolveUser('thomas.jung');
    expect(global.fetch.mock.calls[0][0]).toContain('thomas_jung');
  });

  it('falls back to dotted login if normalised lookup returns 0', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify(okEnvelope(null)))
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify(okEnvelope({
          id: '1', login: 'foo.bar', first_name: 'F', last_name: 'B'
        })))
      });
    const result = await resolveUser('foo.bar');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toContain('foo_bar');
    expect(global.fetch.mock.calls[1][0]).toContain('foo.bar');
    expect(result?.login).toBe('foo.bar');
  });

  it('returns null when upstream succeeds with 0 items (lurker / unknown)', async () => {
    mockFetchOnce(okEnvelope(null));
    const result = await resolveUser('ghost_user');
    expect(result).toBeNull();
  });

  it('throws on 5xx upstream', async () => {
    mockFetchOnce({}, { ok: false, status: 503 });
    await expect(resolveUser('123')).rejects.toThrow(/upstream/i);
  });

  it('throws when Khoros returns status != success', async () => {
    mockFetchOnce({ status: 'error', message: 'bad' });
    await expect(resolveUser('123')).rejects.toThrow(/khoros/i);
  });

  it('exports KHOROS_TENANT_PREFIX as a single point of change', () => {
    expect(KHOROS_TENANT_PREFIX).toBe('khhcw49343');
  });
});

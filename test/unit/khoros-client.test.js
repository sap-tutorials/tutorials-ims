import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveUser, parseKhorosInput, KHOROS_TENANT_PREFIX } from '../../srv/lib/khoros-client.js';

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

  // Issue #1614 — the UI tells users they can paste their profile URL or its
  // trailing fragment. A pasted "/user-id/11295" was treated as a literal login
  // slug (matched nothing → false "lurkers can't be found").
  it('resolves a pasted "/user-id/NNNN" fragment via author.id', async () => {
    mockFetchOnce(okEnvelope({ id: '11295', login: 'VishnAndr', first_name: 'A', last_name: 'V' }));
    const result = await resolveUser('/user-id/11295');
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('author.id');
    expect(url).toContain('11295');
    expect(result?.id).toBe('11295');
  });

  it('resolves a full profile URL via author.id', async () => {
    mockFetchOnce(okEnvelope({ id: '11295', login: 'VishnAndr', first_name: 'A', last_name: 'V' }));
    await resolveUser('https://community.sap.com/t5/user/viewprofilepage/user-id/11295');
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('author.id');
    expect(url).toContain('11295');
  });

  it('resolves a "/user/<login>" fragment via author.login', async () => {
    mockFetchOnce(okEnvelope({ id: '1', login: 'thomas_jung', first_name: 'T', last_name: 'J' }));
    await resolveUser('/user/thomas_jung');
    expect(global.fetch.mock.calls[0][0]).toContain('thomas_jung');
  });
});

describe('khoros-client.parseKhorosInput', () => {
  it('extracts numeric id from user-id URL/fragment forms', () => {
    expect(parseKhorosInput('11295')).toEqual({ kind: 'id', value: '11295' });
    expect(parseKhorosInput('/user-id/11295')).toEqual({ kind: 'id', value: '11295' });
    expect(parseKhorosInput('user-id/11295')).toEqual({ kind: 'id', value: '11295' });
    expect(parseKhorosInput('https://community.sap.com/t5/user/viewprofilepage/user-id/11295'))
      .toEqual({ kind: 'id', value: '11295' });
  });

  it('extracts login from bare slug and /user/<login> forms', () => {
    expect(parseKhorosInput('VishnAndr')).toEqual({ kind: 'login', value: 'VishnAndr' });
    expect(parseKhorosInput('thomas.jung')).toEqual({ kind: 'login', value: 'thomas.jung' });
    expect(parseKhorosInput('/user/thomas_jung')).toEqual({ kind: 'login', value: 'thomas_jung' });
  });

  it('does not capture "viewprofilepage" as a login when no user-id is present', () => {
    expect(parseKhorosInput('https://community.sap.com/t5/user/viewprofilepage')).toBeNull();
  });

  it('returns null for empty / whitespace input', () => {
    expect(parseKhorosInput('')).toBeNull();
    expect(parseKhorosInput('   ')).toBeNull();
    expect(parseKhorosInput(null)).toBeNull();
  });
});

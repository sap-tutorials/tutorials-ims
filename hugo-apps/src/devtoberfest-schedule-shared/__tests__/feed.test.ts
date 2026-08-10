// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchFeed, fetchMyCompletions } from '../feed';

function mockFetch(res: Partial<Response> & { json?: () => Promise<unknown>; headers?: Headers }) {
  global.fetch = vi.fn(async () => res as unknown as Response) as any;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('fetchMyCompletions (anonymous resilience — #1577)', () => {
  it('returns {authenticated:false} on a non-ok status (clean 401)', async () => {
    mockFetch({ ok: false, status: 401, headers: new Headers() });
    await expect(fetchMyCompletions()).resolves.toEqual({ authenticated: false });
  });

  it('returns {authenticated:false} on a 200 text/html login-redirect (approuter xsuaa gate)', async () => {
    // Regression for #1577: an anonymous request to an xsuaa-gated route can come
    // back 200 with an HTML login page. It must NOT surface as a thrown error.
    mockFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    });
    await expect(fetchMyCompletions()).resolves.toEqual({ authenticated: false });
  });

  it('returns {authenticated:false} when a JSON body unexpectedly fails to parse', async () => {
    // Even if content-type claims JSON, a rejecting r.json() is caught (await guard).
    mockFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.reject(new SyntaxError('boom')),
    });
    await expect(fetchMyCompletions()).resolves.toEqual({ authenticated: false });
  });

  it('parses a real authenticated JSON payload', async () => {
    const payload = { authenticated: true, joined: true, earnedPoints: 500, maxPoints: 800, completedSlugs: ['x'], completedActivityIds: ['a1'] };
    mockFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(payload),
    });
    await expect(fetchMyCompletions()).resolves.toEqual(payload);
  });

  it('parses JSON when the mock omits headers (test-mock compatibility)', async () => {
    // Some app tests mock fetch without a headers object; the guard must fall
    // through and parse rather than bail.
    global.fetch = vi.fn(async () => ({ ok: true, json: () => Promise.resolve({ authenticated: false }) }) as unknown as Response) as any;
    await expect(fetchMyCompletions()).resolves.toEqual({ authenticated: false });
  });
});

describe('fetchFeed', () => {
  it('throws on a non-ok status', async () => {
    mockFetch({ ok: false, status: 503, headers: new Headers() });
    await expect(fetchFeed()).rejects.toThrow('schedule 503');
  });

  it('returns the parsed feed on success', async () => {
    const feed = { activeEditionId: 'e1', editions: [], sessions: [], activities: [] };
    mockFetch({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: () => Promise.resolve(feed) });
    await expect(fetchFeed()).resolves.toEqual(feed);
  });
});

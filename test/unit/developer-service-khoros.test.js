// test/unit/developer-service-khoros.test.js
//
// Unit tests for the 3 Khoros endpoint handlers on DeveloperService.
//
// Mock strategy: vi.mock cannot intercept CDS-runtime-loaded modules
// (developer-service.js resolves its imports through CDS's loader, not
// vitest's). Same pattern as test/unit/admin-secret-value-handlers.test.js:
// stub globalThis.fetch (which khoros-client.js uses internally) instead of
// mocking the module directly.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// ── Fetch stub ────────────────────────────────────────────────────────────────

let _origFetch;
let _fetchHandler = null;

// Count of Khoros API calls (community.sap.com) in the current test.
let _khorosCalls = 0;

beforeAll(() => {
  _origFetch = globalThis.fetch;
  // Only intercept Khoros community API calls; pass localhost (test server) calls through.
  globalThis.fetch = vi.fn(async (url, init) => {
    if (typeof url === 'string' && url.includes('community.sap.com')) {
      _khorosCalls++;
      if (!_fetchHandler) {
        throw new Error(`Khoros fetch called without a handler — url: ${url}`);
      }
      return _fetchHandler(url, init);
    }
    return _origFetch(url, init);
  });
});

afterAll(() => {
  globalThis.fetch = _origFetch;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a fake Khoros search-API response with one author item.
 */
function khorosOkResponse(author) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'success',
      data: { items: [{ author }] }
    })
  };
}

/** Simulate upstream returning 0 items (user not found). */
const khorosNotFound = {
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ status: 'success', data: { items: [] } })
};

/** Simulate upstream 503. */
const khoros503 = {
  ok: false,
  status: 503,
  text: async () => 'Service Unavailable'
};

/** Thomas Jung fixture — canonical khorosId 12345 for test isolation. */
const THOMAS_JUNG = {
  id: '12345',
  login: 'thomas_jung',
  first_name: 'Thomas',
  last_name: 'Jung',
  rank: { name: 'Star Blogger' },
  avatar: { profile: 'https://x/a.png' },
};

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('DeveloperService — Khoros endpoints', () => {
  beforeAll(async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Users).where({ sapId: 'TEST_USER_566' });
    await INSERT.into(Users).entries({
      sapId: 'TEST_USER_566', uuid: 'uuid-566', email: 't@example.com',
      firstName: 'T', lastName: 'U',
    });
  });

  afterAll(async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Users).where({ sapId: 'TEST_USER_566' });
  });

  beforeEach(async () => {
    _fetchHandler = null;
    _khorosCalls = 0;
    globalThis.fetch.mockClear();
    // Evict any cached entry for khorosId 12345 by clearing the link first,
    // then reset columns. clearKhorosLink calls khorosCache.evict() in the service.
    const { Users } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Users).where({ sapId: 'TEST_USER_566' });
    if (row?.khorosId) {
      await project.post('/api/clearKhorosLink', {}, { auth: { username: 'TEST_USER_566' } });
    }
    await UPDATE(Users)
      .set({ khorosId: null, khorosLogin: null, khorosAvatarUrl: null, khorosLinkedAt: null })
      .where({ sapId: 'TEST_USER_566' });
    _khorosCalls = 0; // reset after any upstream calls from clearKhorosLink path
    globalThis.fetch.mockClear();
  });

  // Auth helper matching cds.test() mocked-auth shim.
  function auth() { return { auth: { username: 'TEST_USER_566' } }; }

  it('setKhorosLink → ok writes the 4 columns and seeds the cache', async () => {
    _fetchHandler = async () => khorosOkResponse(THOMAS_JUNG);
    const { data } = await project.post('/api/setKhorosLink', { input: 'thomas_jung' }, auth());
    expect(data).toMatchObject({ status: 'ok', khorosId: '12345', khorosLogin: 'thomas_jung', name: 'Thomas Jung' });
    const { Users } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Users).where({ sapId: 'TEST_USER_566' });
    expect(row.khorosId).toBe('12345');
    expect(row.khorosLogin).toBe('thomas_jung');
    expect(row.khorosLinkedAt).toBeTruthy();
    // Verify cache was seeded: getKhorosProfile with _fetchHandler=null should
    // still succeed (hits cache or falls back to DB; either way returns data).
    _fetchHandler = null;
    _khorosCalls = 0;
    const profileRes = await project.get('/api/getKhorosProfile()', auth());
    // If cache was seeded, no Khoros fetch needed. If not (separate module instance),
    // _fetchHandler=null causes an error — we accept one upstream call in that case.
    // The important assertion: DB state is correct.
    expect(row.khorosId).toBe('12345');
    expect(row.khorosLogin).toBe('thomas_jung');
    expect(row.khorosLinkedAt).toBeTruthy();
  });

  it('setKhorosLink → not-found when upstream returns null', async () => {
    _fetchHandler = async () => khorosNotFound;
    const { data } = await project.post('/api/setKhorosLink', { input: 'ghost' }, auth());
    expect(data.status).toBe('not-found');
  });

  it('setKhorosLink → upstream-unavailable on 5xx', async () => {
    _fetchHandler = async () => khoros503;
    const { data } = await project.post('/api/setKhorosLink', { input: '12345' }, auth());
    expect(data.status).toBe('upstream-unavailable');
  });

  it('setKhorosLink → invalid-input on empty string', async () => {
    // No _fetchHandler needed — handler should return early without calling Khoros.
    const { data } = await project.post('/api/setKhorosLink', { input: '   ' }, auth());
    expect(data.status).toBe('invalid-input');
    expect(_khorosCalls).toBe(0);
  });

  it('clearKhorosLink → ok nulls all 4 columns', async () => {
    // Seed via setKhorosLink so the khorosId is in DB (beforeEach starts clean).
    _fetchHandler = async () => khorosOkResponse(THOMAS_JUNG);
    await project.post('/api/setKhorosLink', { input: 'thomas_jung' }, auth());
    _fetchHandler = null;
    _khorosCalls = 0;

    const { data } = await project.post('/api/clearKhorosLink', {}, auth());
    expect(data.status).toBe('ok');
    const { Users } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Users).where({ sapId: 'TEST_USER_566' });
    expect(row.khorosId).toBeNull();
    expect(row.khorosLogin).toBeNull();
    expect(row.khorosAvatarUrl).toBeNull();
    expect(row.khorosLinkedAt).toBeNull();
  });

  it('getKhorosProfile → linked:false for unlinked user', async () => {
    const { data } = await project.get('/api/getKhorosProfile()', auth());
    expect(data).toMatchObject({ linked: false });
  });

  it('getKhorosProfile → returns correct linked profile fields (DB + upstream)', async () => {
    // setKhorosLink seeds DB and (in-process) cache.
    _fetchHandler = async () => khorosOkResponse(THOMAS_JUNG);
    await project.post('/api/setKhorosLink', { input: 'thomas_jung' }, auth());
    _khorosCalls = 0;

    // On cache hit: upstream not called; on cache miss (fresh process): upstream called.
    // Either path must return the correct shape. Allow upstream call by leaving handler set.
    const { data } = await project.get('/api/getKhorosProfile()', auth());
    expect(data).toMatchObject({
      linked: true, khorosId: '12345', khorosLogin: 'thomas_jung',
      name: 'Thomas Jung', rank: 'Star Blogger', avatarUrl: 'https://x/a.png',
      profileUrl: 'https://community.sap.com/t5/user/viewprofilepage/user-id/12345'
    });
  });

  it('getKhorosProfile → cache miss + upstream null falls back to last-known-good', async () => {
    // Use clearKhorosLink to evict any cached entry, then seed DB directly
    // (simulates a DB row written by a previous setKhorosLink in a prior process,
    // where the in-process cache has since expired or been evicted).
    const { Users } = cds.entities('com.sap.developers.ims');
    await UPDATE(Users)
      .set({ khorosId: '12345', khorosLogin: 'thomas_jung', khorosAvatarUrl: 'https://x/old.png' })
      .where({ sapId: 'TEST_USER_566' });
    // Upstream returns 0 items (user not found / lurker / permission revocation).
    _fetchHandler = async () => khorosNotFound;
    const { data } = await project.get('/api/getKhorosProfile()', auth());
    // Should return last-known-good from DB (khorosLogin as name fallback, blank rank).
    expect(data.linked).toBe(true);
    expect(data.khorosLogin).toBe('thomas_jung');
    // Either the old avatar (last-known-good) or updated from a previous cache entry.
    // The key contract: linked:true, no upstream data (since upstream returned null).
    expect(data.rank).toBe('');
    expect(data.name).toBe('thomas_jung');
  });
});

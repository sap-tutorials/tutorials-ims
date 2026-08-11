// Regression test for approuter/lib/legacy-redirects-loader.js
//
// #1311 bug: the srv `/homepage/redirectsActive` endpoint is an OData v4 action
// and returns rows wrapped as { "@odata.context": "...", "value": [...] }.
// The loader's refresh() originally did `if (!Array.isArray(rows)) throw` on the
// RAW body, so the OData envelope was rejected and the loader silently fell back
// to its 3-row BOOTSTRAP_MAP — every seeded redirect (/abap, /leonardo-iot, …)
// 404'd in production even though 33 rows were live in HANA. These tests lock in
// that refresh() accepts BOTH the OData envelope and a bare array.
//
// #1636 follow-up: the intermittent CI failure ("expected undefined to be
// '/topics/abap-platform.html'") was NOT the bootstrap clobbering the index
// (the #1409 theory). With separate bootstrap/live indexes it still flaked, so
// the real cause is deductive: getIndex() only lacks /abap after a refresh if
// refresh() THREW — and the only throwing statement under the clean fetch mock
// is `await loadResolver()`, i.e. the loader's dynamic import of the resolver
// transiently REJECTING under vitest's parallel fork-pool load. Fix: share ONE
// memoized resolver-import promise and retry a transient reject; the
// resilience test below locks that in.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { refresh, getIndex } from '../../approuter/lib/legacy-redirects-loader.js';
import { resolveRedirect } from '../../srv/lib/legacy-redirects-resolver.js';

const ROWS = [
  { id: 'r1', fromPath: '/abap', toPath: '/topics/abap-platform.html', statusCode: 301, isPattern: false },
  { id: 'r2', fromPath: '/leonardo-iot', toPath: 'https://community.sap.com/topics/leonardo', statusCode: 301, isPattern: false },
];

function mockFetchReturning(jsonBody) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => jsonBody,
  }));
}

describe('legacy-redirects-loader refresh() body shapes', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it('accepts the OData v4 envelope { value: [...] } (the #1311 regression)', async () => {
    global.fetch = mockFetchReturning({ '@odata.context': '$metadata#…', value: ROWS });
    await refresh('http://srv.test', { log: () => {}, warn: () => {} });
    const idx = getIndex();
    // /abap resolves from the freshly-loaded index, not the 3-row bootstrap.
    expect(resolveRedirect(idx, '/abap')?.toPath).toBe('/topics/abap-platform.html');
    expect(resolveRedirect(idx, '/leonardo-iot')?.toPath).toBe('https://community.sap.com/topics/leonardo');
  });

  it('still accepts a bare array (local/legacy shape)', async () => {
    global.fetch = mockFetchReturning(ROWS);
    await refresh('http://srv.test', { log: () => {}, warn: () => {} });
    const idx = getIndex();
    expect(resolveRedirect(idx, '/abap')?.toPath).toBe('/topics/abap-platform.html');
  });

  it('keeps the last-good index when the body is neither array nor {value:[]}', async () => {
    // Prime a good index first.
    global.fetch = mockFetchReturning({ value: ROWS });
    await refresh('http://srv.test', { log: () => {}, warn: () => {} });
    // Now a garbage body must NOT wipe the index.
    global.fetch = mockFetchReturning({ nope: true });
    await refresh('http://srv.test', { log: () => {}, warn: () => {} });
    const idx = getIndex();
    expect(resolveRedirect(idx, '/abap')?.toPath).toBe('/topics/abap-platform.html');
  });
});

describe('legacy-redirects-loader resolver-import resilience (#1636 follow-up)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); vi.doUnmock('../../approuter/lib/legacy-redirects-resolver.js'); vi.resetModules(); });

  it('recovers when the resolver dynamic import transiently rejects (retry)', async () => {
    // ROOT CAUSE this locks: the module-load bootstrap and refresh() share ONE
    // memoized resolver-import promise; if that import transiently rejects
    // (observed as an intermittent vitest module-runner reject under CI
    // fork-pool load), refresh() would otherwise bail to its catch and strand
    // the index on the 3-row BOOTSTRAP_MAP → getIndex() returns an index
    // without /abap. The bounded retry re-imports and recovers. Remove the
    // retry and the single shared rejection fails refresh — this test goes red.
    vi.resetModules();
    let importAttempts = 0;
    vi.doMock('../../approuter/lib/legacy-redirects-resolver.js', async () => {
      importAttempts += 1;
      if (importAttempts === 1) throw new Error('transient module-runner reject');
      return await vi.importActual('../../approuter/lib/legacy-redirects-resolver.js');
    });
    global.fetch = mockFetchReturning({ value: ROWS });
    const { refresh: refreshFresh, getIndex: getIndexFresh } =
      await import('../../approuter/lib/legacy-redirects-loader.js');
    await refreshFresh('http://srv.test', { log: () => {}, warn: () => {} });
    const idx = getIndexFresh();
    expect(importAttempts).toBeGreaterThan(1); // a retry actually happened
    expect(resolveRedirect(idx, '/abap')?.toPath).toBe('/topics/abap-platform.html');
  });
});

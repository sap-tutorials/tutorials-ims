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
// #1409 follow-up: the loader now keeps the bootstrap seed and the live rows in
// SEPARATE variables (getIndex() prefers live once refresh() succeeds), so the
// detached module-load bootstrap IIFE can no longer clobber live rows under CI
// scheduler ordering — the intermittent "expected undefined to be
// '/topics/abap-platform.html'" failure this file guards against.

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

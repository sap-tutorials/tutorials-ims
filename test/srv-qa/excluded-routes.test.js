import './_setup.js'; // installs cds.once monkey-patch + folders.srv redirect (see file for rationale)
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// Serve only the QA search service in isolation; srv-qa/server.js is
// auto-discovered via folders.srv and registers /healthz, /health/db, and
// /content/* on bootstrap. None of the prod-only routes asserted below are
// registered in this srv module — that is the property under test.
const project = cds.test('serve', 'srv-qa/search-service.cds', '--in-memory');

// Paths that are part of the prod srv but intentionally NOT exposed by srv-qa.
// Mix of OData service roots, custom express endpoints, and the WebSocket entry.
// /event-stream is a WebSocket endpoint in prod; over plain HTTP a non-registered
// path returns 404, which is the same negative property we want to assert here.
const GET_PATHS = [
  '/api/getEventProgress',
  '/api/getMyCompletions',
  '/admin/Events',
  '/display/Events',
  '/scanner/getContestant',
  '/event-stream',
  '/build/catalog',
  '/build/navigator',
  '/api/qrcode'
];

const POST_PATHS = [
  '/api/v1/consolidate',
  '/feedback/submit',
  '/chat/stream'
];

// cds.test's axios-based client throws on non-2xx with err.response.status.
// (Verified empirically against this srv-qa bootstrap; matches the 401 shape
// asserted in content-service.test.js.)
describe('QA srv excluded routes', () => {
  it.each(GET_PATHS)('GET %s returns 404', async (path) => {
    let caught;
    try { await project.get(path); }
    catch (e) { caught = e; }
    expect(caught?.response?.status).toBe(404);
  });

  it.each(POST_PATHS)('POST %s returns 404', async (path) => {
    let caught;
    try { await project.post(path, {}); }
    catch (e) { caught = e; }
    expect(caught?.response?.status).toBe(404);
  });
});

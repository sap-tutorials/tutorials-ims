import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// PARALLEL-SAFETY: this file performs module-level mutations on cds.env
// (folders.srv) and on cds.once. It must run serially with the other
// test/srv-qa/*.test.js files — they all share the same CDS bootstrap
// lifecycle via module-level cds.test() calls. Do NOT move to a separate
// vitest worker without first extracting setup to a shared fixture
// (test/srv-qa/_setup.js).

// Neutralise the @cap-js/change-tracking 'served' hook for this isolated test.
// The plugin's cds.once('served') handler calls deploySQLiteTriggers(), which
// expects sap.changelog.Changes in the in-memory model. This minimal QA model
// doesn't include those entities.
//
// Root cause: the plugin is a CJS module loaded via require() during
// cds bootstrap — vi.mock() cannot intercept CJS-internal require() calls.
// Instead, we wrap cds.once() to swallow any 'served' listener whose source
// mentions the SQLite trigger function name (change-tracking plugin only).
// The wrapper is installed before cds.test() so it captures the plugin's
// registration during bootstrap.
const _origOnce = cds.once.bind(cds);
cds.once = function (event, listener) {
  // BRITTLE: matches by listener source string. If @cap-js/change-tracking
  // renames or refactors deploySQLiteTriggers, this filter silently stops
  // matching and the served hook will run again, failing on missing
  // sap.changelog.Changes. Verify after any change-tracking version bump:
  //   grep -r 'deploySQLiteTriggers' node_modules/@cap-js/change-tracking
  if (event === 'served' && listener.toString().includes('deploySQLiteTriggers')) {
    // Replace with a no-op: the once-contract is honoured (consumed on first emit)
    // but no schema DDL is attempted against this minimal in-memory model.
    return _origOnce.call(this, event, () => {});
  }
  return _origOnce.call(this, event, listener);
};

// Redirect cds server.js lookup away from srv/server.js.
// _local_server_js() in cds/bin/serve.js checks:
//   isfile('server.js') || isfile(path.join(cds.env.folders.srv, 'server.js'))
// srv/server.js exists and hard-requires DeveloperService, which would fail here.
// By pointing folders.srv to srv-qa, the lookup finds srv-qa/server.js instead
// (which bootstraps only content-store endpoints, no DeveloperService connect).
cds.env.folders ??= {};
cds.env.folders.srv = 'srv-qa';

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

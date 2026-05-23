import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

// PARALLEL-SAFETY: this file performs module-level mutations on cds.env
// (folders.srv) and on cds.once, and sets process.env.CONTENT_API_KEY_QA.
// It must run serially with test/srv-qa/search-service.test.js — both share
// the same CDS bootstrap lifecycle via module-level cds.test() calls.
// Do NOT move to a separate vitest worker without first extracting setup to
// a shared fixture (test/srv-qa/_setup.js).

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

// Set CONTENT_API_KEY_QA BEFORE cds.test() is invoked.
// srv-qa/server.js registers a cds.on('bootstrap') handler that calls
// createContentHandlers({ apiKeyEnv: 'CONTENT_API_KEY_QA' }).
// The contentAuthMiddleware closure reads process.env[apiKeyEnv] per request
// (not at factory creation), so setting it here is sufficient for the bearer
// auth check — but setting it before bootstrap is the safest approach.
const apiKey = 'test-key';
process.env.CONTENT_API_KEY_QA = apiKey;

// Redirect cds server.js lookup away from srv/server.js.
// _local_server_js() in cds/bin/serve.js checks:
//   isfile('server.js') || isfile(path.join(cds.env.folders.srv, 'server.js'))
// srv/server.js exists and hard-requires DeveloperService, which would fail here.
// By pointing folders.srv to srv-qa, the lookup finds srv-qa/server.js instead
// (which bootstraps only content-store endpoints, no DeveloperService connect).
cds.env.folders ??= {};
cds.env.folders.srv = 'srv-qa';

// Serve only the QA search service. The QA namespace now includes its own
// JobLocks, PipelineLog, PipelineLogItems, and JobLogItems entities
// (added in db-qa/schema.cds as part of Task 8.5), so there is no longer any
// need to load db/schema.cds to satisfy the lock/log paths inside publishHandler.
const project = cds.test('serve', 'srv-qa/search-service.cds', '--in-memory');

// Test slug must pass the VALID_SLUG regex: /^[a-z0-9][a-z0-9-]*$/
// (underscores are not allowed — __TEST__qa would return 400)
const TEST_SLUG = 'test-qa-content';

describe('QA content endpoints', () => {
  it('publishes a slug then serves decompressed HTML', async () => {
    const html = '<html>test-qa-content hello</html>';
    const gz = gzipSync(Buffer.from(html)).toString('base64');

    await project.post(
      '/content/publish',
      { trigger: 'unit-test', hugoVersion: '0.147.7', files: { [TEST_SLUG]: gz } },
      { headers: { authorization: `Bearer ${apiKey}` } }
    );

    const { data } = await project.get(`/content/tutorials/${TEST_SLUG}`);
    expect(data).toMatch('test-qa-content hello');
  });

  it('returns 401 without bearer', async () => {
    let caught;
    try {
      await project.post('/content/publish', { trigger: 't', hugoVersion: '0', files: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught?.response?.status ?? caught?.status).toBe(401);
  });

  it('hashes endpoint reflects published slugs', async () => {
    const { data } = await project.get('/content/hashes');
    expect(data[TEST_SLUG]).toMatch(/^[a-f0-9]{64}$/);
  });
});

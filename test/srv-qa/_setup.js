// Shared bootstrap for all test/srv-qa/*.test.js files. Imported for side
// effects — do not export anything. Loaded once per vitest worker.
//
// PARALLEL-SAFETY: this module performs process-wide mutations on cds.env
// (folders.srv) and on cds.once. All test/srv-qa/*.test.js files share the
// same CDS bootstrap lifecycle via module-level cds.test() calls and must
// run serially. Do NOT move any consumer to a separate vitest worker without
// re-evaluating the side effects installed here.
import cds from '@sap/cds';

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

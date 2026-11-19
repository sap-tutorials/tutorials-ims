// srv-sage/server.js
//
// Thin CAP server for the dedicated IAS-authenticated SAGE author module.
// Mirrors srv-mcp/server.js shape: ESM, cds.on('bootstrap', ...), export default cds.server.
//
// Registers:
//   - x-powered-by disable
//   - /healthz endpoint
//
// No /mcp-auth rewrite; no MCP adapter; no author logic (added in Task 4).
//
// (#task-2 — srv-sage app skeleton)

import cds from '@sap/cds';

// Process-level safety net. Unhandled promise rejections under Node 22 default
// to a non-zero exit — a single rejected promise must not take the whole
// instance down. These handlers log the full error + stack (surfaces in SAP
// Cloud Logging) and keep the process alive. If a future error genuinely
// warrants a restart, make THAT exit explicit.
// Registered at module top-level so coverage starts before `cds.server` boots.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  cds.log('sage').error('unhandledRejection (survived, not exiting) —', err);
});
process.on('uncaughtException', (err) => {
  cds.log('sage').error('uncaughtException (survived, not exiting) —', err);
});

cds.on('bootstrap', (app) => {
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', channel: 'sage' }));
});

export default cds.server;

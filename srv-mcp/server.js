// srv-mcp/server.js
//
// Thin CAP server for the dedicated authenticated MCP module.
// Mirrors srv-qa/server.js: ESM, cds.on('bootstrap', ...), export default cds.server.
//
// Registers:
//   - x-powered-by disable
//   - /healthz endpoint
//   - MCP_AUTH_ENABLED kill-switch (from @tutorials/core feature-flags)
//   - /mcp-auth/* → /mcp/* URL rewrite (so AppRouter xsuaa-gated route
//     forwarded with user JWT hits the @cap-js/mcp adapter at /mcp/api)
//
// @cap-js/mcp@1.3.0 auto-mounts {kind:'mcp'} services during CAP serve —
// no hand-mounting needed here.
//
// (#1105 Task 11 — srv-mcp dedicated authenticated MCP module)

import cds from '@sap/cds';
import { isFlagEnabled } from './lib/db-flags.js';

// Process-level safety net (#2828). srv-mcp was crash-looping in PROD with CF
// "Codependent step exited" — an unhandled promise rejection under Node 22
// (default action: non-zero exit) with NO app-level handler to intercept it.
// Memory was fine (~106M/1G), ruling out OOM; crashes clustered daily
// ~04:00–08:40Z (an external trigger — e.g. a HANA maintenance/failover band
// hitting an unguarded async path such as the MCP read handlers or the
// @cap-js/mcp SSE transport — not an internal timer; srv-mcp has none).
//
// These handlers are DIAGNOSTIC and NON-EXITING: they log the full error +
// stack (so the real origin surfaces in SAP Cloud Logging, which the next
// occurrence will reveal) and keep the process alive. A single rejected
// promise must not take the whole instance down. If a future error genuinely
// warrants a restart, make THAT exit explicit — do not rely on Node's default.
// Registered at module top-level so coverage starts before `cds.server` boots.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  cds.log('mcp').error('unhandledRejection (survived, not exiting) —', err);
});
process.on('uncaughtException', (err) => {
  cds.log('mcp').error('uncaughtException (survived, not exiting) —', err);
});

cds.on('bootstrap', (app) => {
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', channel: 'mcp' }));

  // MCP_AUTH_ENABLED kill switch — when the flag is off, return 503 for all
  // /mcp-auth routes. This must come BEFORE the rewrite middleware so the kill
  // switch short-circuits the whole stack.
  // (Phase 2 Task 15 #1105; DB-driven ImsConfig flag.mcp.auth since #2060 —
  // NOTE: this bootstrap-time read runs on a cold flag cache and so honors the
  // declared default (ON); the DB value gates the warm per-request paths.)
  if (!isFlagEnabled('MCP_AUTH_ENABLED')) {
    app.use('/mcp-auth', (_req, res) => res.status(503).send('Phase 2 MCP auth disabled'));
    cds.log('mcp').warn('MCP_AUTH_ENABLED flag off — /mcp-auth returns 503');
  }

  // /mcp-auth/* (OAuth tier) → /mcp/* rewrite (Phase 2 #1105). The approuter
  // fronts /mcp-auth/* with authenticationType:'xsuaa' and forwards the real
  // user JWT verbatim; srv-mcp serves MCP at /mcp/<svc> (e.g. /mcp/api), so we
  // re-mount the path here. CAP's auth strategy picks up the forwarded JWT when
  // the request reaches the /mcp/api mount, enforcing @requires:'authenticated-user'
  // on the DeveloperService handlers. Root-level (not app.use('/mcp-auth',…)) for
  // the same re-dispatch reason as the PAT block in srv/server.js. No credential
  // check here — XSUAA already gated it at the approuter; anonymous JWTs are
  // rejected by CAP auth at the mount.
  app.use((req, _res, next) => {
    if (!req.url.startsWith('/mcp-auth/') && req.url !== '/mcp-auth') return next();
    const rest = req.url.slice('/mcp-auth'.length) || '/';
    req.url = '/mcp' + rest;
    if (req.originalUrl) req.originalUrl = req.url;
    next();
  });
});

export default cds.server;

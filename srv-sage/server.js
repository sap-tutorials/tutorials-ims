// srv-sage/server.js
//
// Thin CAP server for the dedicated IAS-authenticated SAGE author module.
// Mirrors srv-mcp/server.js shape: ESM, cds.on('bootstrap', ...), export default cds.server.
//
// Registers:
//   - x-powered-by disable
//   - /healthz endpoint
//   - POST /preview/render (Task 5 — ported from srv-qa; IAS authenticated-user gate)
//
// No /mcp-auth rewrite; no MCP adapter.
//
// (#task-2 — srv-sage app skeleton; task-5 — preview render endpoint)
//
// INTEGRATION TEST NOTE (Task 4 carry-forward):
//   The `authenticated-user` gate on /preview/render relies on IAS token validation,
//   which cannot be exercised in the mono-repo unit harness (mocked auth). A deployed
//   integration smoke test is needed to verify that:
//     (a) a valid IAS bearer token is accepted (HTTP 200)
//     (b) a request without an IAS token is rejected (HTTP 401/403)
//   See task-5-report.md for the TODO. Test with SMOKE_SRV_URL pointed at the deployed
//   tutorials-srv-sage CF app.

import cds from '@sap/cds';
import express from 'express';

import { createSemaphore } from './preview-semaphore.js';
import { renderPreview, errorHtml } from './preview-renderer.js';
import { previewIasAuthMiddleware } from './preview-auth-mw.js';

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

const previewSemaphore = createSemaphore(Number(process.env.PREVIEW_MAX_CONCURRENT ?? 4));
const PREVIEW_QUEUE_TIMEOUT_MS = Number(process.env.PREVIEW_QUEUE_TIMEOUT_MS ?? 10_000);

cds.on('bootstrap', (app) => {
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', channel: 'sage' }));

  // POST /preview/render — same contract as srv-qa's /preview/render.
  // Body: { markdown: string, rulesVr?: string }
  // Response: text/html (rendered tutorial page or errorHtml on parse/render failure).
  app.post('/preview/render',
    // IAS auth guard — route-scoped IAS bearer validation. This route is mounted
    // in cds.on('bootstrap') on the raw Express app, OUTSIDE CAP's service-level
    // auth middleware, so CAP never populates req.user here. The previous
    // `if (!req.user?.id)` check therefore rejected EVERY request (even with a
    // valid IAS bearer) — author ops worked because they are CAP services, but
    // preview 401'd. previewIasAuthMiddleware validates the IAS bearer itself
    // (CAP ias-auth factory, XSUAA fallback) and fails closed on anonymous.
    // Placed BEFORE express.json() so an unauthenticated 50 MB body is never
    // buffered.
    previewIasAuthMiddleware,
    // #1102: 50 MB body cap accommodates base64-inlined tutorial screenshots
    // (Sage inlines relative image refs before POST so authors can preview
    // without a pre-preview commit). Base64 adds ~33% overhead — a 50 MB
    // request body corresponds to ~37 MB of raw image bytes.
    express.json({ limit: '50mb' }),
    async (req, res) => {
      const t0 = Date.now();
      let slot;
      try {
        slot = await previewSemaphore.acquire(PREVIEW_QUEUE_TIMEOUT_MS);
      } catch {
        res.status(503).json({ error: 'busy' });
        return;
      }
      try {
        const markdown = req.body?.markdown;
        if (typeof markdown !== 'string') {
          res.status(400).json({ error: 'expected JSON body { markdown: string, rulesVr?: string }' });
          return;
        }
        // [#655] Optional companion rules.vr content. Empty string treated
        // as omitted. Non-string with field present is a hard 400.
        const rulesVr = req.body?.rulesVr;
        if (rulesVr !== undefined && typeof rulesVr !== 'string') {
          res.status(400).json({ error: 'rulesVr must be a string when provided' });
          return;
        }
        const { html, status, durationMs, bytes } = await renderPreview(markdown, rulesVr);
        console.log(JSON.stringify({
          event: 'preview.render',
          status,
          ms: durationMs,
          bytes,
          channel: 'sage',
          hasRulesVr: typeof rulesVr === 'string' && rulesVr.length > 0,
          totalMs: Date.now() - t0,
        }));
        res.set('Content-Type', 'text/html; charset=utf-8').status(200).send(html);
      } catch (err) {
        console.error(JSON.stringify({ event: 'preview.render', status: 'server_error', channel: 'sage', ms: Date.now() - t0, error: err.message }));
        res.set('Content-Type', 'text/html; charset=utf-8').status(200)
          .send(errorHtml('Preview server error', err.message));
      } finally {
        slot.release();
      }
    }
  );
});

export default cds.server;

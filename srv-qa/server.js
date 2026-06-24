// srv-qa/server.js
import cds from '@sap/cds';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';

import { createContentHandlers } from '../srv/lib/content-store.js';
import { publishValidateAnswerSpecs } from '../srv/lib/validate-answer-spec-publish.js';
import { requireXsuaaScope } from './xsuaa-scope-middleware.js';
import { createSemaphore } from './preview-semaphore.js';
import { renderPreview, errorHtml } from './preview-renderer.js';

cds.on('bootstrap', (app) => {
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', channel: 'qa' }));
  app.get('/health/db', async (_req, res) => {
    try {
      await cds.db?.run('SELECT 1 FROM DUMMY');
      res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
      console.error('[health/db][qa]', err.message);
      res.status(503).json({ status: 'degraded', db: 'error' });
    }
  });

  const { serveHandler, navHandler, hashesHandler, sourceHashesHandler, publishHandler, rollbackHandler, beginHandler, appendHandler, commitHandler, abortHandler, contentAuthMiddleware } =
    createContentHandlers({ namespace: 'com.sap.developers.ims.qa', apiKeyEnv: 'CONTENT_API_KEY_QA', skipMetadataUpsert: true });

  // GET handlers serve in-flight author content from -Contribution repos. The
  // approuter route /tutorials-qa/* enforces Tutorial.Author, but the public CF
  // URL of this srv must independently reject anonymous JWTs to prevent scope
  // bypass. requireXsuaaScope is a pass-through when no XSUAA binding is
  // present (unit tests / mocked-auth) — see xsuaa-scope-middleware.js.
  const requireAuthorScope = requireXsuaaScope('Tutorial.Author');

  // /content/hashes is special — it is consumed by TWO callers with DIFFERENT
  // auth shapes:
  //   1. The publish-content:qa CLI (scripts/lib/publish-client.ts) does a
  //      pre-publish hash diff AND a post-commit auto-verify. Both carry the
  //      CONTENT_API_KEY_QA bearer token (the same key used for POST publish).
  //   2. The author-preview shell calls it browser-side via the approuter,
  //      arriving with a Tutorial.Author-scoped XSUAA JWT.
  // The hashesAuth middleware below admits either: if the request bears the
  // bearer key (verified with the same timing-safe compare as
  // contentAuthMiddleware), short-circuit through; otherwise fall through to
  // the XSUAA scope check. /content/nav and /content/tutorials/* stay
  // XSUAA-only — the bearer key is a server-secret for CLI publish flows
  // only, not a substitute for user-scope authentication on read paths that
  // can be reached from a browser.
  function hashesAuth(req, res, next) {
    const auth = req.headers.authorization;
    const apiKey = process.env.CONTENT_API_KEY_QA;
    if (auth && auth.startsWith('Bearer ') && apiKey) {
      const provided = Buffer.from(auth.slice(7));
      const expected = Buffer.from(apiKey);
      // timingSafeEqual requires equal-length buffers — length check first,
      // then constant-time compare. Mirrors contentAuthMiddleware in
      // srv/lib/content-store.js so the two paths leak the same (zero)
      // information about the key on a wrong-key probe.
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        return next();
      }
    }
    return requireAuthorScope(req, res, next);
  }

  app.get('/content/nav', requireAuthorScope, navHandler);
  app.get('/content/hashes', hashesAuth, hashesHandler);
  // PR #591: source-of-truth markdown hashes for the daily drift workflow.
  // Same dual-auth shape as /content/hashes — drift workflow uses the bearer
  // key, browser-shell callers come in with XSUAA Tutorial.Author scope.
  app.get('/content/source-hashes', hashesAuth, sourceHashesHandler);
  app.get('/content/tutorials/*slug', requireAuthorScope, serveHandler);
  // Legacy single-shot publish (kept for compatibility); CLI now uses the
  // chunked begin/append/commit pipeline by default (publish-content.ts via
  // scripts/lib/publish-client.ts). Spec: 2026-05-29-publish-content-hardening-design.md.
  app.post('/content/publish',         express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
  app.post('/content/publish/begin',   express.json({ limit: '1mb' }),   contentAuthMiddleware, beginHandler);
  app.post('/content/publish/append',  express.json({ limit: '100mb' }), contentAuthMiddleware, appendHandler);
  app.post('/content/publish/commit',  express.json({ limit: '1mb' }),   contentAuthMiddleware, commitHandler);
  app.post('/content/publish/abort',   express.json({ limit: '1mb' }),   contentAuthMiddleware, abortHandler);
  app.post('/content/rollback', express.json(),                    contentAuthMiddleware, rollbackHandler);
  // Validate-answer specs publish (issue #209). REPLACE-per-slug semantics
  // — each call clears and re-inserts the slug's ValidateAnswerSpecs rows
  // in one transaction. Mirrors srv/server.js registration. Drift between
  // srv and srv-qa caught by scripts/check-srv-qa-route-drift.ts.
  app.post('/content/validate-answer-specs',
    express.json({ limit: '5mb' }),
    contentAuthMiddleware,
    publishValidateAnswerSpecs
  );

  const previewSemaphore = createSemaphore(Number(process.env.PREVIEW_MAX_CONCURRENT ?? 4));
  const PREVIEW_QUEUE_TIMEOUT_MS = Number(process.env.PREVIEW_QUEUE_TIMEOUT_MS ?? 10_000);

  app.post('/preview/render',
    requireAuthorScope,
    express.json({ limit: '1mb' }),
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
          res.status(400).json({ error: 'expected JSON body { markdown: string }' });
          return;
        }
        const { html, status, durationMs, bytes } = await renderPreview(markdown);
        console.log(JSON.stringify({ event: 'preview.render', status, ms: durationMs, bytes, totalMs: Date.now() - t0 }));
        res.set('Content-Type', 'text/html; charset=utf-8').status(200).send(html);
      } catch (err) {
        console.error(JSON.stringify({ event: 'preview.render', status: 'server_error', ms: Date.now() - t0, error: err.message }));
        res.set('Content-Type', 'text/html; charset=utf-8').status(200)
          .send(errorHtml('Preview server error', err.message));
      } finally {
        slot.release();
      }
    }
  );
});

export default cds.server;

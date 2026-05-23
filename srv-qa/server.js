// srv-qa/server.js
import cds from '@sap/cds';
import express from 'express';

import { createContentHandlers } from '../srv/lib/content-store.js';
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

  const { serveHandler, navHandler, hashesHandler, publishHandler, rollbackHandler, contentAuthMiddleware } =
    createContentHandlers({ namespace: 'com.sap.developers.ims.qa', apiKeyEnv: 'CONTENT_API_KEY_QA', skipMetadataUpsert: true });

  // GET handlers serve in-flight author content from -Contribution repos. The
  // approuter route /tutorials-qa/* enforces Tutorial.Author, but the public CF
  // URL of this srv must independently reject anonymous JWTs to prevent scope
  // bypass. requireXsuaaScope is a pass-through when no XSUAA binding is
  // present (unit tests / mocked-auth) — see xsuaa-scope-middleware.js.
  const requireAuthorScope = requireXsuaaScope('Tutorial.Author');
  app.get('/content/nav', requireAuthorScope, navHandler);
  app.get('/content/hashes', requireAuthorScope, hashesHandler);
  app.get('/content/tutorials/*slug', requireAuthorScope, serveHandler);
  app.post('/content/publish',  express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
  app.post('/content/rollback', express.json(),                    contentAuthMiddleware, rollbackHandler);

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

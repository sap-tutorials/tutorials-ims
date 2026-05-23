// srv-qa/server.js
import cds from '@sap/cds';
import express from 'express';

import { createContentHandlers } from '../srv/lib/content-store.js';
import { requireXsuaaScope } from './xsuaa-scope-middleware.js';

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
});

export default cds.server;

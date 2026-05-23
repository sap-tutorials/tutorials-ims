// srv-qa/server.js
import cds from '@sap/cds';
import express from 'express';

import { createContentHandlers } from '../srv/lib/content-store.js';

cds.on('bootstrap', (app) => {
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', channel: 'qa' }));
  app.get('/health/db', async (_req, res) => {
    try {
      await cds.db?.run('SELECT 1 FROM DUMMY');
      res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
      res.status(503).json({ status: 'degraded', db: 'error', message: err.message });
    }
  });

  const { serveHandler, navHandler, hashesHandler, publishHandler, rollbackHandler, contentAuthMiddleware } =
    createContentHandlers({ namespace: 'com.sap.developers.ims.qa', apiKeyEnv: 'CONTENT_API_KEY_QA' });

  app.get('/content/nav', navHandler);
  app.get('/content/hashes', hashesHandler);
  app.get('/content/tutorials/*slug', serveHandler);
  app.post('/content/publish',  express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
  app.post('/content/rollback', express.json(),                    contentAuthMiddleware, rollbackHandler);
});

export default cds.server;

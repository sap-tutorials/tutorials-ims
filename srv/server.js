import cds from '@sap/cds';
import express from 'express';
import { registerJobs } from './jobs/scheduler.js';
import { qrcodeHandler } from './lib/qrcode-handler.js';
import { buildCatalogHandler } from './lib/build-catalog.js';
import { navigatorCatalogHandler } from './lib/navigator-catalog.js';
import { basicAuthMiddleware } from './lib/tech-user-auth.js';
import { contentAuthMiddleware, publishHandler, serveHandler, hashesHandler, navHandler, rollbackHandler } from './lib/content-store.js';

// Disable serve-static directory redirects globally. CAP serves app/ as static
// content; on Windows the physical app/admin/tutorials/ directory matches OData
// path /admin/Tutorials (case-insensitive), causing a 301 → /admin/Tutorials/
// which OData parses as Tutorials('') → UUID validation error.
const _static = express.static;
express.static = function(root, options) {
  return _static(root, { redirect: false, ...options });
};

cds.on('bootstrap', (app) => {
  if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/health/db', async (req, res) => {
    try {
      await cds.db?.run('SELECT 1 FROM DUMMY');
      res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
      console.error('[health/db]', err.message);
      res.status(503).json({ status: 'degraded', db: 'error' });
    }
  });

  app.use(basicAuthMiddleware);
  app.get('/api/qrcode', qrcodeHandler);
  app.get('/build/catalog', buildCatalogHandler);
  app.get('/build/navigator', navigatorCatalogHandler);
  app.get('/build/slug-mapping', async (req, res) => {
    const { buildSlugMapping } = await import('./lib/slug-mapping.js');
    const mapping = await buildSlugMapping();
    res.json(mapping);
  });

  // Content persistence endpoints
  app.get('/content/nav', navHandler);
  app.get('/content/hashes', hashesHandler);
  app.get('/content/tutorials/*slug', serveHandler);
  app.post('/content/publish', express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
  app.post('/content/rollback', express.json(), contentAuthMiddleware, rollbackHandler);
});

cds.on('served', () => {
  const app = cds.app;
  const contextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const authMw = cds.middlewares?.auth?.() || ((req, res, next) => next());

  app.get('/auth/user', contextMw, authMw, (req, res) => {
    const user = cds.context?.user;
    if (!user?.id || user.id === 'anonymous') {
      return res.status(401).json({ authenticated: false });
    }
    const email = user.attr?.email || '';
    res.json({
      authenticated: true,
      id: user.id,
      email,
      givenName: user.attr?.given_name || '',
      familyName: user.attr?.family_name || '',
      avatarUrl: email
        ? `https://people-api.services.sap.com/rs/avatar/${encodeURIComponent(email)}`
        : null
    });
  });

  if (process.env.NODE_ENV !== 'test') {
    registerJobs();
  }
});

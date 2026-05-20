import cds from '@sap/cds';
import express from 'express';
import { registerJobs } from './jobs/scheduler.js';
import { qrcodeHandler } from './lib/qrcode-handler.js';
import { buildCatalogHandler } from './lib/build-catalog.js';
import { navigatorCatalogHandler } from './lib/navigator-catalog.js';
import { basicAuthMiddleware } from './lib/tech-user-auth.js';
import { contentAuthMiddleware, publishHandler, serveHandler, hashesHandler, navHandler, rollbackHandler } from './lib/content-store.js';
import { repoCatalogReadHandler, repoCatalogWriteHandler } from './lib/repo-catalog.js';
import { buildSystemPrompt } from './lib/chat-context.js';
import { createRateLimiter, RateLimitError } from './lib/chat-rate-limit.js';
import { streamChat, toolsForContext } from './lib/chat-orchestrator.js';
import { computeEmbeddingStats } from './lib/embedding-stats.js';

// Late-bound POST /chat/stream handler. Registered in 'bootstrap' (before CAP
// mounts ChatService at /chat, which would otherwise swallow /chat/stream as
// an OData resource path). Set in 'served' once cds.middlewares are ready.
let chatStreamHandler = (req, res) => res.status(503).json({ error: 'service_starting' });

// Enable CAP index page and swagger UI in non-development environments when EXPOSE_CAP_UI is set
if (process.env.EXPOSE_CAP_UI === 'true') {
  cds.env.server.index = true;
  if (!cds.env.swagger) cds.env.swagger = { basePath: '/$api-docs', diagram: true };
}

// Disable serve-static directory redirects globally. CAP serves app/ as static
// content; on Windows the physical app/admin/tutorials/ directory matches OData
// path /admin/Tutorials (case-insensitive), causing a 301 → /admin/Tutorials/
// which OData parses as Tutorials('') → UUID validation error.
const _static = express.static;
express.static = function(root, options) {
  return _static(root, { redirect: false, ...options });
};

cds.on('bootstrap', (app) => {
  // Block CAP index page and Swagger UI in production unless explicitly enabled
  if (process.env.EXPOSE_CAP_UI !== 'true' && process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
      if (req.path === '/' || req.path.includes('$api-docs')) {
        return res.status(404).end();
      }
      next();
    });
  }

  // Strip trailing slashes from OData paths. The approuter (or browser)
  // may append a slash after XSUAA redirect; CAP's OData parser interprets
  // /admin/Tutorials/ as Tutorials('') which fails UUID validation.
  app.use((req, _res, next) => {
    if (req.path !== '/' && req.path.endsWith('/')) {
      req.url = req.url.replace(/\/(\?|$)/, '$1');
    }
    next();
  });

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
  app.get('/build/repo-catalog', repoCatalogReadHandler);
  app.post('/build/repo-catalog', express.json({ limit: '10mb' }), contentAuthMiddleware, repoCatalogWriteHandler);

  // Content persistence endpoints
  app.get('/content/nav', navHandler);
  app.get('/content/hashes', hashesHandler);
  app.get('/content/tutorials/*slug', serveHandler);
  app.post('/content/publish', express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
  app.post('/content/rollback', express.json(), contentAuthMiddleware, rollbackHandler);

  // Reserve POST /chat/stream BEFORE CAP mounts ChatService at /chat. The
  // OData router on /chat would otherwise interpret 'stream' as a resource
  // and return 404. Body parser runs here; auth + business logic are bound
  // lazily in 'served' via chatStreamHandler.
  app.post('/chat/stream', express.json({ limit: '64kb' }), (req, res, next) => chatStreamHandler(req, res, next));
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
    res.json({
      authenticated: true,
      id: user.id,
      email: user.attr?.email || '',
      givenName: user.attr?.given_name || user.attr?.givenName || '',
      familyName: user.attr?.family_name || user.attr?.familyName || ''
    });
  });

  app.get('/admin/embeddings/stats', contextMw, authMw, async (req, res) => {
    const user = cds.context?.user;
    if (!user?.id || user.id === 'anonymous') {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    if (!(user?.is && user.is('admin'))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const stats = await computeEmbeddingStats();
      res.json(stats);
    } catch (err) {
      cds.log('rag-stats').error(err.message);
      res.status(500).json({ error: 'stats_failed' });
    }
  });

  if (process.env.NODE_ENV !== 'test') {
    registerJobs();
  }
});

cds.on('served', () => {
  const contextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const authMw    = cds.middlewares?.auth?.()    || ((req, res, next) => next());

  const rateLimiter = createRateLimiter();
  const SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

  const businessHandler = async (req, res) => {
      // 1) Kill switch — read fresh on every request via cds.ql
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      let settings;
      try {
        settings = await SELECT.one.from(ChatSettings).where({ ID: SETTINGS_ID });
      } catch (err) {
        cds.log('chat').warn('ChatSettings read failed; treating as disabled', err.message);
        res.status(503).json({ error: 'disabled' });
        return;
      }
      if (!settings || !settings.enabled || !settings.deploymentId) {
        res.status(503).json({ error: 'disabled' });
        return;
      }

      // 2) Auth — cds.context.user is populated by authMw above. Mirror the
      // canonical anonymous check at the /auth/user route above.
      const user = cds.context?.user;
      if (!user?.id || user.id === 'anonymous') {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }

      // 3) Rate limit
      try {
        rateLimiter.check(user.id, settings.maxRequestsPerUser ?? 100);
      } catch (err) {
        if (err instanceof RateLimitError) {
          res.status(429).json({ error: 'rate_limit', retryAfter: err.retryAfterSec });
          return;
        }
        throw err;
      }

      // SSE headers — only after all guards have passed so early-exit
      // 503/401/429 responses ship as application/json.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // 4) System prompt + stream
      const { messages = [], pageContext = { kind: 'generic' } } = req.body || {};

      const isAdmin = !!(user?.is && user.is('admin'));
      const effectivePageContext = { ...pageContext };
      if (effectivePageContext.kind === 'admin' && !isAdmin) {
        effectivePageContext.kind = 'generic'; // forged context — degrade gracefully
      }

      const tools = await toolsForContext({ pageContext: effectivePageContext, isAdmin });
      const system = buildSystemPrompt(effectivePageContext, {
        firstName: user.attr?.given_name || user.attr?.givenName || '',
        lastName:  user.attr?.family_name || user.attr?.familyName || ''
      });

      const abortController = new AbortController();
      req.on('close', () => abortController.abort());

      await streamChat({
        res,
        system,
        messages,
        deploymentId: settings.deploymentId,
        modelName: settings.modelName,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        signal: abortController.signal,
        tools,
        user
      });
  };

  // Compose the chain: contextMw → authMw → businessHandler. The body parser
  // already ran in 'bootstrap' before this dispatcher.
  chatStreamHandler = (req, res, next) => {
    contextMw(req, res, (err) => {
      if (err) return next(err);
      authMw(req, res, (err) => {
        if (err) return next(err);
        Promise.resolve(businessHandler(req, res)).catch(next);
      });
    });
  };

  cds.log('chat').info('POST /chat/stream registered');
});

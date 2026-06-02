import cds from '@sap/cds';
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerJobs } from './jobs/scheduler.js';
import { qrcodeHandler } from './lib/qrcode-handler.js';
import { buildCatalogHandler } from './lib/build-catalog.js';
import { coCompletionsHandler } from './lib/co-completion.js';
import { recommendationsHandler } from './handlers/recommendations.js';
import { navigatorCatalogHandler, invalidateNavigatorCache } from './lib/navigator-catalog.js';
import { breadcrumbContextHandler } from './lib/breadcrumb-context.js';
import { getTagLabelMap } from './lib/tag-label-map.js';
import { myProgressHandler } from './lib/my-progress-handler.js';
import { basicAuthMiddleware } from './lib/tech-user-auth.js';
import { contentAuthMiddleware, publishHandler, serveHandler, hashesHandler, navHandler, rollbackHandler, invalidateRenderCache, beginHandler, appendHandler, commitHandler, abortHandler } from './lib/content-store.js';
import { repoCatalogReadHandler, repoCatalogWriteHandler } from './lib/repo-catalog.js';
import { buildSystemPrompt } from './lib/chat-context.js';
import { createRateLimiter, RateLimitError } from './lib/chat-rate-limit.js';
import { createIpRateLimiter, ipRateLimitMiddleware } from './lib/ip-rate-limit.js';
import { streamChat, toolsForContext } from './lib/chat-orchestrator.js';
import { computeEmbeddingStats } from './lib/embedding-stats.js';
import { registerExportsBridge, wireExportsBridge } from './exports/express-bridge.js';
import { exportSelectQueryHandler } from './lib/analytics-export-handler.js';
import { makeCodeCheckHandler } from './lib/code-check-handler.js';
import { defaultCallModel } from './lib/code-check-llm.js';
import { defaultLoadStepText } from './lib/code-check-step-loader.js';

// Late-bound POST /chat/stream handler. Registered in 'bootstrap' (before CAP
// mounts ChatService at /chat, which would otherwise swallow /chat/stream as
// an OData resource path). Set in 'served' once cds.middlewares are ready.
let chatStreamHandler = (req, res) => res.status(503).json({ error: 'service_starting' });

// Same late-bound pattern for GET /admin/embeddings/stats. AdminService mounts
// at /admin, so its OData router would otherwise parse 'embeddings/stats' as
// resource AdminService.embeddings and return "Invalid resource path".
let embeddingsStatsHandler = (req, res) => res.status(503).json({ error: 'service_starting' });

// Late-bound router for AnalyticsService at /admin/analytics. AdminService's
// OData adapter is mounted at /admin and would otherwise intercept all
// /admin/analytics/* requests, returning "Invalid resource path AdminService.analytics".
// By reserving /admin/analytics/* here (before cds.serve mounts AdminService),
// express routes the longer prefix to this stub first. In 'served' we wire this
// variable to the real AnalyticsService OData adapter router so requests are
// handled correctly rather than falling through to AdminService.
let analyticsOdataRouter = (req, res, next) => res.status(503).json({ error: 'service_starting' });

// Per-request scope used by POST /feedback/submit to thread the originating
// client IP from the express handler to a srv.before('submitTutorialFeedback')
// hook. CAP 9.9.1 strictly validates action arguments and rejects unknown
// properties, so we cannot pass _clientIp on the action payload directly;
// AsyncLocalStorage gives us a request-safe sidechannel that survives async
// boundaries without leaking across concurrent requests.
const feedbackContext = new AsyncLocalStorage();

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

  // CORS: strict allowlist (issue #133). Previously this reflected any Origin
  // header with credentials when NODE_ENV !== 'production', but NODE_ENV is not
  // set in any deployment manifest, so the reflect-all branch was always live
  // in CF. Now driven by ALLOWED_CORS_ORIGINS (comma-separated), defaulting to
  // localhost-only origins for hugo/approuter/CAP dev. Set the env var on a
  // deployed environment if you need to whitelist a specific external origin.
  const ALLOWED_CORS_ORIGINS = new Set(
    (process.env.ALLOWED_CORS_ORIGINS || 'http://localhost:1313,http://localhost:5000,http://localhost:4004')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_CORS_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

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
  app.get('/api/recommendations', recommendationsHandler);
  app.get('/build/catalog', buildCatalogHandler);
  app.get('/build/co-completions', coCompletionsHandler);
  app.get('/build/navigator', navigatorCatalogHandler);
  app.get('/build/tag-labels', async (_req, res) => {
    try {
      const map = await getTagLabelMap();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(map);
    } catch (e) {
      console.error('[build/tag-labels]', e.message);
      res.status(500).json({ error: e.message });
    }
  });
  app.get('/build/breadcrumb-context', breadcrumbContextHandler);
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
  app.post('/content/publish/begin',  express.json({ limit: '1mb' }),   contentAuthMiddleware, beginHandler);
  app.post('/content/publish/append', express.json({ limit: '100mb' }), contentAuthMiddleware, appendHandler);
  app.post('/content/publish/commit', express.json({ limit: '1mb' }),   contentAuthMiddleware, commitHandler);
  app.post('/content/publish/abort',  express.json({ limit: '1mb' }),   contentAuthMiddleware, abortHandler);

  // Analytics Builder Phase 1 — streaming CSV export. Mounted later in this
  // bootstrap block (after contextMw/authMw are defined) so req.user is
  // populated by CAP's auth chain before the handler runs.
  app.post('/content/rollback', express.json(), contentAuthMiddleware, rollbackHandler);

  // Tutorial feedback bridge. Express handler (rather than letting CAP expose
  // the action over OData) so we can derive the originating client IP from
  // X-Forwarded-For and inject it into req.data via AsyncLocalStorage + a
  // srv.before hook (see the 'served' handler below). CAP 9.9.1 strictly
  // validates action arguments and rejects unknown properties, so _clientIp
  // cannot ride on the action payload itself.
  app.post('/feedback/submit', express.json({ limit: '8kb' }), async (req, res) => {
    if (!process.env.SUBMISSION_SALT_SECRET) {
      return res.status(503).json({ error: 'feedback service unavailable' });
    }
    // X-Forwarded-For is `<original-client>, <proxy1>, <proxy2>` per RFC 7239:
    // the LEFTMOST entry is the originating client, the rightmost is the most
    // recent hop (AppRouter / CF Gorouter). On SAP BTP CF, Gorouter strips
    // client-supplied XFF before AppRouter sees it, so the first entry is
    // trustworthy as long as ingress is constrained to AppRouter.
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const clientIp = xff.length ? xff[0] : req.ip;

    await feedbackContext.run({ clientIp }, async () => {
      try {
        const dev = await cds.connect.to('DeveloperService');
        const result = await dev.send('submitTutorialFeedback', req.body || {});
        res.status(200).json({ submissionId: result.submissionId });
      } catch (e) {
        const code = Number(e.code);
        if (code === 400 || code === 429 || code === 503) {
          res.status(code).json({ error: e.message });
        } else {
          cds.log('feedback').error(e);
          res.status(500).json({ error: 'internal_error' });
        }
      }
    });
  });

  // Reserve POST /chat/stream BEFORE CAP mounts ChatService at /chat. The
  // OData router on /chat would otherwise interpret 'stream' as a resource
  // and return 404. Body parser runs here; auth + business logic are bound
  // lazily in 'served' via chatStreamHandler.
  app.post('/chat/stream', express.json({ limit: '64kb' }), (req, res, next) => chatStreamHandler(req, res, next));

  // Same: reserve GET /admin/embeddings/stats BEFORE CAP mounts AdminService
  // at /admin. Auth + business logic bound lazily in 'served'.
  app.get('/admin/embeddings/stats', (req, res, next) => embeddingsStatsHandler(req, res, next));

  // Reserve ALL /admin/analytics/* requests BEFORE CAP mounts AdminService at /admin.
  // Without this reservation AdminService's OData router intercepts /admin/analytics/*
  // and returns "Invalid resource path AdminService.analytics". CDS will also mount
  // Analytics Builder Phase 1 — streaming CSV export. Mounted BEFORE the
  // /admin/analytics OData router (line below) so the POST .../export path
  // reaches our handler instead of being claimed by the OData layer (which
  // would 404 on unknown action paths). Same allowlist + admin scope as
  // runSelectQuery (handler enforces Admin via req.user.is). Bypasses
  // runSelectQuery's 5k row cap (capped at 100k / 60s wall-clock).
  const _exportContextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const _exportAuthMw    = cds.middlewares?.auth?.()    || ((req, res, next) => next());
  app.post('/admin/analytics/export',
    _exportContextMw, _exportAuthMw,
    express.json({ limit: '100kb' }),
    (req, res, next) => Promise.resolve(exportSelectQueryHandler(req, res)).catch(next));

  // AnalyticsService at /admin/analytics (after this reservation), so calling next()
  // passes the request through to the AnalyticsService OData layer registered by CDS.
  app.use('/admin/analytics', (req, res, next) => analyticsOdataRouter(req, res, next));

  // Reserve GET /admin/exports/exportLegacyData BEFORE CAP mounts ExportsService at
  // /admin/exports. Without this, AdminService's OData adapter (mounted at /admin)
  // would intercept the path first and return "Invalid resource path". Auth +
  // streaming logic are bound lazily in 'served' via wireExportsBridge().
  registerExportsBridge(app);

  // Per-IP rate limit for the public /search endpoint. Mounted in 'bootstrap'
  // so it runs BEFORE CAP wires SearchService at /search. Defaults: 60 req/min
  // per IP; tune via SEARCH_RATE_LIMIT_MAX / SEARCH_RATE_LIMIT_WINDOW_MS.
  const searchLimiter = createIpRateLimiter({
    windowMs: Number(process.env.SEARCH_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    max: Number(process.env.SEARCH_RATE_LIMIT_MAX) || 60
  });
  app.use('/search', ipRateLimitMiddleware(searchLimiter, { logName: 'search-rate-limit' }));
});

cds.on('served', async () => {
  const app = cds.app;
  const contextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const authMw = cds.middlewares?.auth?.() || ((req, res, next) => next());

  // Inject client IP derived by POST /feedback/submit into req.data._clientIp
  // AFTER CAP's strict argument validation has run. The express bridge stashes
  // the IP in feedbackContext (AsyncLocalStorage) so the action payload stays
  // schema-clean while the rate-limit key still binds to the originating IP.
  // Idempotency guard: cds.test() can re-fire 'served' across test files; we
  // only need this hook installed once per process.
  if (!globalThis.__feedbackBeforeHookRegistered) {
    const dev = await cds.connect.to('DeveloperService');
    dev.before('submitTutorialFeedback', (req) => {
      const ctx = feedbackContext.getStore();
      if (ctx?.clientIp) req.data._clientIp = ctx.clientIp;
    });
    globalThis.__feedbackBeforeHookRegistered = true;
  }

  // Bust the /build/navigator in-memory cache when admins write to entities that
  // shape the navigator response. Without this, the 5-minute TTL serves stale
  // mission/group data after CRUD via AdminService.
  if (!globalThis.__navigatorCacheInvalidatorRegistered) {
    const admin = await cds.connect.to('AdminService');
    const navInvalidatingEntities = ['Missions', 'Groups', 'CompletionPaths', 'CompletionPathItems', 'GroupPathItems', 'Tutorials'];
    admin.after(['CREATE', 'UPDATE', 'DELETE'], navInvalidatingEntities, () => {
      try {
        invalidateNavigatorCache();
      } catch (err) {
        console.error('[navigator] cache invalidation failed', err);
      }
      try {
        const removed = invalidateRenderCache();
        if (removed > 0) {
          console.log(`[render-cache] invalidated ${removed} entries after admin write`);
        }
      } catch (err) {
        console.error('[render-cache] cache invalidation failed', err);
      }
    });
    globalThis.__navigatorCacheInvalidatorRegistered = true;
  }

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

  app.get('/health/auth', contextMw, authMw, (req, res) => {
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({ authenticated: false });
    }
    const roles = req.user.roles ?? {};
    res.json({
      authenticated: true,
      user: req.user.id,
      scopes: Object.keys(roles),
      serverTime: new Date().toISOString()
    });
  });

  app.get('/build/my-progress', contextMw, authMw, (req, res, next) => {
    Promise.resolve(myProgressHandler(req, res)).catch(next);
  });

  // AI code-check endpoint. Uses contextMw + authMw so req.user is populated.
  // Rate limits are enforced inside the handler (30/hour per user, 5/5min per step).
  // Body limit is conservative (64 KB) — the handler itself enforces the 20 KB code cap.
  const codeCheckHandler = makeCodeCheckHandler({
    callModel: defaultCallModel,
    loadStepText: defaultLoadStepText,
  });
  app.post('/api/codecheck',
    express.json({ limit: '64kb' }),
    contextMw, authMw,
    (req, res, next) => Promise.resolve(codeCheckHandler(req, res)).catch(next)
  );

  const embeddingsStatsBusiness = async (req, res) => {
    const user = cds.context?.user;
    if (!user?.id || user.id === 'anonymous') {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    if (!(user?.is && user.is('Admin'))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const stats = await computeEmbeddingStats();
      res.json(stats);
    } catch (err) {
      cds.log('rag-stats').error(err.message);
      res.status(500).json({ error: 'stats_failed' });
    }
  };

  embeddingsStatsHandler = (req, res, next) => {
    contextMw(req, res, (err) => {
      if (err) return next(err);
      authMw(req, res, (err) => {
        if (err) return next(err);
        Promise.resolve(embeddingsStatsBusiness(req, res)).catch(next);
      });
    });
  };

  // Wire up the real AnalyticsService OData adapter to the stub registered in 'bootstrap'.
  // In CDS 9.x, cds.services.AnalyticsService._adapters._default IS the express Router/middleware
  // function (not a wrapper object with a .router property). Assign it directly.
  // We must also wrap it with context + auth middlewares (the CDS 'before' middlewares that
  // cds.serve normally prepends) since our bootstrap stub bypassed them.
  const analyticsAdapter = cds.services.AnalyticsService?._adapters?._default;
  if (typeof analyticsAdapter === 'function') {
    analyticsOdataRouter = (req, res, next) => {
      contextMw(req, res, (err) => {
        if (err) return next(err);
        authMw(req, res, (err) => {
          if (err) return next(err);
          analyticsAdapter(req, res, next);
        });
      });
    };
  } else {
    cds.log('analytics').warn('AnalyticsService OData adapter not found — /admin/analytics may 404');
  }

  // Wire the real streaming handler for GET /admin/exports/exportLegacyData now
  // that cds.middlewares (context + auth) are available.
  wireExportsBridge();

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

      const isAdmin = !!(user?.is && user.is('Admin'));
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
        user,
        pageContext: effectivePageContext
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

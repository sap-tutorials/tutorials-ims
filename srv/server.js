import cds from '@sap/cds';
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerJobs } from './jobs/scheduler.js';
import { autoPurgeOnce } from './lib/purge-stale-changelog.js';
import { qrcodeHandler } from './lib/qrcode-handler.js';
import { buildCatalogHandler } from './lib/build-catalog.js';
import { coCompletionsHandler } from './lib/co-completion.js';
import { recommendationsHandler } from './handlers/recommendations.js';
import { navigatorCatalogHandler, invalidateNavigatorCache } from './lib/navigator-catalog.js';
import { breadcrumbContextHandler } from './lib/breadcrumb-context.js';
import { missionDetailHandler } from './lib/branch/mission-detail.js';
import { decideHandler } from './lib/branch/decide.js';
import { getTagLabelMap } from './lib/tag-label-map.js';
import { myProgressHandler } from './lib/my-progress-handler.js';
import { basicAuthMiddleware } from './lib/tech-user-auth.js';
import { contentAuthMiddleware, publishHandler, serveHandler, hashesHandler, sourceHashesHandler, navHandler, rollbackHandler, invalidateRenderCache, beginHandler, appendHandler, commitHandler, abortHandler } from './lib/content-store.js';
import { repoCatalogReadHandler, repoCatalogWriteHandler } from './lib/repo-catalog.js';
import * as advocatesPublic from './routes/advocates-public.js';
import * as devtoberfestPublic from './routes/devtoberfest-public.js';
import * as devtoberfestAuth from './routes/devtoberfest-auth.js';
import { resolveUser, captureUserMiddleware } from './lib/resolve-user.js';
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
import { codeCheckSpecPublishHandler } from './lib/code-check-spec-publish.js';
import { publishValidateAnswerSpecs } from './lib/validate-answer-spec-publish.js';
import { resolveSearchSettings } from './lib/runtime-config/search-settings.js';
import { resolveTenantSettings } from './lib/runtime-config/tenant-settings.js';
import { makeValidateAnswerHandler } from './lib/validate-answer-handler.js';
import { defaultLoadQuestion } from './lib/validate-answer-question-loader.js';
import { scheduleRebuild, checkFeatureFlag as checkRebuildTriggerFeatureFlag } from './lib/rebuild-trigger.js';
import { classifyRebuildMode, resolveSlugForEntity, resolveSlugsForTagRename, TAG_REVERSE_LOOKUP_CAP } from './lib/_classify-rebuild-mode.js';
import { handleUIEvent, checkFeatureFlag as checkUIEventFeatureFlag } from './lib/ui-event-handler.js';
import { backfillUserProfile, resolveDbUser } from './lib/resolve-db-user.js';
import { registerMigrationModeHandler } from './lib/migration-mode.js';
import multer from 'multer';
import { uploadAndUpsertAdvocatePhoto } from './lib/advocate-photo-upsert.js';

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

// Scope express.static's directory-redirect disable to Windows only.
//
// Why: CAP serves app/ as static content via express.static. On Windows
// the filesystem is case-insensitive, so /admin/Tutorials matches the
// physical directory app/admin/tutorials/ and serve-static issues a 301
// → /admin/Tutorials/ which OData parses as Tutorials('') → UUID
// validation error (commit 5c1cdfb2).
//
// Why scoped: the original fix disabled redirects GLOBALLY for every
// express.static() call in the process — including the one inside
// swagger-ui-express. The swagger UI uses RELATIVE script src URLs
// (e.g. <script src="./swagger-ui-bundle.js">), so its HTML page at
// /$api-docs/admin needs the standard 301 → /$api-docs/admin/ redirect
// to resolve assets correctly. Without it, `./swagger-ui-bundle.js`
// resolves against the no-trailing-slash URL → /$api-docs/swagger-ui-bundle.js
// (one level too shallow) → 404 → approuter catch-all serves index.html
// → MIME mismatch errors in DevTools.
//
// Linux production doesn't have the case-insensitive-FS collision, so
// scoping the disable to Windows is safe in prod and restores
// swagger-ui-express on Cloud Foundry.
const _static = express.static;
express.static = function(root, options) {
  const isWindows = process.platform === 'win32';
  return _static(root, isWindows ? { redirect: false, ...options } : options);
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
  // in CF.
  // Phase 3 (#466): CORS allowlist resolved per-request from TenantSettings
  // (resolver caches the underlying string for 5s, so the new Set() cost is
  // microseconds × ~once-per-5s × N requests). Hardcoded localhost fallback
  // moved into the resolver's DEFAULTS.allowedCorsOrigins.
  app.use(async (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const { allowedCorsOrigins } = await resolveTenantSettings();
      const allowed = new Set(
        allowedCorsOrigins.split(',').map((s) => s.trim()).filter(Boolean)
      );
      if (allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Vary', 'Origin');
      }
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

  // [#204] POST /api/ui-event — anonymous A/B telemetry batch endpoint.
  // Registered BEFORE basicAuthMiddleware because the tracker fires from
  // anonymous browser sessions (no XSUAA token, no basic auth). Behind
  // UI_EVENTS_ENABLED env flag (dormant by default = 503; tracker
  // self-disables on 503). 64 KB express limit matches sendBeacon's hard cap.
  // See srv/lib/ui-event-handler.js + docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md.
  app.post('/api/ui-event', express.json({ limit: '64kb' }), handleUIEvent);

  app.use(basicAuthMiddleware);
  app.get('/api/qrcode', qrcodeHandler);
  app.get('/api/recommendations', recommendationsHandler);
  app.get('/api/branches/decide', decideHandler);
  app.get('/build/catalog', buildCatalogHandler);
  app.get('/build/co-completions', coCompletionsHandler);
  app.get('/build/mission/:slug', missionDetailHandler);
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

  // Public read for the developer-advocates page (Task 4.4 of advocates impl).
  // Spec: docs/superpowers/specs/2026-06-17-developer-advocates-design.md
  advocatesPublic.register(app);
  devtoberfestPublic.register(app);
  devtoberfestAuth.register(app);

  // Content persistence endpoints
  app.get('/content/nav', navHandler);
  app.get('/content/hashes', hashesHandler);
  // PR #591: source-of-truth markdown hashes for the daily drift workflow.
  // Public-read like /content/hashes; see srv/lib/content-store.js for the
  // rationale (rendered HTML is volatile-by-design, source markdown isn't).
  app.get('/content/source-hashes', sourceHashesHandler);
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
  app.post('/content/code-check-specs', express.json({ limit: '5mb' }), contentAuthMiddleware, codeCheckSpecPublishHandler);

  // Validate-answer specs publish endpoint (issue #209). Now uses
  // contentAuthMiddleware (#242) for symmetry with /content/code-check-specs
  // and /content/publish: 503 "Content API not configured" when
  // CONTENT_API_KEY is unset, 401 missing/403 wrong key, timing-safe.
  // REPLACE-per-slug semantics: each call clears and re-inserts the slug's
  // ValidateAnswerSpecs rows in one transaction.
  app.post('/content/validate-answer-specs',
    express.json({ limit: '5mb' }),
    contentAuthMiddleware,
    publishValidateAnswerSpecs
  );

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

  // Advocate photo upload — multipart/form-data REST endpoint (issue #417).
  // Replaces the base64-over-OData $batch shape with a canonical binary
  // upload, removing the ~25% base64 inflation and freeing the codebase
  // from the @cds.server.body_parser.limit: '8mb' annotation on
  // AdminService that the old path required.
  //
  // Reserved BEFORE CAP mounts AdminService at /admin (the OData adapter
  // would otherwise intercept /admin/advocates/* and return 'Invalid
  // resource path'). Same pattern as /admin/analytics/export above.
  //
  // Auth: cds.middlewares.auth() gates on the user being authenticated
  // (XSUAA in prod, mocked admin in tests). AdminService.@requires('Admin')
  // would normally enforce the scope at the service layer, but for a raw
  // express route we have to gate explicitly. Done inside the handler:
  // req.user.is('Admin') must be true. cds.middlewares.context() populates
  // req.user with the authenticated identity.
  //
  // Multer config: 5 MB hard limit on the file size matches the existing
  // client-side cap in AdvocatePhotoController.js. memoryStorage keeps the
  // bytes in a Buffer for direct hand-off to the sharp pipeline — no
  // /tmp/ files. Single 'photo' field.
  const _photoContextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const _photoAuthMw    = cds.middlewares?.auth?.()    || ((req, res, next) => next());
  const _photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });
  app.post('/admin/advocates/:slug/photo',
    _photoContextMw, _photoAuthMw,
    // Capture the authenticated user onto req._capturedUser BEFORE multer
    // runs. Tom hit a 401 "Authentication required" 2026-06-22 even with
    // PR #535 in place — multer's busboy-based stream parser can drop the
    // AsyncLocalStorage scope that cds.middlewares.context() establishes,
    // so cds.context.user reads as null/anonymous AFTER multer fires its
    // callback. Capturing here preserves the user across the stream parse.
    // See srv/lib/resolve-user.js header for the full rationale.
    captureUserMiddleware(cds),
    (req, res, next) => {
      // Surface multer errors (oversize, bad MIME, missing field) as 400
      // with the error.code visible so the client can distinguish 'too
      // large' from 'no field'. Without this wrapper multer's MulterError
      // bubbles to the global error handler and the response shape varies
      // between CAP versions.
      _photoUpload.single('photo')(req, res, (err) => {
        if (err) {
          // multer.MulterError has .code (e.g. 'LIMIT_FILE_SIZE'); plain
          // Error doesn't. Both get message text echoed in the response.
          const code = err.code || 'UPLOAD_ERROR';
          return res.status(400).json({ error: code, message: err.message });
        }
        next();
      });
    },
    async (req, res) => {
      try {
        // Admin scope check. AdminService.@requires('Admin') applies to
        // OData ops served at /admin/<entity>; this REST route bypasses
        // CAP's service-layer gate so we enforce here.
        //
        // Resolution order (see srv/lib/resolve-user.js):
        //   1. req._capturedUser — stashed by captureUserMiddleware BEFORE
        //      multer ran. Survives the AsyncLocalStorage scope drop that
        //      busboy can cause.
        //   2. cds.context.user — canonical CAP source, may have been lost
        //      after multer fired its callback.
        //   3. req.user — legacy fallback for mocked-auth / basic-auth.
        // First candidate with a real (non-anonymous) id wins.
        const user = resolveUser(req, cds);
        if (!user) {
          return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Authentication required' });
        }
        if (typeof user.is === 'function' && !user.is('Admin')) {
          return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin scope required' });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'MISSING_FIELD', message: "missing 'photo' field in multipart body" });
        }
        const { slug } = req.params;
        if (!slug || typeof slug !== 'string') {
          return res.status(400).json({ error: 'BAD_SLUG', message: 'slug path param required' });
        }
        // Resolve slug → advocate ID. Service-level uniqueness is enforced
        // elsewhere (see scripts/dedupe checks); we just need the FK to
        // upsert against.
        const db = await cds.connect.to('db');
        const { Advocates } = cds.entities('com.sap.developers.ims');
        const adv = await db.run(
          SELECT.one.from(Advocates).columns('ID', 'slug').where({ slug: slug.toLowerCase() }),
        );
        if (!adv) {
          return res.status(404).json({ error: 'NOT_FOUND', message: `no advocate with slug '${slug}'` });
        }
        const result = await uploadAndUpsertAdvocatePhoto({
          advocateID: adv.ID,
          slug: adv.slug,
          buffer: req.file.buffer,
          mimeType: req.file.mimetype,
        });
        return res.json({
          slug: adv.slug,
          sizeBytes: result.sizeBytes,
          sha256: result.sha256,
          photoUrl: result.photoUrl,
        });
      } catch (e) {
        // processUpload throws on invalid MIME, oversize (extra defense
        // beyond multer's limit), animated GIFs, unparseable bytes.
        const code = /unsupported MIME/i.test(e.message) ? 'BAD_MIME'
                   : /too large/i.test(e.message) ? 'TOO_LARGE'
                   : /animated/i.test(e.message) ? 'ANIMATED'
                   : /invalid image/i.test(e.message) ? 'BAD_IMAGE'
                   : 'UPLOAD_FAILED';
        return res.status(400).json({ error: code, message: e.message });
      }
    });

  // AnalyticsService at /admin/analytics (after this reservation), so calling next()
  // passes the request through to the AnalyticsService OData layer registered by CDS.
  app.use('/admin/analytics', (req, res, next) => analyticsOdataRouter(req, res, next));

  // Reserve GET /admin/exports/exportLegacyData BEFORE CAP mounts ExportsService at
  // /admin/exports. Without this, AdminService's OData adapter (mounted at /admin)
  // would intercept the path first and return "Invalid resource path". Auth +
  // streaming logic are bound lazily in 'served' via wireExportsBridge().
  registerExportsBridge(app);

  // Reserve POST /api/codecheck and POST /api/validate-answer BEFORE CAP mounts
  // DeveloperService at /api. Without this, DeveloperService's OData adapter
  // (mounted at /api by `cds.serve`) intercepts /api/* path segments first and
  // returns "Invalid resource path" — the express handlers mounted in 'served'
  // never get a chance to match. Issue #314 surfaced the resulting 404.
  // Auth + context middlewares are looked up the same way the export bridge
  // above does — fall back to a no-op when CAP middlewares aren't yet wired.
  const _apiContextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const _apiAuthMw    = cds.middlewares?.auth?.()    || ((req, res, next) => next());

  // AI code-check endpoint (issue #171). Body limit is conservative (64 KB) —
  // the handler itself enforces the 20 KB code cap. Rate limits (30/hour per
  // user, 5/5min per step) are enforced inside the handler too.
  const codeCheckHandler = makeCodeCheckHandler({
    callModel: defaultCallModel,
    loadStepText: defaultLoadStepText,
  });
  app.post('/api/codecheck',
    express.json({ limit: '64kb' }),
    _apiContextMw, _apiAuthMw,
    (req, res, next) => Promise.resolve(codeCheckHandler(req, res)).catch(next)
  );

  // AI free-text answer grader (issue #209). Same auth + rate-limit shape as
  // /api/codecheck. Body cap is smaller (5 KB inside the handler) — text
  // answers are smaller than code. defaultCallModel is reused as-is from
  // code-check-llm.js; only the schema differs (passed via dispatch).
  const validateAnswerHandler = makeValidateAnswerHandler({
    callModel: defaultCallModel,
    loadQuestion: defaultLoadQuestion,
  });
  app.post('/api/validate-answer',
    express.json({ limit: '64kb' }),
    _apiContextMw, _apiAuthMw,
    (req, res, next) => Promise.resolve(validateAnswerHandler(req, res)).catch(next)
  );

  // Per-IP rate limit for the public /search endpoint. Mounted in 'bootstrap'
  // so it runs BEFORE CAP wires SearchService at /search.
  // Phase 3 (#466): Lazy rate-limiter — resolver returns DB-backed values
  // (with 5s cache). Counter resets on rebuild within the cache window.
  // Documented in PR body as bounded surface widening (~120 req/10s burst).
  let _cachedLimiter = null;
  let _cachedLimiterAt = 0;
  const LIMITER_TTL_MS = 5_000;

  async function getSearchLimiter() {
    const now = Date.now();
    if (_cachedLimiter && (now - _cachedLimiterAt) < LIMITER_TTL_MS) return _cachedLimiter;
    const { rateLimitMax, rateLimitWindowMs } = await resolveSearchSettings();
    _cachedLimiter = createIpRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax });
    _cachedLimiterAt = now;
    return _cachedLimiter;
  }

  app.use('/search', async (req, res, next) => {
    const limiter = await getSearchLimiter();
    return ipRateLimitMiddleware(limiter, { logName: 'search-rate-limit' })(req, res, next);
  });
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

  // #658 — one-shot purge of accumulated noise rows in sap.changelog.Changes
  // for entities whose @changelog annotation was retroactively dropped. Held
  // behind a JobLocks sentinel so it runs exactly once per CF deploy across
  // all instances. Failure here MUST NOT crash boot — it's a housekeeping
  // task, not a startup requirement.
  if (!globalThis.__changelogNoisePurgeAttempted) {
    globalThis.__changelogNoisePurgeAttempted = true;
    autoPurgeOnce({ version: 'v1' })
      .then((res) => {
        if (res.alreadyRan) {
          cds.log('purge-stale-changelog').debug('Purge sentinel already held');
        } else {
          cds.log('purge-stale-changelog').info(
            `Auto-purged ${res.deleted} stale changelog rows on first boot`,
          );
        }
      })
      .catch((err) => {
        cds.log('purge-stale-changelog').warn(
          'Auto-purge failed (non-fatal):',
          err.message,
        );
      });
  }

  // Bust the /build/navigator in-memory cache when admins write to entities that
  // shape the navigator response. Without this, the 5-minute TTL serves stale
  // mission/group data after CRUD via AdminService.
  if (!globalThis.__navigatorCacheInvalidatorRegistered) {
    const admin = await cds.connect.to('AdminService');
    // #429: classifier-driven rebuild. Each entity routes to a different
    // mode via classifyRebuildMode(); Steps + Tags added so their CRUD
    // also triggers a (slug-targeted or full+force-cap-refetch) rebuild.
    const navInvalidatingEntities = ['Missions', 'Groups', 'CompletionPaths', 'CompletionPathItems', 'GroupPathItems', 'Tutorials', 'Steps', 'FeaturedTasks', 'Tags'];
    admin.after(['CREATE', 'UPDATE', 'DELETE'], navInvalidatingEntities, async (_data, req) => {
      // #429: migration-mode short-circuit. Bulk migration scripts set
      // x-migration-mode: true and dispatch one final rebuild at end-of-run.
      // Per-row triggers during a migration would dispatch hundreds of
      // workflow runs (all debounced into one full, but still wasteful).
      if (req.headers?.['x-migration-mode'] === 'true') return;

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

      // [#174 PR 3, #429, #541] Schedule a rebuild. classifyRebuildMode routes the
      // entity to the cheapest valid mode (catalog-only/slug-targeted/full).
      const entityName = req.target?.name?.split('.').pop();
      if (!entityName) return;
      const { mode, forceCapRefetch, needsSlug, needsSlugsByTag } = classifyRebuildMode(entityName, 'crud');

      // #541: Tag CRUD does a reverse-lookup to find affected tutorials. If
      // 1..TAG_REVERSE_LOOKUP_CAP slugs come back, dispatch slug-targeted per
      // slug (debounced into one workflow run with comma-separated `slugs`).
      // Otherwise (0 or >cap) fall back to full+force-cap-refetch — the pre-#541
      // behavior. Empty result usually means the tag has no tutorials yet.
      if (needsSlugsByTag) {
        const slugs = await resolveSlugsForTagRename(req.data?.ID);
        if (slugs.length >= 1 && slugs.length <= TAG_REVERSE_LOOKUP_CAP) {
          for (const s of slugs) {
            scheduleRebuild('admin-write', { mode: 'slug-targeted', slug: s }).catch(err => {
              console.error('[rebuild-trigger] scheduling failed', err);
            });
          }
          return;
        }
        // 0 or >cap → log + fall through to full+force-cap-refetch.
        if (slugs.length > TAG_REVERSE_LOOKUP_CAP) {
          console.log(`[rebuild-trigger] Tag id=${req.data?.ID} affects ${slugs.length} tutorials (>${TAG_REVERSE_LOOKUP_CAP} cap); using full+force-cap-refetch instead of N slug-targeted dispatches`);
        }
        scheduleRebuild('admin-write', { mode: 'full', forceCapRefetch: true }).catch(err => {
          console.error('[rebuild-trigger] scheduling failed', err);
        });
        return;
      }

      let slug = null;
      if (needsSlug) {
        slug = await resolveSlugForEntity(entityName, req.data);
        if (!slug) {
          console.warn(`[rebuild-trigger] slug lookup failed for ${entityName} (id=${req.data?.ID}); falling back to full mode`);
          scheduleRebuild('admin-write', { mode: 'full' }).catch(err => {
            console.error('[rebuild-trigger] scheduling failed', err);
          });
          return;
        }
      }

      scheduleRebuild('admin-write', { mode, slug, forceCapRefetch }).catch(err => {
        console.error('[rebuild-trigger] scheduling failed', err);
      });
    });

    // #429: bound-action hooks for catalog-affecting actions that don't go
    // through standard CRUD. The classifier returns 'catalog-only' or
    // 'full+force-cap-refetch' depending on the action; we don't need a slug
    // because no bound action targets a specific tutorial.
    const CATALOG_AFFECTING_ACTIONS = ['classifyCategories', 'setFeaturedOrder', 'commitTagImport', 'cleanupUnusedTags'];
    for (const actionName of CATALOG_AFFECTING_ACTIONS) {
      admin.after(actionName, async (_data, req) => {
        if (req.headers?.['x-migration-mode'] === 'true') return;
        const { mode, forceCapRefetch } = classifyRebuildMode(actionName, 'action');
        scheduleRebuild(`admin-action:${actionName}`, { mode, forceCapRefetch }).catch(err => {
          console.error('[rebuild-trigger] scheduling failed', err);
        });
      });
    }
    globalThis.__navigatorCacheInvalidatorRegistered = true;
  }

  // Skip @cap-js/change-tracking output for admin-authenticated bulk-migration
  // requests that send `x-migration-mode: true`. Sets `ct.skip` session var on
  // the DB tx; reset in paired after-handler. See spec #394.
  if (!globalThis.__migrationModeRegistered) {
    registerMigrationModeHandler();
    globalThis.__migrationModeRegistered = true;
  }

  // [#201] Register after-hooks that keep the categories facet cache warm
  // after admin writes to Missions, Groups, and Tutorials.
  if (!globalThis.__categoryHooksRegistered) {
    const { register: registerCategoryHooks } = await import('./handlers/categories-after-hooks.js');
    const adminSrv = await cds.connect.to('AdminService');
    registerCategoryHooks(adminSrv);
    globalThis.__categoryHooksRegistered = true;
  }

  // [#174 PR 3] Boot warning: check if rebuild-trigger feature flag is enabled.
  checkRebuildTriggerFeatureFlag();

  // [#204 PR 1] Boot warning: check if UI-event A/B telemetry flag is enabled.
  checkUIEventFeatureFlag();

  // [#204 PR 4] Seed canonical SavedQueries for the / vs /browse/ A/B
  // comparison runbook. Idempotent — safe to re-fire across cds.test() runs.
  // Wrapped in a try/catch so a seed failure can't crash boot; the surface
  // can still publish telemetry and admins can hand-author queries.
  if (!globalThis.__uiEventSavedQueriesSeeded) {
    globalThis.__uiEventSavedQueriesSeeded = true;
    try {
      const { seedUIEventSavedQueries } = await import('./lib/ui-event-saved-queries.js');
      const result = await seedUIEventSavedQueries(cds.db);
      if (result.inserted > 0) {
        console.log(`[ui-event-saved-queries] seeded ${result.inserted}/${result.total} canonical queries`);
      }
    } catch (err) {
      console.warn('[ui-event-saved-queries] seed failed (non-fatal):', err.message);
    }
  }

  // [#240] Seed canonical SavedQueries for AI-grading token-spend monitoring
  // (covers both /api/codecheck and /api/validate-answer). Idempotent;
  // non-fatal on seed failure (admins can hand-author these queries).
  if (!globalThis.__aiGradingSavedQueriesSeeded) {
    globalThis.__aiGradingSavedQueriesSeeded = true;
    try {
      const { seedAiGradingSavedQueries } = await import('./lib/ai-grading-saved-queries.js');
      const result = await seedAiGradingSavedQueries(cds.db);
      if (result.inserted > 0) {
        console.log(`[ai-grading-saved-queries] seeded ${result.inserted}/${result.total} canonical queries`);
      }
    } catch (err) {
      console.warn('[ai-grading-saved-queries] seed failed (non-fatal):', err.message);
    }
  }

  app.get('/auth/user', contextMw, authMw, async (req, res) => {
    const user = cds.context?.user;
    if (!user?.id || user.id === 'anonymous') {
      return res.status(401).json({ authenticated: false });
    }
    // Issue #339: opportunistically backfill firstName/lastName/email on the
    // migrated Users row from JWT claims. The migrator copies SAP_ID and
    // pre-computed totals only — IMS Java JIT-fetched names from SAP IDP and
    // never persisted them. SAP ID Service has no SCIM bulk API, so this
    // per-request lazy fill is the only path post-cutover. Fire-and-forget;
    // never block the response on a write that's pure self-heal.
    backfillUserProfile(user).catch(err =>
      console.warn('[backfill-user-profile]', err.message));
    // Issue #566: fetch Khoros link state from the Users row. We need a DB read
    // here because the JWT never carries khorosId/khorosLogin/khorosAvatarUrl —
    // those are stored in HANA. Null for unlinked users; always emits the keys
    // so the frontend can distinguish null (unlinked) from undefined (old API).
    let khorosId = null;
    let khorosLogin = null;
    let khorosAvatarUrl = null;
    try {
      const dbUser = await resolveDbUser(user, ['khorosId', 'khorosLogin', 'khorosAvatarUrl']);
      if (dbUser) {
        khorosId       = dbUser.khorosId       ?? null;
        khorosLogin    = dbUser.khorosLogin    ?? null;
        khorosAvatarUrl = dbUser.khorosAvatarUrl ?? null;
      }
    } catch (err) {
      console.warn('[auth/user] khoros lookup failed (non-fatal):', err.message);
    }
    res.json({
      authenticated: true,
      id: user.id,
      email: user.attr?.email || '',
      givenName: user.attr?.given_name || user.attr?.givenName || '',
      familyName: user.attr?.family_name || user.attr?.familyName || '',
      isAdmin: user.is?.('Admin') === true,
      khorosId,
      khorosLogin,
      khorosAvatarUrl,
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

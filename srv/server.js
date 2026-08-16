import cds from '@sap/cds';
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripPrecompiledPluginRoots } from './lib/strip-precompiled-plugin-roots.js';
import { bustPublishedConceptsCache } from './lib/kg-published-concepts-cache.js';

import { autoPurgeOnce } from './lib/purge-stale-changelog.js';
import { resolveDeployEnvironment } from './lib/deploy-environment.js';
import { versionHandler } from './lib/version-handler.js';
import { qrcodeHandler } from './lib/qrcode-handler.js';
import { buildCatalogHandler } from './lib/build-catalog.js';
import { buildConceptsHandler } from './lib/build-concepts.js';
import { buildTopicClustersHandler } from './lib/build-topic-clusters.js';
import { buildTopicsGalleryHandler } from './lib/build-topics-gallery.js';
import { exploreDataHandler } from './lib/build-explore-data.js';
import { clustersDataHandler } from './lib/build-clusters-data.js';
import { graphPathHandler } from './lib/graph-path-route.js';
import { coCompletionsHandler } from './lib/co-completion.js';
import { recommendationsHandler } from './handlers/recommendations.js';
import { navigatorCatalogHandler, invalidateNavigatorCache } from './lib/navigator-catalog.js';
import { breadcrumbContextHandler } from './lib/breadcrumb-context.js';
import { missionDetailHandler } from './lib/branch/mission-detail.js';
import { decideHandler } from './lib/branch/decide.js';
import { getTagLabelMap } from './lib/tag-label-map.js';
import { myProgressHandler } from './lib/my-progress-handler.js';
import { basicAuthMiddleware } from './lib/tech-user-auth.js';
import { contentAuthMiddleware, publishHandler, serveHandler, pageServeHandler, authorServeHandler, advocateServeHandler, hashesHandler, sourceHashesHandler, navHandler, rollbackHandler, orphanPurgeHandler, invalidateRenderCache, beginHandler, appendHandler, commitHandler, abortHandler, pipelineLogFailureHandler } from './lib/content-store.js';
import { bumpCacheGeneration } from './lib/content-cache-coherence.js';
import { conceptsIndexHandler } from './lib/concept-list-page.js';
import { renderConceptsHandler } from './lib/publish-concepts.js';
import { repoCatalogReadHandler, repoCatalogWriteHandler } from './lib/repo-catalog.js';
import { modelJsonHandler } from './lib/model-json-handler.js';
import { kgStatsHandler } from './routes/kg-stats.js';
import * as advocatesPublic from './routes/advocates-public.js';
import * as devtoberfestPublic from './routes/devtoberfest-public.js';
import * as devtoberfestSchedule from './routes/devtoberfest-schedule.js';
import * as devtoberfestAuth from './routes/devtoberfest-auth.js';
import * as alertsPublic from './routes/alerts-public.js';
import * as deployEvents from './routes/deploy-events.js';
import { invalidate as invalidateAlertsCache } from './lib/alerts-cache.js';
import { resolveUser, captureUserMiddleware } from './lib/resolve-user.js';
import { patMiddleware, pinPatUserToContext } from './lib/mcp-pat-middleware.js';
import makeComposeRouter, { flags as mcpFlags } from './lib/mcp-compose-router.js';
import { buildSystemPrompt } from './lib/chat-context.js';
import { createRateLimiter, RateLimitError } from './lib/chat-rate-limit.js';
import { createIpRateLimiter, ipRateLimitMiddleware } from './lib/ip-rate-limit.js';
import { streamChat } from './lib/chat-orchestrator.js';
import { buildChatInvocation } from './lib/chat-invocation.js';
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
import { provisionDbUser, resolveDbUser } from './lib/resolve-db-user.js';
import { registerMigrationModeHandler } from './lib/migration-mode.js';
import multer from 'multer';
import { uploadAndUpsertAdvocatePhoto } from './lib/advocate-photo-upsert.js';
import { uploadPetSubmission } from './lib/petoberfest-upload.js';
import { fetchPetPhoto } from './lib/petoberfest-photo-store.js';
import { installDbWrap } from './lib/metrics-db-wrap.js';
import './graphql-config.js';
import { makeA2aRouter } from './lib/a2a/rpc-router.js';
import { buildAgentCard } from './lib/a2a/agent-card.js';
import { resolveA2aSettings } from './lib/runtime-config/a2a-settings.js';

// #1182 — cds-caching resolve-guard fix. This module is evaluated by cds-serve
// AFTER `await cds.plugins` (so the cds-caching plugin has already pushed its
// `db/cache-store` + `db/statistics` roots into cds.env.roots under store:'cds'
// + metrics) but BEFORE cds-serve resolves the model (`await cds.load('*')` at
// @sap/cds/server.js:51). When a precompiled srv/csn.json is present (CF
// production), those plugin roots would tip CF's resolve-guard past
// `files.length === 1`, forcing a re-merge of every requires[].model onto the
// already-complete csn → "Duplicate definition" crash-loop (#1179 revert / #1182).
// The cds_caching entities are baked into srv/csn.json by the build task, so the
// runtime push is redundant there — we strip it. No-op in hybrid `cds watch` (no
// precompiled csn → roots kept for source compilation) and in dev/unit
// (store:'memory' → nothing pushed).
//
// WHY module-eval and NOT `cds.on('bootstrap')`: bootstrap does fire before
// model resolution (server.js:41 emit → :51 load), so a handler there would also
// work for the normal `cds serve` path. But the 'bootstrap' event is emitted ONLY
// by @sap/cds/server.js — a bare `cds.serve(...)` / `cds.load('*')` that bypasses
// cds.server never emits it (verified). Running at module-eval time ties the strip
// to server.js being imported, which is the same trigger cds-serve uses, without
// depending on the lifecycle event actually firing. Verified end-to-end: the
// hybrid boot test (test/hybrid/caching-cds-store-boot.test.js) and the CF-boot
// simulation both exercise this path.
{
  const { stripped } = stripPrecompiledPluginRoots(cds);
  if (stripped.length) {
    cds.log('caching').info(
      `#1182: stripped ${stripped.length} cds-caching-injected model root(s) — precompiled csn present, entities already baked in; guard preserved`,
    );
  }
}


// Late-bound POST /chat/stream handler. Registered in 'bootstrap' (before CAP
// mounts ChatService at /chat, which would otherwise swallow /chat/stream as
// an OData resource path). Set in 'served' once cds.middlewares are ready.
let chatStreamHandler = (req, res) => res.status(503).json({ error: 'service_starting' });

// Late-bound POST /a2a handler. Same pattern as chatStreamHandler — registered
// in 'bootstrap' before CAP mounts A2aService at /a2a, wired in 'served'. (#1220)
let a2aHandler = (req, res) => res.status(503).json({ jsonrpc: '2.0', error: { code: -32603, message: 'A2A not ready' }, id: req.body?.id ?? null });

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

// #805 — Late-bound Express handler for /admin/metrics/live. Same trap as
// /admin/analytics/* above: AdminService's OData adapter mounts at /admin
// and would otherwise intercept as "Invalid resource path AdminService.metrics.live".
// The stub returns 503 during boot; the third cds.on('served') handler
// (at bottom of this file) wires the real handler.
let metricsLiveHandler = (req, res) => res.status(503).json({ error: 'service_starting' });

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

// Helper: set ETag + Cache-Control on a pet photo response and send the buffer.
// Public route: ETag on sha256, 5-min cache w/ revalidation (permits fast takedown of hidden photos).
// Admin route: private, non-cacheable (photo may be in any moderation state).
function sendPetPhoto(res, p, { isPrivate = false } = {}) {
  res.setHeader('Content-Type', p.mimeType || 'image/webp');
  if (isPrivate) {
    res.setHeader('Cache-Control', 'private, no-store');
  } else {
    res.setHeader('ETag', `"${p.sha256}"`);
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  }
  return res.send(p.buffer);
}

cds.on('bootstrap', (app) => {
  // #1105: copy the PAT synthetic user (req.user, tokenSource==='pat') onto
  // cds.context.user, immediately AFTER CAP's built-in `auth` middleware. The
  // /mcp-pat/* bootstrap middleware (below) authenticates the PAT and strips
  // the Bearer header so xsuaa/ias no-op; this step then re-asserts the PAT
  // identity inside the per-request ALS scope so @cap-js/mcp's checkAuthorization
  // (which reads cds.context.user) sees an authenticated user. No-op for
  // non-PAT requests. Registered here (bootstrap) before services are served.
  if (cds.middlewares?.add) {
    cds.middlewares.add(pinPatUserToContext, { after: 'auth' });
  }

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

  // GET /version — unauthenticated build-metadata endpoint. Registered BEFORE
  // basicAuthMiddleware so monitors/humans can read it without a token. See
  // docs/superpowers/specs/2026-07-25-mta-versioning-design.md.
  app.get('/version', versionHandler);

  app.use(basicAuthMiddleware);
  app.get('/api/qrcode', qrcodeHandler);
  app.get('/api/recommendations', recommendationsHandler);
  app.get('/api/branches/decide', decideHandler);
  app.get('/build/catalog', buildCatalogHandler);
  app.get('/build/kg-stats', kgStatsHandler);
  app.get('/build/concepts', buildConceptsHandler);
  app.get('/build/topic-clusters', buildTopicClustersHandler);
  app.get('/build/topics-gallery', buildTopicsGalleryHandler);
  app.get('/graph/explore-data', exploreDataHandler);
  app.get('/graph/clusters-data', clustersDataHandler);
  app.get('/graph/path', graphPathHandler);
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
    // Shared, non-personalized feed — 60s edge cache like the other /build/* feeds.
    res.set('Cache-Control', 'public, max-age=60');
    res.json(mapping);
  });
  app.get('/build/repo-catalog', repoCatalogReadHandler);
  app.post('/build/repo-catalog', express.json({ limit: '10mb' }), contentAuthMiddleware, repoCatalogWriteHandler);

  // (#639) Build-time data for Hugo homepage shelves — consumed by fetch-tutorials.ts at build time.
  // Public, unauthenticated. Cache-Control 60s (Hugo fetches once per build, not per request).
  app.get('/build/homepage-shelves', async (_req, res) => {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves')
        .where({ isActive: true })
        .orderBy('verb', 'shelf', 'sortOrder'));
      // (#1726) Apply the admin link-health override at bake time. The Hugo
      // verb-page + directory-footer filters hide rows whose baked linkStatus
      // is BROKEN. linkStatusOverride is normally folded into linkStatus by the
      // nightly link-health job — but an admin who pins the override to silence
      // a false-BROKEN also triggers a catalog rebuild immediately, well before
      // that job runs. Without coalescing here, the rebuild bakes the stale
      // BROKEN status and the entry stays hidden until the next nightly run +
      // rebuild. Override wins; a null override leaves linkStatus untouched.
      const shelves = rows.map((r) =>
        r.linkStatusOverride ? { ...r, linkStatus: r.linkStatusOverride } : r);
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ shelves, buildAt: new Date().toISOString() });
    } catch (err) {
      console.error('[build/homepage-shelves]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // (#759) Build-time data for the homepage explainer popovers. Mirrors
  // /build/homepage-shelves above — unauthenticated, 60s Cache-Control,
  // structured payload. Consumed by scripts/fetch-verb-definitions.ts
  // and scripts/fetch-shelf-definitions.ts at build time.
  //
  // NOTE: reads direct from raw entity, NOT through AdminService. The
  // route is anonymous; routing through AdminService would trip its
  // @requires: 'Admin' chain. Auto-init handlers (srv/admin-service.js)
  // are admin-side only — fresh subaccount with no seed import + no
  // admin read = empty array here. The fetcher script (next task)
  // treats empty-array as a warn-and-continue, matching the
  // /build/homepage-shelves precedent (plan Decision 6).
  app.get('/build/verb-definitions', async (_req, res) => {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        SELECT.from('com.sap.developers.ims.VerbDefinitions').orderBy('sortOrder')
      );
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ verbs: rows, buildAt: new Date().toISOString() });
    } catch (err) {
      console.error('[build/verb-definitions]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // (#1032) Build-time data for Hugo featured topics carousel — consumed by
  // scripts/fetch-tutorials.ts at build time. Public, unauthenticated.
  // Cache-Control 60s (Hugo fetches once per build, not per request).
  app.get('/build/featured-topics', async (_req, res) => {
    try {
      const { readSnapshotForFeed } = await import('./lib/featured-topics-snapshot.js');
      const tx = cds.tx({});
      try {
        const { computedAt, slots, etag } = await readSnapshotForFeed(tx);
        res.set('Cache-Control', 'public, max-age=60');
        res.set('ETag', etag);
        res.json({ computedAt, etag, snapshot: slots, buildAt: new Date().toISOString() });
      } finally {
        await tx.commit();
      }
    } catch (err) {
      console.error('[build/featured-topics]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Featured curated tasks — consumed by Tutorial Navigator at build/runtime.
  // Public, unauthenticated. ETag + 304 support. 60s CDN/browser cache.
  app.get('/build/featured', async (req, res) => {
    try {
      const { getFeaturedPayload } = await import('./lib/featured-resolve.js');
      const db = await cds.connect.to('db');
      const payload = await getFeaturedPayload(db);
      res.set('Cache-Control', 'public, max-age=60');
      res.set('ETag', payload.etag);
      if (req.headers['if-none-match'] === payload.etag) {
        return res.status(304).end();
      }
      res.json({ ...payload, buildAt: new Date().toISOString() });
    } catch (err) {
      console.error('[build/featured]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/build/shelf-definitions', async (_req, res) => {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        SELECT.from('com.sap.developers.ims.ShelfDefinitions').orderBy('sortOrder')
      );
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ shelves: rows, buildAt: new Date().toISOString() });
    } catch (err) {
      console.error('[build/shelf-definitions]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Public read for the developer-advocates page (Task 4.4 of advocates impl).
  // Spec: docs/superpowers/specs/2026-06-17-developer-advocates-design.md
  advocatesPublic.register(app);
  devtoberfestPublic.register(app);
  devtoberfestSchedule.register(app);
  devtoberfestAuth.register(app);

  // /api/alerts (anonymous) + /api/alerts/me (authenticated).
  // Spec: docs/superpowers/specs/2026-06-26-548-alert-system-design.md
  // contextMw/authMw obtained lazily here (same pattern as
  // /admin/analytics/export and /admin/advocates/:slug/photo above) so the
  // /api/alerts/me handler sees cds.context.user populated by CAP's auth chain.
  const _alertsContextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const _alertsAuthMw    = cds.middlewares?.auth?.()    || ((req, res, next) => next());
  alertsPublic.register(app, { contextMw: _alertsContextMw, authMw: _alertsAuthMw });

  // Content persistence endpoints
  app.get('/content/nav', navHandler);
  app.get('/content/hashes', hashesHandler);
  // PR #591: source-of-truth markdown hashes for the daily drift workflow.
  // Public-read like /content/hashes; see srv/lib/content-store.js for the
  // rationale (rendered HTML is volatile-by-design, source markdown isn't).
  app.get('/content/source-hashes', sourceHashesHandler);
  app.get('/content/tutorials/*slug', serveHandler);
  // Legacy AEM `.model.json` compatibility for SAP Discovery Center (#DC cards).
  // Approuter maps ^/tutorials/<slug>.model.json$ → here. See srv/lib/model-json.js.
  app.get('/content/tutorial-model/*slug', modelJsonHandler);
  // Concept landing pages (#446 Track 3-A). Concept HTML is stored in
  // ContentFiles with slugs prefixed `concept-<slug>` so the same publish/
  // serve plumbing handles both kinds without a schema change or kind
  // discriminator column.
  //
  // The wrapper canonicalises inbound paths to lowercase + strips `.html`
  // (mirroring the equivalent normalisation inside serveHandler) BEFORE
  // delegating — otherwise serveHandler's redirect paths would 301 to
  // `/tutorials/...` instead of `/concepts/...`. After canonicalisation
  // the lookup just rewrites params.slug to the `concept-<slug>` form.
  app.get('/content/concepts/:slug', (req, res) => {
    const raw = String(req.params.slug || '');
    // Strip .html suffix → 301 to canonical /concepts/<slug>
    if (/\.html$/i.test(raw)) {
      const stripped = raw.replace(/\.html$/i, '').toLowerCase();
      if (/^[a-z0-9][a-z0-9-]*$/.test(stripped)) {
        const qIdx = req.url.indexOf('?');
        const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
        res.setHeader('Location', `/concepts/${stripped}${query}`);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.status(301).end();
      }
    }
    // Mixed-case → 301 to canonical lowercase /concepts/<slug>
    const lower = raw.toLowerCase();
    if (raw && raw !== lower && /^[a-z0-9][a-z0-9-]*$/.test(lower)) {
      const qIdx = req.url.indexOf('?');
      const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
      res.setHeader('Location', `/concepts/${lower}${query}`);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(301).end();
    }
    // Canonical form — delegate to serveHandler with the concept- prefix.
    req.params.slug = `concept-${lower}`;
    return serveHandler(req, res);
  });
  // #1327 Task 2 — CAP-served /concepts/ LIST page (SSR top-100 + embedded JSON
  // for the concepts-filter island). Dark launch: no AppRouter route points
  // here yet (the /concepts/?$ flip lands in Task 5). Public, no auth — like
  // serveHandler.
  app.get('/content/concepts-index', conceptsIndexHandler);
  // #1659 Phase C — CAP-served /authors/{login}/ pages (dynamic slug, unbounded
  // login → author-<login> BLOB). Dark launch: the AppRouter /authors/ flip
  // lands with this change. Public, no auth — like serveHandler.
  app.get('/content/authors/:login', authorServeHandler);
  // #1659 Phase C.2a — CAP-served per-advocate DETAIL pages
  // (/developer-advocates/<slug>/, dynamic slug → advocate-<slug> BLOB). The
  // /developer-advocates/ INDEX is page-developer-advocates (separate route).
  app.get('/content/developer-advocates/:slug', advocateServeHandler);
  // #1659 Task 5 — CAP-served content PAGES. Dark launch: no AppRouter route
  // points here yet (the per-page flips land in Phase 2). Public, no auth —
  // like serveHandler.
  // The bare /content/pages (and trailing-slash form) is the HOMEPAGE: the
  // `*path` wildcard below does NOT match an empty segment, so register it
  // explicitly. pageServeHandler resolves the empty remainder to page-index.
  app.get('/content/pages', pageServeHandler);
  app.get('/content/pages/*path', pageServeHandler);
  app.post('/content/publish', express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
  app.post('/content/publish/begin',  express.json({ limit: '1mb' }),   contentAuthMiddleware, beginHandler);
  app.post('/content/publish/append', express.json({ limit: '100mb' }), contentAuthMiddleware, appendHandler);
  // #1327 Task 3 — render concept detail pages into an open publish session
  // (Thread B). Dark launch: no publish-content.ts caller yet (Task 5 wires
  // it). Auth like the other publish routes.
  app.post('/content/publish/render-concepts', express.json({ limit: '1mb' }), contentAuthMiddleware, renderConceptsHandler);
  app.post('/content/publish/commit', express.json({ limit: '1mb' }),   contentAuthMiddleware, commitHandler);
  app.post('/content/publish/abort',  express.json({ limit: '1mb' }),   contentAuthMiddleware, abortHandler);

  // CI rebuild-failure reporter (#observability): lets rebuild-content(-qa).yml
  // `if: failure()` steps record a FAILED PipelineLog row for failures that
  // happen in CI BEFORE content reaches the srv (Hugo build gate, verify-qa-
  // build, auth 503) — so they surface in the admin PipelineLog instead of only
  // going red in an unwatched CI tab. Same auth as /content/publish.
  app.post('/content/pipeline-log', express.json({ limit: '256kb' }), contentAuthMiddleware, pipelineLogFailureHandler);

  // Deploy lifecycle alerts (#deploy-alerts): scripts/deploy-mta.cjs pings this
  // at start/end/fail of a deploy → ANS. Same bearer auth (CONTENT_API_KEY) as
  // the other ops endpoints. Body parser is applied inside register().
  deployEvents.register(app, { authMw: contentAuthMiddleware });

  // Analytics Builder Phase 1 — streaming CSV export. Mounted later in this
  // bootstrap block (after contextMw/authMw are defined) so req.user is
  // populated by CAP's auth chain before the handler runs.
  app.post('/content/rollback', express.json(), contentAuthMiddleware, rollbackHandler);
  // Issue #orphan-purge — CI-only batched soft-delete. Same auth as /content/publish.
  app.post('/content/orphan-purge', express.json({ limit: '1mb' }), contentAuthMiddleware, orphanPurgeHandler);
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

  // FIX 7: host-header injection guard. Prefer trusted config (DB resolver or
  // VCAP_APPLICATION) over raw request headers. When falling back to headers,
  // mark the response non-cacheable and Vary on the spoofable headers.
  function a2aBaseUrlFallback(req) {
    try {
      const uris = JSON.parse(process.env.VCAP_APPLICATION || '{}').application_uris;
      if (Array.isArray(uris) && uris[0]) return `https://${uris[0]}`;
    } catch { /* fall through */ }
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
  }

  // A2A Agent Card (public discovery) — served on the already-public
  // /.well-known/* approuter route. No secrets; matches A2A discovery model. (#1220)
  app.get('/.well-known/agent-card.json', async (req, res) => {
    const cfg = await resolveA2aSettings();
    const baseUrl = cfg.publicBaseUrl || a2aBaseUrlFallback(req);
    // Always mark private+no-store so a shared cache never serves a card
    // built from one client's Host header to another client.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'X-Forwarded-Host, Host');
    res.json(buildAgentCard({ baseUrl, tokenUrl: cfg.tokenUrl, enabled: cfg.enabled }));
  });

  // A2A consumption guide (public). Read from disk with fs (NOT res.sendFile —
  // sendFile with a file:// URL path is unreliable on Windows). Served from
  // srv/mcp/ (NOT docs/) because docs/ is not packaged into the deployed srv
  // module — cds build copies the whole srv/ tree to gen/srv, so the guide must
  // live under srv/ to reach CF. Mirrors the deployed srv/mcp/prompts/*.md. (#1220)
  app.get('/.well-known/a2a-instructions.md', (_req, res) => {
    try {
      const p = fileURLToPath(new URL('./mcp/a2a-instructions.md', import.meta.url));
      res.type('text/markdown').send(readFileSync(p, 'utf8'));
    } catch (e) {
      cds.log('a2a').warn(`a2a-instructions.md unreadable — ${e.message}`);
      res.status(404).type('text/plain').send('A2A instructions not found');
    }
  });

  // A2A JSON-RPC endpoint. Body parser here; the CAP auth chain wraps it in
  // 'served' (like /chat/stream) so cds.context.user is populated. Reserved in
  // bootstrap before CAP mounts A2aService at /a2a. (#1220)
  app.post('/a2a', express.json({ limit: '64kb' }), (req, res, next) => a2aHandler(req, res, next));

  // MCP_AUTH_ENABLED kill switch — when explicitly set to 'false', return 503
  // for all /mcp-auth and /mcp-pat routes. This must come BEFORE the PAT
  // middleware registration so the kill switch short-circuits the whole stack.
  // (Phase 2 Task 15 #1105)
  if (process.env.MCP_AUTH_ENABLED === 'false') {
    app.use('/mcp-auth', (_req, res) => res.status(503).send('Phase 2 MCP auth disabled'));
    app.use('/mcp-pat',  (_req, res) => res.status(503).send('Phase 2 MCP auth disabled'));
    cds.log('mcp').warn('MCP_AUTH_ENABLED=false — /mcp-auth and /mcp-pat return 503');
  }

  // /mcp-auth/* (OAuth tier) → /mcp/* rewrite (Phase 2 #1105). The approuter
  // fronts /mcp-auth/* with authenticationType:'xsuaa' and forwards the real
  // user JWT verbatim; srv serves MCP at /mcp/<svc> (e.g. /mcp/api), so we
  // re-mount the path here. CAP's auth strategy picks up the forwarded JWT when
  // the request reaches the /mcp/api mount, enforcing @requires:'authenticated-user'
  // on the DeveloperService handlers. Root-level (not app.use('/mcp-auth',…)) for
  // the same re-dispatch reason as the PAT block below. No credential check here
  // — XSUAA already gated it at the approuter; anonymous JWTs are rejected by
  // CAP auth at the mount.
  app.use((req, _res, next) => {
    if (!req.url.startsWith('/mcp-auth/') && req.url !== '/mcp-auth') return next();
    const rest = req.url.slice('/mcp-auth'.length) || '/';
    req.url = '/mcp' + rest;
    if (req.originalUrl) req.originalUrl = req.url;
    next();
  });

  // /mcp-admin/* (OAuth tier, admin tools) → /mcp/admin/* rewrite (Phase 3 WS2 #1106).
  // Mirrors /mcp-auth above. The approuter gates /mcp-admin/* with authenticationType:'xsuaa'
  // + scope:'Tutorial.MCP'; per-action @requires (Admin/SuperAdmin/etc.) hides individual
  // tools at the adapter level. Kill switch: MCP_PHASE3_ENABLED=false or
  // MCP_ADMIN_TOOLS_ENABLED=false both return 503 before the rewrite so no requests reach
  // the mount. Docs guarantee: MCP_PHASE3_ENABLED=false → /mcp-admin/* returns 503.
  app.use((req, res, next) => {
    if (!req.url.startsWith('/mcp-admin/') && req.url !== '/mcp-admin') return next();
    const f = mcpFlags();
    if (f.phase3 === false || f.adminTools === false) { return res.status(503).send('Phase 3 admin MCP disabled'); }
    const rest = req.url.slice('/mcp-admin'.length) || '/';
    req.url = '/mcp/admin' + (rest === '/' ? '' : rest);
    if (req.originalUrl) req.originalUrl = req.url;
    next();
  });

  // PAT middleware — resolves Bearer pat_... to synthetic req.user for the
  // /mcp-pat/* prefix, then rewrites the URL to the real MCP mount (Phase 2 #1105).
  //
  // Mounted at ROOT (not app.use('/mcp-pat', …)) on purpose: CAP mounts the MCP
  // adapter with app.use('/mcp/api', …) on the root app, so to re-dispatch there
  // we must rewrite req.url on the SAME (root) routing context. A middleware
  // mounted under '/mcp-pat' runs in a prefix-stripped sub-context and cannot
  // re-match the sibling '/mcp' mount — that produced a 404 (verified).
  //
  // We gate on the /mcp-pat/ prefix manually so a stray Bearer pat_ header on
  // /api or /chat is never misinterpreted. Services expose MCP at /mcp/<svc>
  // (e.g. DeveloperService at /mcp/api — see cap-mcp-shadowed-by-odata-shared-path);
  // /mcp-pat/api → /mcp/api, /mcp-pat/search → /mcp/search, etc.
  app.use((req, res, next) => {
    if (!req.url.startsWith('/mcp-pat/') && req.url !== '/mcp-pat') return next();
    // /mcp-pat/* is the PAT tier — a Bearer pat_ token is mandatory here. The
    // approuter fronts this route with authenticationType:'none' (the PAT, not
    // XSUAA, is the credential), so we must reject a missing/non-PAT credential
    // explicitly rather than letting it fall through to CAP's auth as anonymous.
    const authz = req.headers?.authorization;
    if (!authz || !authz.startsWith('Bearer pat_')) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authorization error (401): PAT required on /mcp-pat/*.' },
        id: req.body?.id ?? null
      });
    }
    return patMiddleware(req, res, (err) => {
      if (err) return next(err);
      const rest = req.url.slice('/mcp-pat'.length) || '/'; // '/api', '/search', …
      req.url = '/mcp' + rest;
      if (req.originalUrl) req.originalUrl = req.url;
      next();
    });
  });

  // Phase 3 (#1106): mount the compose router for R/P-bearing services at their
  // MCP path so it serves tools + resources + prompts instead of @cap-js/mcp's
  // plain (tools-only) adapter.
  //
  // WHY HERE (bootstrap, not 'served'): Express matches first-registered. CAP
  // mounts each service's @cap-js/mcp protocol adapter (/mcp/graph etc.) during
  // its own serve step — AFTER 'bootstrap' fires. Registering our router in
  // 'bootstrap' (same hook as the /mcp-auth and /mcp-pat rewrites above) wins
  // the route ahead of the plugin's autowired mount. Mounting in 'served' would
  // register after CAP's adapter and silently lose the race → tools-only
  // (Phase-2) behavior, which fails SAFE but fails this task.
  //
  // Lazy service resolution: cds.services.<Name> is not connected yet at
  // bootstrap. We defer the lookup + one-time compose-router build to the first
  // request (which can only arrive after 'served'). If the service never comes
  // up (e.g. KG disabled), we fall through to next() and CAP's plain adapter (or
  // a 404) handles it.
  //
  // Path derivation: hardcoded per-service MCP paths — KnowledgeGraphService's
  // @protocol pins {kind:'mcp', path:'/mcp/graph'}. WS2 adds /mcp/admin.
  // makeComposeRouter returns a bare express.Router — mount it DIRECTLY (no
  // .router unwrap; that's only for CAP's HttpAdapter instances).
  if (mcpFlags().phase3) {
    // [ [ mcpPath, serviceName ], … ] — Phase 3 R/P services. AdminService (WS2).
    const RP_MOUNTS = [['/mcp/graph', 'KnowledgeGraphService'], ['/mcp/admin', 'AdminService']];
    for (const [mcpPath, name] of RP_MOUNTS) {
      let composed = null; // built once, on first request
      app.use(mcpPath, (req, res, next) => {
        if (composed === null) {
          const srv = cds.services[name];
          if (!srv) return next(); // service not up → let CAP/plain adapter handle it
          composed = makeComposeRouter(srv);
          cds.log('mcp-compose').info(`compose router mounted for ${name} at ${mcpPath}`);
        }
        return composed(req, res, next);
      });
    }
  } else {
    cds.log('mcp-compose').warn('MCP_PHASE3_ENABLED=false — compose router NOT mounted; @cap-js/mcp serves tools only');
  }

  // Same: reserve GET /admin/embeddings/stats BEFORE CAP mounts AdminService
  // at /admin. Auth + business logic bound lazily in 'served'.
  app.get('/admin/embeddings/stats', (req, res, next) => embeddingsStatsHandler(req, res, next));

  // #805 — Reserve /admin/metrics/live BEFORE CAP mounts AdminService.
  // The real handler is late-bound in cds.on('served') below.
  app.get('/admin/metrics/live', (req, res) => metricsLiveHandler(req, res));

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

  // ── Petoberfest: multipart upload (authenticated) + photo serve (public/admin) ──
  // Reserved BEFORE CAP mounts PetoberfestService at /petoberfest-api and
  // AdminService at /admin — same rationale as the advocate photo route above.
  const _petCtxMw  = cds.middlewares?.context?.() || ((req, res, next) => next());
  const _petAuthMw = cds.middlewares?.auth?.()    || ((req, res, next) => next());
  const _petUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  app.post('/petoberfest-api/:slug/upload',
    _petCtxMw, _petAuthMw, captureUserMiddleware(cds),
    (req, res, next) => {
      _petUpload.single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.code || 'UPLOAD_ERROR', message: err.message });
        next();
      });
    },
    async (req, res) => {
      try {
        const user = resolveUser(req, cds);
        if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Sign in to upload' });
        if (!req.file) return res.status(400).json({ error: 'MISSING_FIELD', message: "missing 'photo' field" });
        const db = await cds.connect.to('db');
        const out = await uploadPetSubmission(db, {
          slug: req.params.slug, user, buffer: req.file.buffer,
          mimeType: req.file.mimetype, petName: req.body?.petName,
        });
        if (out.duplicate) return res.status(409).json({ error: 'DUPLICATE', message: 'You already uploaded this photo' });
        return res.json({ id: out.id, awarded: out.awarded, moderation: out.moderation });
      } catch (e) {
        const code = e.code === 'NOT_FOUND' ? 'NOT_FOUND'
                   : /unsupported MIME/i.test(e.message) ? 'BAD_MIME'
                   : /too large/i.test(e.message) ? 'TOO_LARGE'
                   : /animated/i.test(e.message) ? 'ANIMATED'
                   : /invalid image/i.test(e.message) ? 'BAD_IMAGE'
                   : 'UPLOAD_FAILED';
        const status = code === 'NOT_FOUND' ? 404 : e.code === 'UNAUTHENTICATED' ? 401 : 400;
        return res.status(status).json({ error: code, message: e.message });
      }
    });

  // Public photo serve — APPROVED only (404 otherwise so unapproved can't leak).
  app.get('/petoberfest-api/photo/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db');
      const size = req.query.size === 'thumb' ? 'thumb' : 'display';
      const p = await fetchPetPhoto(db, { id: req.params.id, size, requireApproved: true });
      if (!p) return res.status(404).end();
      return sendPetPhoto(res, p);
    } catch (e) { cds.log('petoberfest').error(e); return res.status(500).end(); }
  });

  // Admin photo serve — any moderation state (Author/Admin gated) for queue thumbnails.
  app.get('/admin/petoberfest/photo/:id',
    _petCtxMw, _petAuthMw,
    async (req, res) => {
      const user = resolveUser(req, cds);
      if (!user) return res.status(401).end();
      if (!(user.is?.('Admin') || user.is?.('Tutorial.Author'))) return res.status(403).end();
      try {
        const db = await cds.connect.to('db');
        const size = req.query.size === 'thumb' ? 'thumb' : 'display';
        const p = await fetchPetPhoto(db, { id: req.params.id, size, requireApproved: false });
        if (!p) return res.status(404).end();
        return sendPetPhoto(res, p, { isPrivate: true });
      } catch (e) { cds.log('petoberfest').error(e); return res.status(500).end(); }
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

  // #1659: the post-deploy self-heal rebuild was RETIRED. It dispatched a
  // catalog-only content rebuild on first boot after each deploy to refresh the
  // approuter's ephemeral static — but that rebuild runs from `main` and pushes
  // via POST /admin/rebuild, CLOBBERING the freshly-deployed droplet static
  // (forcing a manual `cf restart` after every DEV deploy). It is now redundant:
  // content pages are served live from HANA/CAP (incl. the homepage flip in this
  // change), assets are deploy-shipped + retained (#1658), and the empty-concepts
  // incident it guarded is moot (concepts serve from HANA; build:deploy fails on
  // unset/localhost CAP_BASE_URL). Admin-write content refreshes still dispatch
  // via the rebuild-trigger path (unchanged) — only the deploy-triggered one is gone.

  // Bust the /build/navigator in-memory cache when admins write to entities that
  // shape the navigator response. Without this, the 5-minute TTL serves stale
  // mission/group data after CRUD via AdminService.
  if (!globalThis.__navigatorCacheInvalidatorRegistered) {
    const admin = await cds.connect.to('AdminService');
    // #429: classifier-driven rebuild. Each entity routes to a different
    // mode via classifyRebuildMode(); Steps + Tags added so their CRUD
    // also triggers a (slug-targeted or full+force-cap-refetch) rebuild.
    // Homepage entities (HomepageShelves/VerbDefinitions/ShelfDefinitions/
    // HomepageConfig) added so admin edits to Shelf/Verb Explainers + Shelf
    // Entries auto-dispatch a catalog-only rebuild instead of sitting baked
    // until some unrelated catalog write happens to fire one. All four are
    // classified catalog-only by classifyRebuildMode and are draft-enabled
    // (hook fires once per SAVE, not per draft patch). Their READ-time
    // auto-init INSERTs use the fully-qualified DB entity string → cds.db →
    // bypass this service hook, so no spurious rebuild on boot.
    const navInvalidatingEntities = ['Missions', 'Groups', 'CompletionPaths', 'CompletionPathItems', 'GroupPathItems', 'Tutorials', 'Steps', 'FeaturedTasks', 'Tags', 'Advocates', 'AdvocateTopics', 'AdvocateLinks', 'HomepageShelves', 'VerbDefinitions', 'ShelfDefinitions', 'HomepageConfig'];
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
      // #1592: the two invalidations above only clear THIS instance. Bump the
      // shared generation token so peer srv instances drop their local catalog
      // caches on their next serve (bounded by CATALOG_CACHE_CHECK_TTL_MS).
      // Fail-open — a caching outage just means peers self-heal on next write.
      try {
        await bumpCacheGeneration();
      } catch (err) {
        console.error('[catalog-cache] generation bump failed', err);
      }

      // [#174 PR 3, #429, #541] Schedule a rebuild. classifyRebuildMode routes the
      // entity to the cheapest valid mode (catalog-only/slug-targeted/full).
      const entityName = req.target?.name?.split('.').pop();
      if (!entityName) return;
      const { mode, forceCapRefetch, needsSlug, needsSlugsByTag } = classifyRebuildMode(entityName, 'crud');

      if (mode === 'none') {
        // #548 defensive: entity is runtime-served (e.g. Alerts) and must never
        // trigger a Hugo rebuild. Unreachable in v1 since such entities are not
        // in navInvalidatingEntities — kept as a forward-compat contract so a
        // later addition can't accidentally dispatch a rebuild.
        return;
      }

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

    // Alerts admin writes: invalidate the in-memory alerts cache so the
    // next /api/alerts* fetch reflects the change within ~5s.
    admin.after(['CREATE', 'UPDATE', 'DELETE'], 'Alerts', () => {
      try {
        invalidateAlertsCache();
      } catch (err) {
        console.error('[alerts] cache invalidation failed', err);
      }
    });

    // #685: KnowledgeGraphService.Concepts writes trigger a catalog-only
    // rebuild so the /concepts/<slug>/ Hugo page generation + /build/concepts
    // payload pick up admin Publish/Unpublish (the bound actions) and inline
    // name/description edits (the UPDATE path). Lives on KG service, not
    // AdminService, so it needs its own hook. Pattern mirrors the admin.after
    // dispatch above — same x-migration-mode short-circuit, same classifier.
    const kg = await cds.connect.to('KnowledgeGraphService');
    kg.after(['CREATE', 'UPDATE', 'DELETE'], 'Concepts', async (_data, req) => {
      if (req.headers?.['x-migration-mode'] === 'true') return;
      // #1182: bust the PublishedConceptsWithAliases @cache on any concept
      // write (name/description edits change cached rows; publishedAt flips
      // change membership). Fire-and-forget, fail-open — never blocks the write.
      bustPublishedConceptsCache().catch(() => {});
      const entityName = req.target?.name?.split('.').pop();
      if (!entityName) return;
      const { mode, forceCapRefetch } = classifyRebuildMode(entityName, 'crud');
      if (mode === 'none') return;
      scheduleRebuild('kg-write', { mode, forceCapRefetch }).catch(err => {
        console.error('[rebuild-trigger] scheduling failed', err);
      });
    });
    const KG_CATALOG_ACTIONS = ['publishConcept', 'unpublishConcept'];
    for (const actionName of KG_CATALOG_ACTIONS) {
      kg.after(actionName, async (_data, req) => {
        if (req.headers?.['x-migration-mode'] === 'true') return;
        // #1182: publishConcept/unpublishConcept flip publishedAt — the
        // PublishedConceptsWithAliases `where` filter — so bust the pilot cache.
        bustPublishedConceptsCache().catch(() => {});
        const { mode, forceCapRefetch } = classifyRebuildMode(actionName, 'action');
        scheduleRebuild(`kg-action:${actionName}`, { mode, forceCapRefetch }).catch(err => {
          console.error('[rebuild-trigger] scheduling failed', err);
        });
      });
    }

    // #1182: publishAllConcepts (#1080 bulk publish) flips publishedAt on many
    // concepts via a db-layer UPDATE — bypassing both the Concepts CRUD hook and
    // the KG_CATALOG_ACTIONS loop above. Bust the PublishedConceptsWithAliases
    // @cache explicitly so the ⌘K palette reflects a bulk publish immediately.
    // Standalone (not added to KG_CATALOG_ACTIONS) so it does NOT gain that
    // loop's scheduleRebuild side effect — this action today only audits.
    kg.after('publishAllConcepts', async (_data, req) => {
      if (req.headers?.['x-migration-mode'] === 'true') return;
      bustPublishedConceptsCache().catch(() => {});
    });

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
    // #1268: coarse deploy environment (DEV/PROD/QA/LOCAL) for the admin
    // header. Derived from the CF space name — safe to expose to anonymous
    // callers (no PII; the space name is already visible in every app URL).
    const environment = resolveDeployEnvironment();
    const user = cds.context?.user;
    if (!user?.id || user.id === 'anonymous') {
      return res.status(401).json({ authenticated: false, environment });
    }
    // Issue #339 / SAGE-ownership: get-or-create the migrated Users row and
    // backfill firstName/lastName/email from JWT claims. The migrator copies
    // SAP_ID and pre-computed totals only — IMS Java JIT-fetched names from SAP
    // IDP and never persisted them, and never created rows for users present
    // only in legacy author tables. SAP ID Service has no SCIM bulk API, so
    // this per-request path (now provisioning, not just UPDATE-backfilling) is
    // the only way the row + profile get populated post-cutover. provisionDbUser
    // mints the row from THIS caller's claims when absent, so a browser login
    // fixes ownership resolution up-front (parity with the AuthorService read
    // handlers). Fire-and-forget; never block the response on this self-heal.
    //
    // Best-effort by design: this is NOT awaited, so the INSERT may still be in
    // flight when the response returns, and it runs against the request's
    // closing tx. Do not rely on the browser path having committed a row by the
    // time /auth/user responds — the RELIABLE provision is the awaited
    // provisionDbUser inside the AuthorService before('READ') handlers. This
    // call is a convenience so a browser login also warms the row; the
    // /auth/user response itself is unaffected (id/email/name all come straight
    // from the token, not this write).
    provisionDbUser(user).catch(err =>
      console.warn('[provision-user]', err.message));
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
      userId: user.id,  // #777: explicit alias of id, kept stable as the Users.uuid value. The existing MyTutorialsView (db/views.cds) has empirically worked with `req.user.id === Users.uuid` for the email-only filter, so the new UNION view's `userId` column (also Users.uuid) accepts the same value.
      email: user.attr?.email || '',
      givenName: user.attr?.given_name || user.attr?.givenName || '',
      familyName: user.attr?.family_name || user.attr?.familyName || '',
      isAdmin: user.is?.('Admin') === true,
      isAuthor: user.is?.('Tutorial.Author') === true,
      environment,
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
  // CAP 10 change: `_adapters._default` is now the adapter INSTANCE (HttpAdapter) rather
  // than the router function — get the router via `.router`. Fall back to the CDS-9 shape
  // in case anything downstream still returns the raw router (defensive).
  // We must also wrap it with context + auth middlewares (the CDS 'before' middlewares that
  // cds.serve normally prepends) since our bootstrap stub bypassed them.
  const analyticsDefaultAdapter = cds.services.AnalyticsService?._adapters?._default;
  const analyticsAdapter = typeof analyticsDefaultAdapter === 'function'
    ? analyticsDefaultAdapter                      // CDS 9 shape
    : analyticsDefaultAdapter?.router;             // CDS 10 shape
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

  // #805 — Wire the real /admin/metrics/live handler. Same context+auth
  // sandwich as embeddingsStatsHandler (Admin scope required — the endpoint
  // exposes in-memory operational data that isn't for public consumption).
  const metricsLiveBusiness = async (req, res) => {
    const user = cds.context?.user;
    if (!user?.id || user.id === 'anonymous') {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    if (!(user?.is && user.is('Admin'))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const metrics = await import('./lib/metrics.js');
      res.json({
        snapshot: metrics.snapshot(),
        instanceId: process.env.CF_INSTANCE_GUID || `local-${process.pid}`,
        uptimeSec: Math.round(process.uptime()),
        dbWrapEnabled: process.env.METRICS_DB_WRAP === 'true',
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      cds.log('metrics-live').error(err.message);
      res.status(500).json({ error: 'snapshot_failed' });
    }
  };
  metricsLiveHandler = (req, res, next) => {
    contextMw(req, res, (err) => {
      if (err) return next(err);
      authMw(req, res, (err) => {
        if (err) return next(err);
        Promise.resolve(metricsLiveBusiness(req, res)).catch(next);
      });
    });
  };

  // Wire the real streaming handler for GET /admin/exports/exportLegacyData now
  // that cds.middlewares (context + auth) are available.
  wireExportsBridge();

  // #958: registerJobs() call removed — CronService.init() owns the
  // scheduler lifecycle now.
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
      const { system, tools, effectivePageContext } = await buildChatInvocation({
        pageContext, user, settings, isAdmin
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

  // Wire A2A router through the same context+auth chain. makeA2aRouter()
  // returns a router with router.post('/') which matches POST /a2a because
  // Express strips the base path when dispatching to the router. (#1220)
  const a2aRouter = makeA2aRouter();
  a2aHandler = (req, res, next) => {
    contextMw(req, res, (err) => {
      if (err) return next(err);
      authMw(req, res, (err) => {
        if (err) return next(err);
        a2aRouter(req, res, next);
      });
    });
  };
  cds.log('a2a').info('POST /a2a registered');
});

// #805 PR 2 (#909) — Passive wrapper on cds.db.run / cds.db.tx to observe HANA
// pool acquire-latency + tx wall-clock. Deliberately its own cds.on('served')
// handler so the wrapping code is isolated behind the METRICS_DB_WRAP flag.
// The wrapping logic itself lives in ./lib/metrics-db-wrap.js so it can be
// unit-tested without booting CAP.
//
// Gate: both METRICS_ENABLED !== 'false' AND METRICS_DB_WRAP === 'true'.
// This mirrors metrics.js's own kill-switch semantics (env var 'false' wins
// over 'true' or unset). When the wrapper isn't installed, cds.db.run and
// cds.db.tx retain their original bindings at zero cost — no promise-chain
// overhead per query.
//
// Guard: globalThis.__metricsDbWrapInstalled — cds.on('served') can re-fire
// under cds.test() when multiple test files import the runtime. Matches the
// __feedbackBeforeHookRegistered / navigatorCacheInvalidatorRegistered
// sentinel convention elsewhere in this file.
//
// Metrics emitted:
//   - db.acquire.ms       — histogram, every cds.db.run(...) observation
//   - db.tx.ms            — histogram, every db.tx(fn) end-to-end wall-clock
//   - db.tx.run.ms        — histogram, every tx.run(...) inside a tx callback
//   - db.pool.timeout     — counter, error.message matches /timeout|acquire/i
//
// Caveats (see spec § HANA pool acquire-latency):
//   - Timing conflates acquire time and query time — no driver hook separates
//     them. When the pool is starved, acquire dominates; when healthy, query
//     time dominates and blends into histogram noise. A p95 rise with
//     unchanged query mix is the exhaustion signal.
//   - The 3 cds.tx(...) sites (repo-catalog / category-classifier /
//     validate-answer-spec-publish) go un-instrumented in v1. Not pool-starving.
//   - Nested-tx short-circuit in @sap/cds/lib/srv/srv-tx.js means the outer
//     db.tx.ms observation can double-count against the wall-clock of an
//     already-active tx. Not a correctness issue — flagged so admin-tile
//     percentiles read as "acquire + tx pressure signal" not "unique samples."
cds.on('served', () => {
  const installed = installDbWrap(cds);
  if (installed) {
    cds.log('metrics-db-wrap').info('METRICS_DB_WRAP enabled: cds.db.run / cds.db.tx wrapped');
  }
});

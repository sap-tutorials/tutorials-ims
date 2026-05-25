# SAP Tutorial Platform

A tutorial hosting platform for [developers.sap.com](https://developers.sap.com) that replaces both Adobe Experience Manager (AEM) and the legacy Java IMS backend. Fetches tutorial markdown from the [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization at build time, renders static pages with SAP Fundamental Styles (Horizon theme) via Hugo, and deploys on SAP BTP Cloud Foundry behind an AppRouter with XSUAA authentication. The CAP Node.js backend provides progress tracking, event management, and all services previously handled by the Spring Boot IMS application.

> **Production system** replacing AEM tutorial hosting, Git-based authoring interface, and Java IMS backend on developers.sap.com (April 2026).

**Stack:** Hugo &middot; CAP Node.js (CDS 9.x) &middot; SAP HANA Cloud &middot; SAP Fundamental Styles &middot; Vue 3 (apps) &middot; TypeScript &middot; SAP BTP Cloud Foundry

## Folder Map

```
tutorials-poc/
├── approuter/                  # BTP AppRouter — serves static files + proxies to CAP via XSUAA auth
│   ├── server.js               #   Custom AppRouter wrapper (VCAP merge, serve-static, proxy fixes)
│   ├── static/                 #   Pre-built assets deployed to CF
│   │   ├── admin-ui/           #     Admin shell (sap.tnt.ToolPage) + 11 Fiori Elements components
│   │   ├── analytics-ui/       #     Analytics Explorer Vue 3 SPA bundle
│   │   ├── scanner-ui/         #     UI5 barcode scanner bundle
│   │   ├── scanner-vue/        #     Vue 3 barcode scanner bundle
│   │   ├── display-app/        #     Display App SPA bundle (event monitor dashboard)
│   │   ├── qa/                 #     QA-channel Hugo build (gated by Tutorial.Author scope)
│   │   ├── css/img/js/         #     Global stylesheets, images, shared JS injected into Hugo pages
│   │   └── (no tutorials/)     #     Tutorials served dynamically from HANA, not static files
│   └── xs-app.json             #   Route definitions (/admin-ui, /analytics-ui, /scanner-*, /tutorials, /tutorials-qa, /api, /admin, /display, /chat, /search, /build, /content)
├── app/                        # Standalone UI applications (UI5 + Vue, deployed to approuter/static/)
│   ├── admin-shell/            #   sap.tnt.ToolPage shell with side navigation + theme switching
│   ├── admin/                  #   11 Fiori Elements feature components (events, missions, groups,
│   │                           #   accomplishments, prizes, tutorials, tags, operations, accounts,
│   │                           #   changelog, joule, feedback, analytics) loaded by the shell
│   ├── analytics-explorer/     #   Vue 3 + Vite + Monaco SQL editor over AnalyticsService
│   ├── scanner/                #   UI5 barcode scanner (sap.ndc.BarcodeScanner)
│   ├── display-app/            #   Standalone event monitor dashboard (Vue 3 + Vite, Socket.IO)
│   ├── admin-annotations.cds   #   @UI/@Common annotations for all admin screens
│   └── change-tracking.cds     #   @cap-js/change-tracking config for admin entities
├── hugo-apps/                  # Vue 3 page-level islands compiled into Hugo's static JS (output: hugo/static/js/)
│   └── src/                    #   9 entry points: navigator, app-space, event-display, nav-dropdown,
│       │                       #   scanner-vue, tutorial-feedback, tutorial-rating, cmd-palette, me
│       └── shared/             #   Shared utilities, API client, types
├── hugo/                       # Hugo static site generator — tutorial pages + layouts
│   ├── assets/css|js/          #   PostCSS pipeline (Fundamental Styles Horizon) + page-level JS
│   │                           #   includes ui5-bootstrap.ts (UI5 Web Components shellbar/dialog/etc.)
│   ├── config/                 #   Hugo configuration (hugo.toml, environment overrides)
│   ├── content/
│   │   ├── tutorials/          #     Generated tutorial markdown (gitignored, from fetch-tutorials)
│   │   ├── missions/           #     Generated mission overview pages
│   │   └── groups/             #     Generated completion-path pages
│   ├── data/                   #   Site-level data files (glossary, etc.)
│   ├── i18n/                   #   en_us only (developers.sap.com is English-only)
│   └── layouts/                #   _default, tutorials, missions, groups, partials, shortcodes
├── hugo.qa.toml                # Sibling Hugo config for QA channel (strips Joule FAB, rating, etc.)
├── preview-site/               # Hugo preview-site renderer (used by srv-qa preview path)
├── db/                         # Production CAP data model — CDS schema + HANA native artifacts
│   ├── schema.cds              #   Entity definitions (Users, Tutorials, Missions, Events, etc.)
│   ├── views.cds               #   CDS views (NavigatorCatalog, SearchableItems, CompletionAnalytics, …)
│   ├── persistence.cds         #   ContentFiles + ContentManifest (gzip-compressed tutorial BLOBs)
│   ├── audit-logging.cds       #   @PersonalData annotations (Users, UserMetaData, TaskRecords)
│   ├── change-tracking.cds     #   @cap-js/change-tracking annotations
│   ├── schema-ext.cds          #   Service-layer schema extensions
│   └── src/                    #   Native HANA artifacts (.hdbsequence for legacy integer IDs)
├── db-qa/                      # QA-channel HDI container schema (peer of db/, deploys to tutorials-hana-qa)
├── srv/                        # CAP Node.js backend — production services
│   ├── server.js               #   Bootstrap: registers Express routes + jobs on cds.on('served')
│   ├── *-service.cds + .js     #   9 services: developer, admin, analytics, exports, display,
│   │                           #     consolidation, scanner, search, chat, event-stream
│   ├── ord-annotations.cds     #   Open Resource Discovery registration for all services
│   ├── handlers/               #   Express route handlers (recommendations.js)
│   ├── exports/                #   ExportsService backends (CSV/zip, XLSX, task records, etc.)
│   ├── lib/                    #   Shared business logic (~40 modules):
│   │                           #     content-store (HANA BLOB serve), embedding-* (RAG), chat-* (Joule),
│   │                           #     accomplishment-evaluator, account-merge, build-catalog,
│   │                           #     navigator-catalog, recommend, co-completion, status-calculator,
│   │                           #     mail-client, ngds-client, adobe-analytics, qrcode-handler,
│   │                           #     analytics-sql-validator (SELECT-only allowlist for runSelectQuery),
│   │                           #     feedback-salt, ip-rate-limit, ttl-cache, pipeline-log, …
│   ├── jobs/                   #   Scheduled tasks: scheduler, account-merge, cleanup,
│   │                           #     ngds-retry, embedding-reconciliation, job-lock (distributed)
│   └── templates/notification/ #   Email HTML templates (Handlebars)
├── srv-qa/                     # QA-channel CAP app (peer of srv/, deploys to tutorials-srv-qa)
│   ├── server.js               #   Mounts xsuaa-scope-middleware (Tutorial.Author gate) + preview renderer
│   └── search-service.cds      #   QA-only search projection
├── scripts/                    # Build-time scripts — fetch, parse, publish, migrate, seed
│   ├── fetch-tutorials.ts      #   Main entry: fetches markdown from GitHub, generates Hugo pages
│   ├── publish-content.ts      #   Delta-publish Hugo HTML → HANA BLOBs via /content/publish
│   ├── parsers/                #   Markdown pipeline: v1 (legacy ACCORDION) + v2 (H3) + images,
│   │                           #     options, cap, github, rules, sanitize-html, hugo-delimiters, types
│   ├── grammars/               #   TextMate grammars for syntax highlighting
│   ├── highlight-cds.ts        #   CDS syntax highlighter
│   ├── install-qa-workflows.ts #   Distribute notify-qa.yml workflow to all -Contribution repos
│   ├── verify-qa-build.ts      #   Post-build verification of QA Hugo output
│   ├── check-qa-schema-drift.ts#   Compare prod vs QA HDI schemas (CI step)
│   ├── setup-dev-data.cjs      #   Slug population + autotest cleanup against DEV HANA
│   ├── seed-*.cjs / seed-*.js  #   Various data seeding scripts
│   ├── migrate-reference-data.js   # Export/import tutorials, missions, events from Java IMS
│   ├── migrate-user-progress.js    # Export/import user progress (paged, resumable)
│   ├── migrate-from-hana.js        # Direct HANA-to-HANA migration
│   └── compare-systems.js      #   Endpoint-by-endpoint diff between Java IMS and CAP
├── test/                       # Vitest workspaces (unit, hybrid, hybrid-qa, smoke)
│   ├── unit + integration/     #   In-memory SQLite, fast, no external deps (npm test)
│   ├── lib/ + jobs/ + parsers/ #   Module-level unit tests
│   ├── hybrid/                 #   Real HANA Cloud via cds bind --exec (npm run test:hybrid)
│   ├── hybrid-qa/              #   Hybrid tests against QA HDI
│   ├── smoke/                  #   HTTP smoke tests against deployed URLs (npm run test:smoke)
│   ├── srv-qa/                 #   QA-srv-specific tests (preview, scope middleware)
│   └── a11y/                   #   Accessibility tests
├── docs/                       # Architecture references and developer documentation
│   ├── pilot-status.md         #   Pilot completion + locked production scope
│   ├── testing-endpoints.md    #   Canonical UI + API endpoint reference (auth/scope mapping)
│   ├── production-ready.md     #   Go-live checklist
│   ├── theme-variants.md       #   Building event-specific theme variants (Joule, Sapphire, TechEd)
│   ├── qa-channel-bootstrap.md #   One-time QA author-preview channel setup
│   ├── author-instructions.md  #   Tutorial-author workflow
│   ├── content-pipeline.md     #   Fetch → parse → Hugo → HANA pipeline deep-dive
│   ├── authentication-architecture.md, mta-deployment.md, hugo-migration.md, ai-consumption.md, …
│   ├── improvements.md, TODO.md#   Feature backlog and gap tracking (largely historic)
│   └── superpowers/specs/+plans/ # Feature specs and step-by-step implementation plans
├── .deploy/                    # MTA build + deploy artifacts
│   ├── mta.yaml                #   MTA descriptor (modules: approuter, srv, srv-qa, db, db-qa, destinations)
│   ├── xs-security.json        #   XSUAA scopes + role collections (Admin, MobileApp, Tutorial.Author)
│   ├── deploy-admin.sh         #   Standalone admin UI deploy helper (bypasses MTA build)
│   └── DEPLOY.md               #   Deploy procedure documentation
├── deploy/                     # MTA extension descriptors (environment overrides)
│   ├── dev.mtaext              #   Development overrides (instance counts, memory)
│   ├── qa.mtaext               #   QA/staging overrides
│   └── prod.mtaext             #   Production overrides
├── .github/workflows/          # CI/CD pipelines (GitHub Actions)
│   ├── deploy.yml              #   Build MTA + deploy to BTP CF + post-deploy smoke tests
│   ├── rebuild-content.yml     #   Re-fetch tutorials + rebuild Hugo + publish HTML to HANA
│   ├── rebuild-content-qa.yml  #   QA-channel content rebuild (triggered by repository_dispatch)
│   ├── schema-drift-check.yml  #   Compare prod vs QA HDI schemas
│   └── notify-qa.yml.template  #   Template installed into every -Contribution repo
├── openspec/                   # OpenSpec change proposals + config
├── .tutorial-cache/            # Cached prod-channel GitHub markdown + metadata (gitignored)
├── .tutorial-cache-qa/         # Cached QA-channel markdown (gitignored, separate channel marker)
├── .migration-data/            # Migration export files from Java IMS (gitignored)
├── gen/                        # CDS build output (gitignored)
├── site/                       # Legacy VitePress output (deprecated, gitignored)
├── CLAUDE.md                   # Project context for Claude Code agents
├── AGENTS.md                   # Agent-specific instructions (Codex/Gemini parity)
├── package.json                # Root dependencies + npm scripts (full list: jq '.scripts' package.json)
└── vitest.config.ts            # Vitest workspace config (inline projects array)
```

## Quick Start

**Prerequisites:** Node.js >= 20, npm

```bash
npm install
npm run fetch-tutorials   # Fetch tutorial markdown from GitHub + CAP catalog
cds watch                 # Start CAP server (http://localhost:4004)
```

For the full static site build:

```bash
npm run dev               # Hugo dev server (requires fetch-tutorials first)
npm run build             # Production build → hugo/public/
```

## Scripts

Full list: `jq '.scripts' package.json`. The most operationally important ones:

### Setup

| Script | Description |
|--------|-------------|
| `npm install` | Install all dependencies |
| `npm run bind:setup` | First-time hybrid env binding (CAP + approuter against real HANA) |
| `npm run setup-dev-data` | Populate slugs + clean autotest data on DEV HANA (requires `cds bind`) |

### Dev

| Script | Description |
|--------|-------------|
| `cds watch` | Start CAP backend with in-memory SQLite (http://localhost:4004) |
| `npm run watch:hybrid` | CAP backend bound to real HANA via `--profile hybrid` |
| `npm run dev:hybrid` | CAP (hybrid) + approuter together — full local stack against real HANA |
| `npm run start:approuter` | Standalone approuter (port 5000) |
| `npm run dev` | Hugo dev server with live reload (requires `fetch-tutorials` first) |

### Build

| Script | Description |
|--------|-------------|
| `npm run fetch-tutorials` | Fetch markdown from GitHub, parse, generate Hugo content pages |
| `npm run discover-repos` | List discoverable tutorial repos without fetching |
| `npm run build:cds` | Production CDS build |
| `npm run build:css` | PostCSS pipeline for SAP Fundamental Styles |
| `npm run build:hugo` | Hugo static site build (minified) |
| `npm run build:apps` | Build `hugo-apps/` Vue islands into `hugo/static/js/` |
| `npm run build:admin` | Build admin-shell into `app/admin-shell/dist/` |
| `npm run build:analytics-explorer` | Build Analytics Explorer Vue 3 SPA |
| `npm run build:display` | Build Display App (event monitor dashboard) |
| `npm run build:highlight` | Generate CDS syntax highlighter assets |
| `npm run generate-dark-theme` | Regenerate dark-theme CSS variants |
| `npm run validate-tutorials` | Static validation of fetched tutorial markdown |
| `npm run build:all` | Full production pipeline (fetch + CSS + apps + Hugo + display) |

### Test

| Script | Description |
|--------|-------------|
| `npm test` | Unit tests (in-memory SQLite, fast) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:hybrid` | Hybrid tests against real HANA (requires `cf login` to DEV) |
| `npm run test:hybrid:watch` | Hybrid tests in watch mode |
| `npm run test:smoke` | HTTP smoke tests (set `SMOKE_BASE_URL` / `SMOKE_SRV_URL`) |
| `npm run test:a11y` | Accessibility tests |
| `npm run test:a11y:lighthouse` | Lighthouse a11y audit (lhci autorun) |
| `npm run test:a11y:summary` | Print a11y test summary |
| `npm run test:all` | All Vitest workspaces (unit + hybrid + smoke + a11y) |

### Content publishing

| Script | Description |
|--------|-------------|
| `npm run publish-content` | Delta-publish Hugo HTML → HANA BLOBs (use `-- --force` to bypass delta — required for prod) |

### QA channel (author preview)

| Script | Description |
|--------|-------------|
| `npm run fetch-tutorials:qa` | Fetch from `*-Contribution` repos only (cache: `.tutorial-cache-qa/`) |
| `npm run build:qa` | Hugo build with QA flag, post-build verify |
| `npm run publish-content:qa` | Force-publish to QA srv |
| `npm run qa:full` | End-to-end QA pipeline |

### Migration (Java IMS → CAP)

| Script | Description |
|--------|-------------|
| `npm run migrate:reference` | Export/import reference data from Java IMS |
| `npm run migrate:users` | Export/import user progress (paged, resumable) |
| `npm run migrate:hana` | Direct HANA-to-HANA migration |
| `npm run compare` | Compare Java IMS and CAP responses side-by-side |

## Environment Variables

Deploy-time variables for the MTA modules (CF env, role collections, secrets) are documented in [.deploy/DEPLOY.md](.deploy/DEPLOY.md). The tables below cover variables commonly set during local dev, CI, and migration.

### Build pipeline (fetch + publish)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | No | — | Avoids GitHub API rate limits when fetching tutorial markdown + commit metadata |
| `TUTORIALS_GITHUB_TOKEN` | No | — | CI-side alias for `GITHUB_TOKEN` (used by `deploy.yml`, `rebuild-content*.yml`) |
| `CAP_BASE_URL` | No | `http://localhost:4004` | CAP srv URL (build pipeline, `publish-content`, migration scripts) |
| `CAP_QA_BASE_URL` | No | — | QA-channel CAP srv URL for `publish-content:qa` |
| `CONTENT_API_KEY` | Yes (publish) | — | Bearer token for `POST /content/publish` and `/content/rollback` |
| `CONTENT_API_KEY_QA` | Yes (QA publish) | — | Bearer token for QA-channel `/content/publish` |
| `TUTORIAL_SLUG` | No | — | If set, `fetch-tutorials` busts the cache for that single slug; `rebuild-content.yml` skips the `RepoCatalog` upload |
| `INCLUDE_CONTRIBUTION_REPOS` | No | `false` | Include `*-Contribution` repos in fetch (prod channel only allows on opt-in) |
| `ONLY_CONTRIBUTION_REPOS` | No | `false` | QA channel: fetch from `*-Contribution` repos exclusively |

### CAP runtime (srv/)

| Variable | Required | Default | Description |
|---|---|---|---|
| `CONTENT_API_KEY` | Yes | — | Required to accept content publish writes; without it `/content/publish` returns 401 |
| `SUBMISSION_SALT_SECRET` | Yes (feedback) | — | IP-hash salt for `/feedback/submit`; bridge returns 503 if missing |
| `EXPOSE_CAP_UI` | No | `false` | Enables `/_dev` Swagger UI + CAP index page (DEV/QA only — never set in prod) |
| `CHAT_MODEL_NAME` | No | — | Override the Joule chat completion model |
| `SEARCH_RATE_LIMIT_MAX` | No | `60` | Per-IP search request limit per window |
| `SEARCH_RATE_LIMIT_WINDOW_MS` | No | `60000` | Search rate-limit window in ms |
| `DASHBOARD_URL` | No | Production URL | Tutorial Dashboard URL injected into notification emails |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | No | — | SMTP transport for local email testing (e.g., MailHog) |

### Approuter (approuter/)

| Variable | Required | Default | Description |
|---|---|---|---|
| `REBUILD_API_KEY` | Yes (rebuild) | — | Bearer token for the approuter live-rebuild webhook |
| `CAP_BASE_URL` | No (CF: VCAP) | — | CAP srv URL for proxy fallback when running standalone |

### Testing

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMOKE_BASE_URL` | Yes (smoke) | — | Approuter URL — `npm run test:smoke` target |
| `SMOKE_SRV_URL` | Yes (smoke) | — | CAP srv URL — `npm run test:smoke` target |
| `SMOKE_QA_BASE_URL` / `SMOKE_QA_SRV_URL` / `SMOKE_QA_TOKEN` | Yes (QA smoke) | — | QA-channel smoke-test endpoints + bearer |
| `SMOKE_ADMIN_TOKEN` | No | — | Bearer for admin-only smoke checks |
| `SMOKE_TECH_USER` / `SMOKE_TECH_PASSWORD` | No | — | Basic-auth credentials for tech-user smoke flow |
| `TECH_USERS` / `TECH_USERS_MAPPING` | No | — | Backend tech-user auth config consumed by smoke tests |
| `A11Y_BASE_URL` | Yes (a11y) | — | Target URL for `npm run test:a11y` |
| `ALLOW_HYBRID_WRITES` | No | `false` | Hybrid-test write guard — must be `true` to permit INSERT/UPDATE/DELETE |

### QA preview rendering (srv-qa/)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PREVIEW_SITE_PATH` | No | bundled | Path to preview-site Hugo project |
| `PREVIEW_HUGO_BIN` | No | `hugo` | Hugo binary to invoke for preview renders |
| `PREVIEW_HUGO_ARGS_PREFIX` | No | — | Extra args prepended to every Hugo preview call |
| `PREVIEW_HUGO_TIMEOUT_MS` | No | — | Per-render timeout |
| `PREVIEW_MAX_CONCURRENT` | No | — | Max concurrent preview renders |
| `PREVIEW_QUEUE_TIMEOUT_MS` | No | — | Queue wait timeout before 503 |
| `SRV_URL_QA` | No | — | QA srv URL passed to preview renderer |

### Migration (legacy IMS cutover)

| Variable | Required | Default | Description |
|---|---|---|---|
| `IMS_BASE_URL` | Yes (migrate) | — | Legacy Java IMS approuter URL |
| `IMS_AUTH_TOKEN` | Yes (migrate) | — | Bearer token for Java IMS API |
| `IMS_DB_URL` / `IMS_DB_USERNAME` / `IMS_DB_PASSWORD` | Yes (HANA migrate) | — | Direct HANA creds for `migrate:hana` (IMSDBUSER schema) |
| `IMS_HANA_CREDENTIALS` / `CAP_HANA_CREDENTIALS` | No | — | Alternate JSON-form HANA credentials for migration |
| `MIGRATION_OUTPUT_DIR` | No | `.migration-data/` | Where migration export files are written |

## Runtime Architecture

See [docs/developers/architecture/runtime.md](docs/developers/architecture/runtime.md) for full details.

## Build Architecture

See [docs/developers/architecture/build.md](docs/developers/architecture/build.md) for full details.

## Joule Architecture

See [docs/developers/architecture/joule.md](docs/developers/architecture/joule.md) for full details.

## CAP Backend (srv/)

See [docs/developers/architecture/cap-backend.md](docs/developers/architecture/cap-backend.md) for full details.

## Build Pipeline

See [docs/developers/architecture/build.md#build-pipeline](docs/developers/architecture/build.md#build-pipeline) for full details.

## Frontend Apps

See [docs/developers/architecture/frontend-apps.md](docs/developers/architecture/frontend-apps.md) for full details.

## Deployment

See [docs/developers/operations/deployment.md](docs/developers/operations/deployment.md) for full details.

## Data Migration

See [docs/historic/data-migration.md](docs/historic/data-migration.md) for full details.

## Testing

See [docs/developers/operations/testing-guide.md](docs/developers/operations/testing-guide.md) for full details.

## External Integrations

See [docs/developers/reference/external-integrations.md](docs/developers/reference/external-integrations.md) for full details.

## Key Design Decisions

### Architecture

- **Tutorial HTML lives in HANA, not on disk.** Hugo builds HTML, `publish-content.ts` gzip-compresses + SHA-256-hashes per slug, then uploads only the changed slugs as BLOBs to `ContentFiles` + `ContentManifest`. AppRouter rewrites `/tutorials/{slug}` → `/content/tutorials/{slug}` on the srv, which decompresses and serves with ETag + bounded LRU. Consequence: `approuter/static/tutorials/` is explicitly removed during build — there is no static fallback. If nothing has been published, `/tutorials/*` returns 404.
- **QA channel is a parallel srv + HDI, not just a route flag.** `tutorials-srv-qa` binds to `tutorials-hana-qa`, runs the same handlers, and exposes preview content gated by the `Tutorial.Author` XSUAA scope. The router sends `/tutorials-qa/*` to the QA destination. Authors get prod-shaped previews with zero risk of cross-tenant data leakage; prod queries can never accidentally hit QA tables.
- **Public Hugo + lazy login.** The catch-all `/*` is `authenticationType: "none"` — anyone can read tutorials without an OAuth bounce. Login is triggered explicitly when the user clicks the profile icon (the `/login` route is the only authenticated GET on a non-API path). API calls under `/api/*` enforce XSUAA at the router and return 401 if the user hasn't signed in yet.
- **Optional service bindings degrade gracefully.** `tutorials-audit-log`, `tutorials-cloud-logging`, and `tutorials-aicore` are `optional: true` in the MTA. The srv detects missing bindings at boot: chat returns 503, audit logging falls through to the console sink, OTLP export is no-op. This makes `mbt build && cf deploy` succeed in fresh sandbox subaccounts that haven't been entitled to AI Core.
- **4-tier GitHub discovery resilience.** Live GitHub → on-disk cache → `RepoCatalog` baseline (HANA) → degrade. CI is the canonical writer of `RepoCatalog` — author pushes update the baseline so a GitHub outage at build time doesn't break the build.

### CAP runtime

- **`bootstrap` vs. `served` event split.** Custom Express routes (`/api/qrcode`, `/build/*`, `/feedback/*`, `/content/*`, `/auth/user`, `/health`, `/chat/stream`) register on `bootstrap` — before CDS auth middleware — so unauthenticated routes can opt out cleanly. Jobs and the Socket.IO plugin register on `served`, after entities and services exist.
- **Socket.IO via `@cap-js-community/websocket`, not raw WebSocket.** `@protocol: ['websocket', ...]` annotations on `DisplayService` + `EventStreamService` map CDS events to Socket.IO messages on `/ws/display` and `/ws/event-stream` namespaces. Scope check happens at namespace-join time (the router can't enforce XSUAA on a Socket.IO upgrade without breaking the handshake).
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query.** The LOB locator expires before the stream is consumed when mixed with non-BLOB columns. `srv/lib/content-store.js` and `srv/lib/embedding-query.js` use raw `db.run()` SQL on HANA and CDS QL on SQLite (unit tests). This is a HANA-only quirk that SQLite silently tolerates.
- **`AnalyticsService.runSelectQuery` is gated by allowlist + parser, not just `@requires`.** `srv/lib/analytics-sql-validator.cjs` rejects anything that isn't a single `SELECT` against the `@analytics.exposed` table set, then wraps with `LIMIT 5001` so a runaway query can't OOM the srv. The exposed entity surface for the `AnalyticsService` is governed by the same `@analytics.exposed` annotations on CDS views.

### Data + identity

- **JWT-only identity on CAP** (vs. the Java IMS's SCI lookup). User attributes come from `xs.user.attributes` on the XSUAA JWT — no synchronous network hop for profile enrichment. See [docs/developers/architecture/authentication.md](docs/developers/architecture/authentication.md).
- **`@PersonalData` + `@cap-js/audit-logging`** drives audit events on `Users`/`UserMetaData`/`TaskRecords` automatically. Plus a manual `SecurityEvent` on user anonymization. No hand-written audit calls.
- **`@changelog` + `@cap-js/change-tracking`** on admin-managed entities (Events, Missions, Groups, Accomplishments, Prizes, ImsConfig, FeaturedTasks, ChatSettings) for the changelog UI.
- **Legacy ID sequences (HANA `.hdbsequence`)** on every entity that exposes an integer ID to legacy IMS consumers. Used during parallel operation; remains a public contract until the cutover deprecation window closes.
- **Slug fields are required** for `Missions.slug` and `CompletionPaths.slug`, populated by `scripts/setup-dev-data.cjs` from `.migration-data/slug-mapping.json` after a fresh DB deploy. Without slugs, `/build/catalog` returns numeric IDs and Hugo cannot generate mission/group URLs.

### Operational defaults

- **`publish-content` always runs with `--force` in production.** Default delta detection silently drops slugs from the manifest because the server treats every publish as a full snapshot — `--force` bypasses delta and republishes the full set. (See [memory: publish-content needs --force](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_publish_content_force.md).)
- **Daily content GC** at 03:00 prunes `SUPERSEDED`/`ROLLED_BACK` content versions older than 7 days (keeps 3 most recent for rollback). Never touches `ACTIVE` or `PUBLISHING`.
- **Notification toggle gates the scheduled job only.** The manual `sendContributorNotifications` admin action always sends regardless — operators need to be able to recover from a misconfigured cron without disabling and re-enabling the toggle.
- **`FailedEmails` + `NGDSFailedMessages` retry queues** keep the integration paths idempotent. Transport failures are persisted, not raised, so a missing SMTP in dev is graceful, not fatal. Retry job replays with exponential backoff.

## Documentation

A consolidated documentation site is planned for a later phase. Until then, reference docs live alongside the code in [docs/](docs/):

| Document | For |
| -------- | --- |
| [docs/author-instructions.md](docs/author-instructions.md) | Tutorial authors — frontmatter, step structure, local preview, publish flow |
| [docs/developers/architecture/build.md](docs/developers/architecture/build.md) | Engineers — full fetch → parse → Hugo → HANA pipeline with timing data |
| [docs/developers/architecture/authentication.md](docs/developers/architecture/authentication.md) | Engineers — XSUAA / IDP auth flow and component interactions |
| [docs/developers/operations/ias-setup.md](docs/developers/operations/ias-setup.md) | Operators — IAS migration configuration steps |
| [docs/historic/ims-api-reference.md](docs/historic/ims-api-reference.md) | Migration — legacy IMS Java API surface for parity reference |
| [docs/historic/ims-uncovered-features.md](docs/historic/ims-uncovered-features.md) | Migration — IMS features not yet ported to CAP |
| [docs/historic/hugo-migration.md](docs/historic/hugo-migration.md) | History — VitePress → Hugo migration rationale |
| [docs/developers/operations/mta-deployment.md](docs/developers/operations/mta-deployment.md) | Operators — MTA build/deploy procedures and troubleshooting |
| [docs/developers/architecture/joule.md](docs/developers/architecture/joule.md) | Engineers — Joule chat architecture and reference |
| [docs/developers/reference/ai-consumption.md](docs/developers/reference/ai-consumption.md) | Engineers — AI consumption surfaces |

## License

SAP Internal — Not for redistribution.

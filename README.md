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

The frontend lives in two trees with very different deploy mechanics.

- **`app/<name>/`** — five standalone applications, each with its own `package.json` and build, copied as a finished `dist/` (or `webapp/`) into `approuter/static/<route>/` at MTA-build time. Each is reachable at its own AppRouter path, with its own auth scope, and runs as a separate browser app.
- **`hugo-apps/src/<name>/`** — nine Vue 3 page-level islands compiled by a single Vite project into `hugo/static/js/*.js` and loaded by Hugo templates as `<script>` tags inside the static site. They share the Hugo page DOM rather than running as separate apps.

### Static site (Hugo)

`hugo/` produces the public tutorial site with SAP Fundamental Styles + UI5 Web Components (Horizon theme, light/dark via `data-theme`). Layouts in `hugo/layouts/`; tutorial pages use the Fiori Object Page layout via Hugo cascade. Tutorial HTML is **not** served from disk — see [Build Pipeline](#build-pipeline). The `hugo.qa.toml` sibling config drives the QA-channel build with author-preview UI stripped.

### app/ — standalone applications

| Path on AppRouter | Source | Stack | Auth |
| --- | --- | --- | --- |
| `/admin-ui/` | [app/admin-shell/](app/admin-shell/) + [app/admin/](app/admin/) | UI5 / `sap.tnt.ToolPage` shell + 13 Fiori Elements headless components | XSUAA + `Admin` |
| `/analytics-ui/` | [app/analytics-explorer/](app/analytics-explorer/) | Vue 3 + Vite + Monaco | XSUAA + `Admin` |
| `/display-app/` | [app/display-app/](app/display-app/) | Vue 3 + Vite, Socket.IO `/ws/display` | XSUAA |
| `/scanner-ui/` | [app/scanner/webapp/](app/scanner/webapp/) | UI5 (`sap.ndc.BarcodeScanner`) | XSUAA + `MobileApp` |

#### Admin shell + Fiori Elements components

- **`admin-shell/`** — `sap.tnt.ToolPage` with collapsible side navigation, theme switcher (light/dark/auto), Router-managed content area, and three custom views (Board, Statistics, TutorialDashboard) plus a Privacy view.
- **`admin/`** — 13 Fiori Elements apps loaded as headless components via `componentUsages`: `accomplishments`, `accounts`, `analytics`, `changelog`, `events`, `feedback`, `groups`, `joule`, `missions`, `operations`, `prizes`, `tags`, `tutorials`.
- All annotations live in [app/admin-annotations.cds](app/admin-annotations.cds); change-tracking annotations in [app/change-tracking.cds](app/change-tracking.cds).
- Theme persisted to `localStorage` key `sap-tutorials-admin-theme`, defaulting to OS preference.

#### Analytics Explorer

Vue 3 SPA over `AnalyticsService` (`/admin/analytics`). Two tabs:

- **Entity browser** — driven by the `@analytics.exposed` allowlist in [db/schema-ext.cds](db/schema-ext.cds); supports `$apply` (groupby + aggregate), filter, top, skip, orderby.
- **SQL** — Monaco editor (lazy-loaded) backed by the `runSelectQuery(sql)` action. Server-side validator (`srv/lib/analytics-sql-validator.cjs`): SELECT-only, allowlisted tables, no DDL/DML/multi-statement; every query is wrapped with `LIMIT 5001` to cap result size.

#### Display App

Standalone event-monitor dashboard for big screens. Five rotating views (Board, Statistics, Leaderboard, Burnup, Track Stats) auto-refresh; live updates arrive via Socket.IO on `/ws/display`. The `DisplayApp` scope is checked at namespace join, not at the AppRouter (which lets `^/socket\.io/` and `^/ws/` through unauthenticated).

#### Scanner

UI5 barcode scanner using `sap.ndc.BarcodeScanner` for device-camera scanning. Looks up a contestant by the account number encoded in their badge QR code via `getContestant(accountNumber)` (OData function on `ScannerService`), shows progress + prize info, and claims via `claimPrize(recordId)`. There's a Vue 3 sibling at `/scanner-vue/` — see below.

### hugo-apps/ — page-level Vue 3 islands

Compiled by `build:apps` (a single Vite project) into `hugo/static/js/<name>.js`. Each island mounts onto a Hugo-rendered DOM node when its host page loads.

| Island | Loaded on | Purpose |
| --- | --- | --- |
| `navigator` | `/` (homepage) | Tutorial navigator with filters and search |
| `app-space` | `/app-space` | Event-themed Vue SPA (Joule/Sapphire theme overlays); progress via `/api/getEventProgress`, QR via `/api/qrcode`, live updates via Socket.IO |
| `event-display` | `/event-display` | Launcher for the standalone display dashboard |
| `nav-dropdown` | All pages (header) | Mission/group dropdown in the shellbar |
| `scanner-vue` | `/scanner-vue/` | Vue 3 mobile-optimized scanner using native `BarcodeDetector`, falls back to manual JSON input |
| `tutorial-feedback` | Tutorial Object Pages | NPS rating + comment form, posts to `/feedback/submit` |
| `tutorial-rating` | Tutorial Object Pages | `ui5-rating-indicator` shipped with U6 |
| `cmd-palette` | All pages | ⌘K command palette (U4) |
| `me` | `/me/` | Profile + Recent Activity timeline (`ui5-timeline`, U17), reads `getMyCompletions` |

`hugo-apps/src/composables/` and `hugo-apps/src/shared/` hold cross-island utilities and are **not** themselves islands.

### UI features (U0–U18) on the static site

Beyond the islands above, the U0–U18 pilot shipped in-place enhancements rendered via Hugo partials + scoped JS modules in `hugo/assets/js/`:

- **Object Page layout** (U1), **Wizard step indicator** (U2), **Illustrated states** (U7), **Codetabs** (U8), **Glossary** (U9), **Toast + final-step CTA** (U10), **Reading-progress bar + scrollspy** (U11), **Reader mode** (U12), **Mermaid diagrams** (U13), **Skeleton loaders** (U14), **Lightbox** (U15), **Mission side-nav** (U16), **Mobile step sheet** (U18).

These are loaded via `hugo/assets/js/ui5-bootstrap.ts` (and tutorial-only modules via `hugo/assets/js/tutorial.ts`). Cross-page features that gate themselves on DOM presence belong in `ui5-bootstrap.ts` imports — `tutorial.ts` only loads on tutorial layouts.

## Deployment

Single MTA deployment to SAP BTP Cloud Foundry:

```bash
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar
```

### MTA Modules

The deployment in [.deploy/mta.yaml](.deploy/mta.yaml) defines five modules — the prod and QA channels share an AppRouter and XSUAA instance but each gets its own srv app and HDI container.

| Module | Type | Source | Requires | Purpose |
| --- | --- | --- | --- | --- |
| `tutorials-db-deployer` | `hdb` | `gen/db` | `tutorials-hana` | Prod HANA schema + indexes (one-shot HDI deploy) |
| `tutorials-db-qa-deployer` | `hdb` | `gen/db-qa` | `tutorials-hana-qa` | QA HANA schema (peer of `db/`, namespace `com.sap.developers.ims.qa`) |
| `tutorials-srv` | `nodejs` | `gen/srv` | hana, xsuaa, destination, mail, audit-log, cloud-logging, aicore | CAP backend (9 services + jobs + Socket.IO + content store + RAG) |
| `tutorials-srv-qa` | `nodejs` | `gen/srv-qa` | hana-qa, xsuaa | QA-channel CAP srv (re-renders author drafts via `srv-qa/lib/parsers.bundle.mjs`) |
| `tutorials-approuter` | `approuter.nodejs` | `approuter/` | xsuaa, `srv-api` (destination), `srv-qa-api` (destination) | XSUAA login + static delivery + reverse proxy to both srv apps |

The AppRouter routes `^/tutorials-qa/(.*)`, `^/qa-search/(.*)` to the `srv-qa-api` destination and everything else (`/api/*`, `/admin/*`, `/display/*`, `/content/*`, etc.) to `srv-api`. WebSocket paths (`^/socket\.io/`, `^/ws/`) are `authenticationType: 'none'` because the scope check happens at namespace join.

### BTP Service Bindings

| Resource | Service / plan | Required by | Notes |
| --- | --- | --- | --- |
| `tutorials-hana` | `hana` / `hdi-shared` | `tutorials-srv`, `tutorials-db-deployer` | Prod HDI container (`com.sap.xs.hdi-container`) |
| `tutorials-hana-qa` | `hana` / `hdi-shared` | `tutorials-srv-qa`, `tutorials-db-qa-deployer` | QA-channel HDI container — separate from prod, no cross-foreign-keys |
| `tutorials-xsuaa` | `xsuaa` / `application` | all srv apps + approuter | Configured from [.deploy/xs-security.json](.deploy/xs-security.json) (Admin, MobileApp, DisplayApp, Tutorial.Author, ConsolidationScope, DeveloperApp scopes) |
| `tutorials-destination` | `destination` / `lite` | `tutorials-srv` | NGDS + SCI remote endpoints |
| `tutorials-mail` | `mail` / `standard` | `tutorials-srv` | SMTP for notification escalation emails |
| `tutorials-audit-log` | `auditlog` / `standard` (optional) | `tutorials-srv` | `@cap-js/audit-logging` sink for `@PersonalData` events |
| `tutorials-cloud-logging` | `cloud-logging` / `standard` (optional) | `tutorials-srv` | OTLP ingest enabled; backs the `cfLogsUrl` virtual on `PipelineLog` / `JobExecutionLog` |
| `tutorials-aicore` | `aicore` / `extended` (optional) | `tutorials-srv` | Backs `ChatService` + embeddings + RAG (`getRelevantSteps` tool) |

`optional: true` resources let `mbt build && cf deploy` succeed in a subaccount that hasn't entitled them yet (e.g., a fresh sandbox without AI Core). The srv app degrades gracefully when bindings are missing — chat returns 503, audit logging falls through to the console sink, OTLP export is no-op.

### Route Architecture

The AppRouter (`approuter/xs-app.json`) evaluates routes top-to-bottom on first match — so order matters. There are ~28 active routes; canonical reference for auth/scope per route is [docs/developers/operations/testing-endpoints.md](docs/developers/operations/testing-endpoints.md).

#### Static UIs (XSUAA + scope, served from `approuter/static/<route>/`)

| Pattern | Backed by | Auth |
| --- | --- | --- |
| `^/admin-ui/(.*)$` | `app/admin-shell/dist/` (TNT shell + 13 Fiori Elements components) | XSUAA + `Admin` |
| `^/analytics-ui/(.*)$` | `app/analytics-explorer/dist/` (Vue 3 + Monaco) | XSUAA + `Admin` |
| `^/scanner-ui/(.*)$` | `app/scanner/webapp/` (UI5 BarcodeScanner) | XSUAA + `MobileApp` |
| `^/scanner-vue/(.*)$` | `hugo-apps/src/scanner-vue/` island | XSUAA + `MobileApp` |

#### Authenticated API proxies (XSUAA + scope, → `srv-api` destination → `tutorials-srv`)

| Pattern | Service | Scope |
| --- | --- | --- |
| `^/admin/exports/(.*)$` | `ExportsService` | `Admin` |
| `^/admin/analytics/(.*)$` | `AnalyticsService` (gated entity surface + `runSelectQuery`) | `Admin` |
| `^/admin/(.*)$` | `AdminService` | `Admin` |
| `^/display/(.*)$` | `DisplayService` | `DisplayApp` |
| `^/api/v1/(.*)$` | `ConsolidationService` | `ConsolidationScope` |
| `^/api/(.*)$` | `DeveloperService` + `/api/qrcode`, `/api/recommendations` | XSUAA (any) |
| `^/chat/(.*)$` | `ChatService` + `/chat/stream` (SSE) | XSUAA (any) |
| `^/scanner/(.*)$` | `ScannerService` OData functions | XSUAA + `MobileApp` |
| `^/auth/user$` | Identity probe | XSUAA (any) |
| `^/login(\?.*)?$` | OAuth2 entry (XSUAA redirect) | XSUAA |

#### QA channel (XSUAA + `Tutorial.Author`, → `srv-qa-api` destination → `tutorials-srv-qa`)

| Pattern | Target on srv-qa | Notes |
| --- | --- | --- |
| `^/tutorials-qa/_nav\.json$` | `/content/nav` | QA-only navigation metadata |
| `^/tutorials-qa/search/?(.*)$` | static `/qa/search/$1` | search page shell from Hugo QA build |
| `^/qa-search/(.*)$` | `/search/$1` | QA-only `SearchService` proxy |
| `^/tutorials-qa/(.*)$` | `/content/tutorials/$1` | preview HTML from `tutorials-hana-qa` BLOBs |

#### Public / unauthenticated (no session required)

| Pattern | Purpose |
| --- | --- |
| `^/api/ChatConfig(.*)$` | Chat client bootstrap — config only, no PII |
| `^/search/(.*)$` | `SearchService` — public tutorial search |
| `^/content/(.*)$` | Tutorial HTML serve + `/content/hashes`, `/content/nav` (writes are bearer-token gated by `CONTENT_API_KEY` at the srv) |
| `^/build/(.*)$` | Build pipeline catalog/navigator/repo-catalog endpoints (CI consumers) |
| `^/feedback/(.*)$` | `/feedback/submit` (rate-limited, IP hashed via `SUBMISSION_SALT_SECRET`) |
| `^/health(/.*)?$` | Liveness + DB connectivity |
| `^/.well-known/(.*)$`, `^/ord/(.*)$` | ORD discovery |
| `^/rest/(.*)$` | Custom REST escape hatch (server-defined sub-routes) |
| `^/tutorials/_nav\.json$` → `/content/nav` | Prod navigation metadata |
| `^/tutorials/(.*)$` → `/content/tutorials/$1` | Prod HTML rewrite to HANA-backed serve |

#### WebSocket transport (auth: none at the router; scope enforced at namespace join)

| Pattern | Namespace | Scope check |
| --- | --- | --- |
| `^/socket\.io/(.*)$` | Socket.IO upgrade transport | (none — namespace-level) |
| `^/ws/(.*)$` | `/ws/display` | `DisplayApp` enforced inside `@cap-js-community/websocket` plugin |
| `^/ws/(.*)$` | `/ws/event-stream` | anonymous (kiosk monitors) |

The router is intentionally `authenticationType: "none"` for `^/socket\.io/` and `^/ws/` because the WebSocket plugin runs scope checks at namespace-join time — adding XSUAA at the router would force an OAuth dance the Socket.IO client can't complete cleanly. See [docs/authentication-primer.md](docs/authentication-primer.md) for the full token flow.

#### Catch-all (last)

`^/(.*)$` → `localDir: static/` (Hugo build output: homepage, `/tutorials/{slug}` shells, `/missions/{slug}`, `/groups/{slug}`, `/me/`, `/event-display/`, `/app-space/`, plus the compiled Vue islands in `hugo/static/js/`). `authenticationType: "none"` — public Hugo content with lazy login on demand.

## Data Migration

Migration scripts in `scripts/` support parallel operation during cutover from the Java IMS. Three migration paths cover the matrix of source-system access (REST API vs. direct HANA):

| Script | npm alias | Source → Target | Purpose |
| --- | --- | --- | --- |
| `migrate-reference-data.js export` | `npm run migrate:reference` | IMS REST → JSON file | Export tutorials, missions, groups, events, tags, accomplishments, prizes |
| `migrate-reference-data.js import` | `npm run migrate:reference` | JSON file → CAP | Import reference data into CAP HDI (idempotent on `legacyId`) |
| `migrate-reference-data.js populate-slugs` | — | `.migration-data/slug-mapping.json` → CAP | Backfill `Missions.slug` + `CompletionPaths.slug` after import (87 missions, 66 groups) |
| `migrate-user-progress.js export` | `npm run migrate:users` | IMS REST → JSON file | Paged + resumable export of users + task records |
| `migrate-user-progress.js import` | `npm run migrate:users` | JSON file → CAP | Idempotent re-import (uses `uuid`/`legacyId` for upsert) |
| `migrate-from-hana.js` | `npm run migrate:hana` | IMS HANA → CAP HANA | Direct HDI-to-HDI migration; bypasses the REST API for bulk + cross-instance moves |
| `compare-systems.js` | `npm run compare` | IMS vs. CAP REST | Endpoint-by-endpoint diff for cutover sign-off |

### `migrate-from-hana.js` source-credentials resolution (first match wins)

1. `IMS_HANA_CREDENTIALS` env var (full JSON: `host`, `port`, `user`, `password`, `schema`)
2. `IMS_DB_URL` + `IMS_DB_USERNAME` + `IMS_DB_PASSWORD` env vars (the shape returned by `cf env imsdev`)
3. `--source-instance=<name> --source-key=<name>` (resolved via `cf service-key`)

Useful flags: `--discover` (list source-schema tables, no writes), `--dry-run`, `--source-only`, `--entity=tutorials,users,…`.

### Environment

`IMS_BASE_URL`, `CAP_BASE_URL`, `IMS_AUTH_TOKEN` for the REST-based scripts; HANA env vars (above) for `migrate-from-hana.js`. Java IMS uses the `IMSDBUSER` schema (not the HDI schema) — see `cf env imsdev` for prod creds.

Export artifacts land in `.migration-data/` (gitignored). The same directory holds `slug-mapping.json`, which is **the canonical slug source for fresh DB deploys** — `scripts/setup-dev-data.cjs` consumes it via `npx cds bind --exec` to assign slugs to records that lack them. Per [CLAUDE.md](CLAUDE.md), the legacyId match is best-effort; a slug just needs to exist for `/build/catalog` to surface text slugs instead of numeric IDs.

## Testing

Five Vitest projects defined in [vitest.config.ts](vitest.config.ts) — each with its own include pattern, environment, and prerequisites:

| Project | Command | Backing store / target | Use |
| --- | --- | --- | --- |
| `unit` | `npm test` | In-memory SQLite (mock auth) | Default fast suite — pure-fn, parsers, CDS handlers, shared `srv/lib/` modules. Watch mode via `npm run test:watch` |
| `hybrid` | `npm run test:hybrid` | Real prod HDI via `cds bind --exec` | Schema deploy, HANA sequences, views, developer workflow, admin CRUD, search, vector round-trip, recommendations, audit/feedback. Requires `cf login` to DEV |
| `hybrid-qa` | `cds bind --exec -- npx vitest run --project hybrid-qa` | Real QA HDI (`hana-tutorials-db-qa`) | Author-channel parity tests; uses `pool: 'forks'` + `_guard.js` write protection |
| `smoke` | `npm run test:smoke` | Deployed approuter + srv over HTTP | Health, public endpoints, auth enforcement, OData metadata, content serve, search, WebSocket handshake, redirects, SEO/JSON-LD, QA routes. Set `SMOKE_BASE_URL` + `SMOKE_SRV_URL` |
| `a11y` | `npm run test:a11y` | Deployed approuter (Lighthouse CI) | WCAG smoke; full Lighthouse via `npm run test:a11y:lighthouse`, summary via `npm run test:a11y:summary` |

`npm run test:all` runs the full matrix under `cds bind --exec` (so hybrid + hybrid-qa get real bindings).

### Hybrid write safety

`test/hybrid/_guard.js` (and the `hybrid-qa` setup file) check `ALLOW_HYBRID_WRITES=true` before any INSERT/UPDATE/DELETE. Test data is prefixed with `__TEST__` and removed in `afterAll`. The guard exists because hybrid suites hit the same DEV HDI that powers the deployed app — a leaked write is a real write.

### Layout

- `test/unit/`, `test/lib/`, `test/jobs/`, `test/parsers/`, `test/integration/`, `test/srv-qa/` — picked up by `unit` (also pulls `srv/**/__tests__/`, `scripts/__tests__/`, and `app/analytics-explorer/src/**/__tests__/`)
- `test/hybrid/` — 17 hybrid suites
- `test/hybrid-qa/` — QA-channel parity
- `test/smoke/` — 26 smoke suites; CI runs them automatically after deploy via [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
- `test/a11y/` — Lighthouse CI config + summary script
- `test/fixtures/` — Shared fixture data (no test files)

### Running a single file

```bash
npx vitest run test/lib/mail-client.test.js                 # one unit file
npx vitest run --project smoke test/smoke/health.test.js    # one smoke file
cds bind --exec -- npx vitest run test/hybrid/views.test.js # one hybrid file
```

## External Integrations

| System | Direction | Bound via | Purpose |
| --- | --- | --- | --- |
| GitHub `sap-tutorials` org (public) | Build-time | `GITHUB_TOKEN` (rate-limit avoidance) | Tutorial markdown source, discovered via `discoverAllTutorials()` |
| GitHub `*-Contribution` repos (private) | Build-time | `GITHUB_TOKEN` (required) | Validation quiz `rules.vr` files; QA channel content (`ONLY_CONTRIBUTION_REPOS=true`) |
| XSUAA / SAP IDP | Inbound | `tutorials-xsuaa` (`xsuaa/application`) | OAuth2 + JWT issuance; per-scope authorization (`Admin`, `MobileApp`, `DisplayApp`, `Tutorial.Author`, `ConsolidationScope`) |
| NGDS (legacy IMS analytics) | Outbound | `tutorials-destination` → `ngds` destination | `POST /ngds/developers/ims` on tutorial/accomplishment completion. Failed sends persisted in `NGDSFailedMessages`; `srv/jobs/ngds-retry.js` replays them with backoff |
| Adobe Analytics | Outbound | Direct fetch — no binding | XML beacon `event86` to `sap.d1.sc.omtrdc.net` (report suite `sapdeveloperdev`); see [srv/lib/adobe-analytics.js](srv/lib/adobe-analytics.js) |
| BTP Mail | Outbound | `tutorials-mail` (`mail/standard`) | Contributor + author notifications via `srv/lib/mail-client.js`; failed sends queued in `FailedEmails` |
| SAP AI Core | Outbound | `tutorials-aicore` (`aicore/extended`, optional) | Chat completions for `ChatService` + RAG; embedding generation for `TutorialEmbedding`. Degrades to 503 when unbound |
| SAP Audit Log | Outbound | `tutorials-audit-log` (`auditlog/standard`, optional) | `@PersonalData`-driven access/modification events on `Users`/`UserMetaData`/`TaskRecords`; falls back to console sink when unbound |
| SAP Cloud Logging | Outbound | `tutorials-cloud-logging` (`cloud-logging/standard`, optional, `ingest_otlp.enabled=true`) | OTLP export; backs `cfLogsUrl` virtual on `PipelineLog`/`JobExecutionLog`. No-ops when unbound |
| SAP Cloud Foundry API | Outbound | `cf` CLI inside `migrate-from-hana.js` | Resolves `cf service-key` for cross-instance HANA migration (cutover only) |

### Identity is JWT-only on CAP

The Java IMS calls SCI (SAP Cloud Identity) over HTTPS to enrich user profiles after JWT validation. CAP does **not** — `req.user.attr.email`/`given_name`/`family_name` come straight from the XSUAA JWT's `xs.user.attributes` claims, eliminating that network hop and the corresponding destination binding. SCI lookups remain in scope only for the `migrate-user-progress.js` script during cutover, which talks to Java IMS REST endpoints that still go through SCI on the Java side.

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

- **JWT-only identity on CAP** (vs. the Java IMS's SCI lookup). User attributes come from `xs.user.attributes` on the XSUAA JWT — no synchronous network hop for profile enrichment. See [docs/authentication-primer.md](docs/authentication-primer.md).
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
| [docs/authentication-architecture.md](docs/authentication-architecture.md) | Engineers — XSUAA / IDP auth flow and component interactions |
| [docs/authentication-primer.md](docs/authentication-primer.md) | Engineers — high-level auth model intro |
| [docs/developers/operations/ias-setup.md](docs/developers/operations/ias-setup.md) | Operators — IAS migration configuration steps |
| [docs/historic/ims-api-reference.md](docs/historic/ims-api-reference.md) | Migration — legacy IMS Java API surface for parity reference |
| [docs/historic/ims-uncovered-features.md](docs/historic/ims-uncovered-features.md) | Migration — IMS features not yet ported to CAP |
| [docs/historic/hugo-migration.md](docs/historic/hugo-migration.md) | History — VitePress → Hugo migration rationale |
| [docs/developers/operations/mta-deployment.md](docs/developers/operations/mta-deployment.md) | Operators — MTA build/deploy procedures and troubleshooting |
| [docs/developers/architecture/joule.md](docs/developers/architecture/joule.md) | Engineers — Joule chat architecture and reference |
| [docs/developers/reference/ai-consumption.md](docs/developers/reference/ai-consumption.md) | Engineers — AI consumption surfaces |

## License

SAP Internal — Not for redistribution.

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
│   ├── display-app/            #   Standalone event monitor dashboard (Vue 3 + Vite, STOMP WebSocket)
│   ├── admin-annotations.cds   #   @UI/@Common annotations for all admin screens
│   └── change-tracking.cds     #   @cap-js/change-tracking config for admin entities
├── apps/                       # Vue 3 micro-apps for the public site (Vite, injected into Hugo)
│   └── src/
│       ├── app-space/          #     Event-themed tutorial kiosk (Joule/Sapphire themes)
│       ├── event-display/      #     Event display embed (leaderboard widget)
│       ├── nav-dropdown/       #     Navigation dropdown component
│       ├── navigator/          #     Full tutorial navigator page
│       └── shared/             #     Shared utilities, API client, types
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
│   ├── server.js               #   Bootstrap: registers Express routes + STOMP + jobs on cds.on('served')
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
│   ├── jobs/                   #   Scheduled tasks: scheduler, account-merge, analytics, cleanup,
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

| Script | Description |
|--------|-------------|
| `npm install` | Install all dependencies |
| `npm run fetch-tutorials` | Fetch markdown from GitHub, parse, generate Hugo content pages |
| `npm run dev` | Hugo dev server with live reload |
| `npm run build` | Production static build (Hugo) |
| `npm run test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `cds watch` | Start CAP backend (http://localhost:4004) |
| `npm run migrate:reference` | Export/import reference data from Java IMS |
| `npm run migrate:users` | Export/import user progress (paged, resumable) |
| `npm run compare` | Compare Java IMS and CAP responses side-by-side |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | No | — | Avoids GitHub API rate limits when fetching commit metadata |
| `CAP_BASE_URL` | No | `http://localhost:4004` | CAP backend URL for build pipeline and migration scripts |
| `IMS_BASE_URL` | No | `https://imsprod-approuter...` | Legacy Java IMS URL (migration only) |
| `IMS_AUTH_TOKEN` | No | — | Bearer token for Java IMS API (migration only) |
| `SMTP_HOST` | No | — | SMTP server for local email testing (e.g., MailHog) |
| `DASHBOARD_URL` | No | Production URL | Tutorial Dashboard URL used in notification emails |

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│ SAP BTP Cloud Foundry                                                  │
│                                                                        │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐   │
│  │  AppRouter   │────▶│  CAP srv     │────▶│  SAP HANA Cloud      │   │
│  │  (static +   │     │  (Node.js)   │     │  (HDI container)     │   │
│  │   auth)      │     │              │     └──────────────────────┘   │
│  └──────────────┘     │  Services:   │                                │
│        │              │  /api        │     ┌──────────────────────┐   │
│        │              │  /admin      │────▶│  BTP Destination     │   │
│        ▼              │  /display    │     │  (NGDS, SCI)         │   │
│  ┌──────────────┐     │  /api/v1     │     └──────────────────────┘   │
│  │  XSUAA       │     │              │                                │
│  │  (SAP IDP)   │     │  Custom:     │     ┌──────────────────────┐   │
│  └──────────────┘     │  /api/qrcode │────▶│  BTP Mail Service    │   │
│                       │  /build/     │     │  (SMTP notifications)│   │
│                       │  catalog     │     └──────────────────────┘   │
│                       │              │                                │
│                       │  WebSocket:  │     ┌──────────────────────┐   │
│                       │  /display/   │────▶│  Adobe Analytics     │   │
│                       │  websocket   │     │  (event beacons)     │   │
│                       └──────────────┘     └──────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

## CAP Backend (srv/)

The CAP Node.js service is the complete replacement for the Java IMS Spring Boot application.

### Services

| Service | Path | Auth | Purpose |
|---------|------|------|---------|
| DeveloperService | `/api` | DeveloperApp | Tutorial progress, step completion, event progress |
| AdminService | `/admin` | Admin | Full CRUD, GDPR, statistics, export, notifications |
| DisplayService | `/display` | DisplayApp | Event leaderboard, burnup charts, track stats |
| ConsolidationService | `/api/v1` | ConsolidationScope | Account merge, legacy compatibility |

### Custom Endpoints (Express)

Registered via `cds.on('bootstrap')` in [srv/server.js](srv/server.js):

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/qrcode` | None (through AppRouter) | Generate QR code PNG for tutorial completion |
| `GET /build/catalog` | None | Unauthenticated mission/group data for static site build |

### WebSocket

STOMP-over-WebSocket broker at `/display/websocket` for real-time event dashboard updates. Broadcasts tutorial completion events to subscribed display monitors. Implementation: [srv/lib/stomp-broker.js](srv/lib/stomp-broker.js).

### Scheduled Jobs

Registered via `cds.on('served')` in [srv/jobs/scheduler.js](srv/jobs/scheduler.js). All jobs use distributed locking for multi-instance safety.

| Schedule | Job | Description |
|----------|-----|-------------|
| Daily 00:00 | Step failure cleanup | Remove step failures older than 90 days |
| Daily 00:15 | Active learner analytics | Record daily active user count |
| Every 2h | NGDS retry | Retry failed NGDS message deliveries |
| Daily 01:00 | Account merge batch | Process scheduled account merges |
| Jan 2 / Jul 2 | Tag cleanup | Remove unused tags |
| Weekly Sun 02:00 | Tutorial metadata sync | Sync tutorial metadata from cache |
| Weekly Mon 09:00 | Contributor notifications | Send escalating emails to outdated tutorial authors |
| Every 4h | Email retry | Retry failed email deliveries |

### Key Libraries (srv/lib/)

| File | Purpose |
|------|---------|
| `accomplishment-evaluator.js` | Evaluate badge/accomplishment rules against user progress |
| `contributor-notifications.js` | Compute stale tutorials, escalation routing, config helpers |
| `mail-client.js` | Nodemailer transport with BTP Mail binding, template rendering, retry |
| `stomp-broker.js` | Lightweight STOMP frame parser + WebSocket pub/sub |
| `ngds-client.js` | NGDS analytics integration with dead-letter retry |
| `adobe-analytics.js` | Adobe Analytics XML beacon on tutorial completion |
| `account-merge.js` | Merge duplicate user accounts |
| `build-catalog.js` | Build pipeline data (missions, paths, tutorials) |
| `qrcode-handler.js` | QR code PNG generation |
| `tutorial-sync.js` | Sync tutorial metadata from GitHub cache |
| `legacy-id.js` | HANA sequence-backed legacy integer IDs |

### Data Model (db/schema.cds)

Core entities:

- **Users** — SAP IDP users (uuid, sapId, displayName)
- **Tutorials** — Tutorial metadata (slug, title, steps)
- **Missions** — Collections of completion paths
- **CompletionPaths** — Ordered groups of tutorials within a mission
- **Events** — Time-boxed learning events (SAP TechEd, etc.)
- **TaskRecords** — User completion records (step, tutorial, mission)
- **AccomplishmentRecords** — Earned badges/prizes
- **TutorialMeta** — Notification tracking (reviewed date, notification level)
- **ImsConfig** — Key-value configuration store

Supporting entities: Steps, Tags, Prizes, PrizeRecords, TutorialContributors, TutorialRepositories, StepFailures, NGDSFailedMessages, FailedEmails, JobLocks, ActiveLearnerRecords, DashboardMonitoredRecords, FeaturedTasks.

### Notification Escalation System

Tutorial contributors receive escalating email reminders when tutorials go 6+ months without review:

| Level | TO | CC | Message |
|-------|----|----|---------|
| 0 (First) | Tutorial owner/author | — | 90-day retirement warning |
| 1 (Second) | Tutorial owner/author | Repo owner | 60-day warning |
| 2 (Third) | Tutorial owner/author | Repo owner + admin list | 30-day warning |
| 3 (Final) | Admin list | — | Deadline passed, arrange removal |

Resend interval: 30 days between escalation levels. Controlled via `ImsConfig` entries `isNotificationSendingAllowed` and `emailListForOutdated`.

## Build Pipeline

```
sap-tutorials GitHub repos
  → scripts/fetch-tutorials.ts         Fetch raw markdown (cached in .tutorial-cache/)
    → scripts/parsers/*                Parse frontmatter, steps, images, options
      → hugo/content/tutorials/*.md    Generated Hugo content pages

CAP backend (CAP_BASE_URL)
  → GET /build/catalog (unauthenticated)
    → missions + completion paths + tutorial ordering
      → hugo/content/missions/*.md and groups/*.md pages
```

### Parsers (scripts/parsers/)

| Parser | Detection | Delimiter |
|--------|-----------|-----------|
| V2 (current) | `parser: v2` in frontmatter | `###` (H3) headings = step titles |
| V1 (legacy) | Default | `[ACCORDION-BEGIN]`/`[ACCORDION-END]` markers |

Shared processing: image URL resolution to GitHub raw CDN, comment stripping, option block → Vue component conversion.

### Cache

`.tutorial-cache/` stores:
- Raw tutorial markdown from GitHub
- GitHub commit metadata (authors, timestamps)
- CAP catalog data (missions, paths) — 24h TTL

Delete the directory to force a full re-fetch.

## Frontend Apps

### Static Site (Hugo)

Hugo generates the static tutorial pages with SAP Fundamental Styles. Deployed as static files in `approuter/static/`.

### AppSpace (apps/src/app-space/)

Event-themed tutorial space (Vue 3 SPA) used at SAP events. Features:
- Joule/Sapphire theme overlays
- Progress tracking via `/api/getEventProgress`
- QR code generation via `/api/qrcode`
- Real-time updates via STOMP WebSocket

### Display App (app/display-app/)

Event monitor dashboard (Vue 3 SPA) for big screens at SAP events. Shows:
- Leaderboard, burnup charts, track statistics
- 5 rotating views with auto-refresh
- Real-time updates via STOMP WebSocket at `/display/websocket`

## Deployment

Single MTA deployment to SAP BTP Cloud Foundry:

```bash
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar
```

### MTA Modules

| Module | Type | Purpose |
|--------|------|---------|
| `tutorials-srv` | nodejs | CAP backend (all services + jobs + WebSocket) |
| `tutorials-db-deployer` | hdb | HANA schema deployment |
| `tutorials-approuter` | approuter.nodejs | Static files + XSUAA auth |

### BTP Service Bindings

| Resource | Service | Purpose |
|----------|---------|---------|
| `tutorials-hana` | hana (hdi-shared) | SAP HANA Cloud database |
| `tutorials-xsuaa` | existing (`xsuaa-imsdev`) | Authentication (SAP IDP) |
| `tutorials-destination` | destination (lite) | NGDS, SCI remote services |
| `tutorials-mail` | existing (`mail-imsdev`) | SMTP for notification emails |

### Route Architecture

```
Browser → AppRouter (XSUAA auth)
  → /api/*      → Destination → CAP srv (DeveloperService)
  → /admin/*    → Destination → CAP srv (AdminService)
  → /display/*  → Destination → CAP srv (DisplayService)
  → /*          → static/ (Hugo build + display-app)

Display monitors → CAP srv directly (no AppRouter)
  → ws://srv-url/display/websocket (STOMP, unauthenticated)
  → /build/catalog (unauthenticated)
```

## Data Migration

Migration scripts in `scripts/` support parallel operation during cutover from Java IMS:

| Script | Purpose |
|--------|---------|
| `migrate-reference-data.js export` | Export tutorials, missions, events, tags from Java IMS |
| `migrate-reference-data.js import` | Import JSON into CAP system |
| `migrate-reference-data.js populate-slugs` | Patch URL slugs from AEM cache into CAP |
| `migrate-user-progress.js export` | Export users + task records (paged, resumable) |
| `migrate-user-progress.js import` | Import user progress into CAP |
| `compare-systems.js` | Endpoint-by-endpoint diff between Java IMS and CAP |

Export files go to `.migration-data/` (gitignored).

## Testing

```bash
npm run test                                     # Full suite (180 tests)
npm run test:watch                               # Watch mode
npx vitest run test/lib/mail-client.test.js      # Single test file
npx vitest run test/deployment-smoke.test.js     # Smoke tests
```

Test categories:
- **Unit tests** (`test/lib/`) — Pure function tests for all srv/lib/ modules
- **Service tests** (`test/*.test.js`) — CDS service integration tests with in-memory SQLite
- **Integration tests** (`test/integration/`) — End-to-end workflows (create user → complete tutorial → evaluate accomplishment)
- **Parser tests** (`scripts/__tests__/`) — Tutorial markdown parsing
- **Smoke tests** (`test/deployment-smoke.test.js`) — Service registration, auth enforcement, build catalog

## External Integrations

| System | Direction | Purpose |
|--------|-----------|---------|
| NGDS | Outbound | Analytics events on tutorial/accomplishment completion |
| Adobe Analytics | Outbound | XML beacons for completion tracking (event86) |
| BTP Mail | Outbound | SMTP notifications to tutorial contributors |
| SCI (Cross-domain Identity) | Inbound | User identity resolution |
| GitHub (sap-tutorials) | Build-time | Tutorial markdown source |

## Key Design Decisions

- **CAP `bootstrap` vs `served` events**: Custom Express routes (`/api/qrcode`, `/build/catalog`) register on `bootstrap` (before CDS auth middleware). Side-effects (jobs, STOMP broker) register on `served` (after services ready).
- **Unauthenticated build endpoint**: `/build/catalog` runs in CI without user credentials. Registered via Express before CDS auth applies.
- **STOMP over plain WebSocket**: Display app is already deployed with STOMP client. Zero client changes during cutover.
- **Notification toggle**: The `isNotificationSendingAllowed` config gates only the scheduled job. Manual admin trigger (`sendContributorNotifications` action) always works.
- **Email retry queue**: Failed emails go to `FailedEmails` table with exponential retry. Transport failures (no SMTP in dev) are graceful, not fatal.
- **Legacy ID sequences**: HANA `.hdbsequence` files generate integer IDs for backward compatibility with Java IMS consumers during parallel operation.
- **Slug fields**: `Missions.slug` and `CompletionPaths.slug` are required for the static build pipeline to generate URL-friendly page paths. Populated via migration script from AEM cache data.

## Documentation

A consolidated documentation site is planned for a later phase. Until then, reference docs live alongside the code in [docs/](docs/):

| Document | For |
| -------- | --- |
| [docs/author-instructions.md](docs/author-instructions.md) | Tutorial authors — frontmatter, step structure, local preview, publish flow |
| [docs/content-pipeline.md](docs/content-pipeline.md) | Engineers — full fetch → parse → Hugo → HANA pipeline with timing data |
| [docs/authentication-architecture.md](docs/authentication-architecture.md) | Engineers — XSUAA / IDP auth flow and component interactions |
| [docs/authentication-primer.md](docs/authentication-primer.md) | Engineers — high-level auth model intro |
| [docs/ias-migration-setup.md](docs/ias-migration-setup.md) | Operators — IAS migration configuration steps |
| [docs/ims-api-reference.md](docs/ims-api-reference.md) | Migration — legacy IMS Java API surface for parity reference |
| [docs/ims-uncovered-features.md](docs/ims-uncovered-features.md) | Migration — IMS features not yet ported to CAP |
| [docs/hugo-migration.md](docs/hugo-migration.md) | History — VitePress → Hugo migration rationale |
| [docs/mta-deployment.md](docs/mta-deployment.md) | Operators — MTA build/deploy procedures and troubleshooting |
| [docs/joule-chat.md](docs/joule-chat.md) | Engineers — Joule chat integration |
| [docs/ai-consumption.md](docs/ai-consumption.md) | Engineers — AI consumption surfaces |

## License

SAP Internal — Not for redistribution.

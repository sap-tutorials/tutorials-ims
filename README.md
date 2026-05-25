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
npm run dev               # Hugo dev server (separate terminal)
npm run build:all         # Full production build
```

For full setup including hybrid HANA development, environment variables, and the script reference, see [docs/developers/getting-started.md](docs/developers/getting-started.md).

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

Deploy-time variables for the MTA modules (CF env, role collections, secrets) are documented in [.deploy/DEPLOY.md](.deploy/DEPLOY.md). The five most commonly set during local dev:

| Variable | Required | Description |
|----------|----------|-------------|
| `CAP_BASE_URL` | No (default `http://localhost:4004`) | CAP srv URL — used by the build pipeline, `publish-content`, and migration scripts |
| `GITHUB_TOKEN` | No | Avoids GitHub API rate limits when fetching tutorial markdown + commit metadata |
| `CONTENT_API_KEY` | Yes (publish + srv) | Bearer token for `POST /content/publish` and `/content/rollback`; required on the srv to accept publish writes |
| `SUBMISSION_SALT_SECRET` | Yes (feedback) | IP-hash salt for `/feedback/submit`; bridge returns 503 if missing |
| `IMS_AUTH_TOKEN` | Yes (migrate) | Bearer token for the legacy Java IMS API during cutover |

For the full list, see [docs/developers/getting-started.md#environment-variables](docs/developers/getting-started.md#environment-variables).

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

See [docs/developers/reference/design-decisions.md](docs/developers/reference/design-decisions.md) for full details.

## Documentation

The full documentation set lives in [docs/](docs/) and is organized by persona:

- [End Users](docs/end-users/README.md) — finding tutorials, using Joule chat, progress and prizes
- [Authors](docs/authors/README.md) — writing tutorials, owning a repo group, running an event center
- [Developers](docs/developers/README.md) — architecture, operations, reference (you're probably here)
- [Historic](docs/historic/README.md) — AEM, IMS, completed migrations

Start at [docs/README.md](docs/README.md) for the full index.

## License

SAP Internal — Not for redistribution.

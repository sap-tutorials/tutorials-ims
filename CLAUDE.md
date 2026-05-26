# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A tutorial hosting platform that replaces Adobe Experience Manager (AEM) as the frontend for developers.sap.com. Fetches tutorial markdown from the `sap-tutorials` GitHub organization at build time, parses it into Hugo static pages styled with SAP Fundamental Styles (Horizon theme), and deploys behind an AppRouter on SAP BTP Cloud Foundry with XSUAA authentication. Backed by a CAP Node.js service with SAP HANA Cloud for progress tracking (IMS rewrite) and tutorial content persistence (HTML stored as compressed BLOBs in HANA, served dynamically via CAP). AEM has been fully decommissioned.

## Commands

Full script list: `jq '.scripts' package.json`. Operationally important commands:

```bash
# Quick start
npm install && npm run fetch-tutorials && npm run dev

# Frontend / build
npm run fetch-tutorials      # Required before dev/build (caches in .tutorial-cache/)
npm run dev                  # Hugo dev server (http://localhost:1313)
npm run build:all            # Full production build (fetch + CSS + apps + Hugo + display)

# CAP backend
cds watch                    # Local CAP (http://localhost:4004), in-memory SQLite
npm run dev:hybrid           # CAP + approuter against real HANA (parallel)
npm run start:approuter      # Standalone approuter (port 5000)
npm run bind:setup           # First-time hybrid env binding setup
npm run setup-dev-data       # Populate slugs + clean autotest data (requires cds bind)

# Tests
npm test                     # Unit (in-memory SQLite, fast)
npm run test:hybrid          # Hybrid (real HANA via cds bind --exec; requires cf login)
npm run test:smoke           # Smoke (HTTP against deployed; set SMOKE_BASE_URL/SMOKE_SRV_URL)

# Migration (cutover from Java IMS)
npm run migrate:reference    # Reference data export/import
npm run migrate:users        # User progress export/import (resumable)
npm run migrate:hana         # Direct HANA-to-HANA
node scripts/migrate-reference-data.js populate-slugs  # Patch slug fields

# Content publishing (Hugo HTML → HANA BLOBs)
npm run publish-content -- --force      # Skip delta detection (use this — see Gotchas)
npm run publish-content -- --dry-run    # Preview without uploading

# QA channel (author preview)
npm run fetch-tutorials:qa     # fetch from -Contribution repos only (cache: .tutorial-cache-qa/)
npm run build:qa               # Hugo build with QA flag, post-build verify
npm run publish-content:qa     # always force-publishes to QA srv
npm run qa:full                # full QA pipeline end-to-end
```

Tutorials must be fetched before `dev` or `build`. Fetched markdown is cached in `.tutorial-cache/` and generated pages go to `hugo/content/tutorials/` — both are gitignored. To force re-fetch from GitHub, delete `.tutorial-cache/`.

### DEV Database Setup (Slug Population)

After a fresh DB deploy or when slugs are missing (missions/groups show numeric IDs instead of text slugs in `/build/catalog`), run:

```bash
# 1. Ensure you're logged into CF DEV space
cf login

# 2. Run the setup script against HANA (deletes autotest junk + assigns slugs)
npx cds bind --exec -- node scripts/setup-dev-data.cjs

# 3. Verify: /build/catalog should return text slugs like "abap-dev-get-started"
curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/catalog | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.missions.slice(0,3).map(m=>m.slug))"
```

The script uses `.migration-data/slug-mapping.json` (87 missions, 66 groups) extracted from ContentFiles. It assigns slugs sequentially to records that don't already have one — the specific legacyId doesn't matter since content serving only requires the slug to exist.

Flags: `--skip-cleanup` (skip autotest deletion), `--skip-slugs` (skip slug assignment), `--dry-run` (preview only).

### Content Publishing

After Hugo builds, publish tutorial HTML to HANA:

```bash
# Set the API key (actual DEV key below — must match CONTENT_API_KEY env var on tutorials-srv)
export CONTENT_API_KEY="tutorials-content-publish-2024"

# Publish to deployed CAP (delta-aware — only changed files uploaded)
CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" npm run publish-content

# Or publish to local CAP
npm run publish-content
```

If CONTENT_API_KEY is not set on the deployed srv app:

```bash
cf set-env tutorials-srv CONTENT_API_KEY "tutorials-content-publish-2024"
cf restart tutorials-srv
```

## Architecture

### Build Pipeline

```text
sap-tutorials GitHub repos
  → scripts/fetch-tutorials.ts --target hugo (fetch + cache raw markdown)
    → scripts/parsers/ (parse frontmatter, steps, images, options)
      → hugo/content/tutorials/*.md (generated Hugo pages with YAML frontmatter)
        → Hugo build → hugo/public/tutorials/*/index.html
          → scripts/publish-content.ts (delta publish to HANA via /content/publish)

CAP backend (http://localhost:4004 or CAP_BASE_URL)
  → GET /build/catalog (unauthenticated)
    → missions + completion paths + tutorial ordering
      → hugo/content/missions/*.md and hugo/content/groups/*.md
```

Tutorial HTML is NOT served from static files. After Hugo builds, `publish-content.ts` computes SHA-256 hashes, compares with the remote `/content/hashes` endpoint, and uploads only changed slugs as gzip-compressed BLOBs to HANA via `POST /content/publish`. The AppRouter routes `/tutorials/*` to the CAP content-serve endpoint.

### CAP Backend (srv/)

- **Services**: `DeveloperService` (@path: /api), `AdminService` (@path: /admin), `AnalyticsService` (@path: /admin/analytics), `ExportsService` (@path: /admin/exports), `DisplayService` (@path: /display), `ConsolidationService` (@path: /api/v1), `ScannerService` (@path: /scanner), `SearchService` (@path: /search), `ChatService` (@path: /chat, no entities; ORD-symmetric, streams via `/chat/stream`), `EventStreamService` (@path: event-stream, WebSocket+REST)
- **Custom endpoints** (canonical list with auth + scope in [docs/developers/operations/testing-endpoints.md](docs/developers/operations/testing-endpoints.md)): `/api/qrcode`, `/api/recommendations`, `/build/catalog`, `/build/navigator`, `/build/slug-mapping`, `/build/co-completions`, `/build/repo-catalog` (GET unauth; POST bearer via `CONTENT_API_KEY`), `/feedback/submit` (rate-limited; `SUBMISSION_SALT_SECRET` required), `/chat/stream` (SSE), `/admin/embeddings/stats`, `/health`, `/health/db`, `/auth/user`
- **Content persistence** (`srv/lib/content-store.js`): Tutorial HTML stored as gzip-compressed BLOBs in HANA (`ContentFiles` + `ContentManifest` entities). Endpoints:
  - `POST /content/publish` — accepts `{ trigger, hugoVersion, files: { slug: base64gzip } }`, creates versioned manifest (bearer token auth via `CONTENT_API_KEY`)
  - `GET /content/tutorials/:slug` — serves decompressed HTML with ETag, Cache-Control, bounded LRU cache (50MB)
  - `GET /content/hashes` — returns `{ slug: sha256 }` map of active content (used by delta publish)
  - `GET /content/nav` — navigation metadata for all published tutorials
  - `POST /content/rollback` — reverts to previous manifest version (bearer token auth)
- **WebSocket**: Socket.IO transport via `@cap-js-community/websocket` plugin (`"websocket": { "kind": "socket.io" }` in package.json). `DisplayService` (`@protocol: ['odata', 'websocket']`, scope `DisplayApp`) and `EventStreamService` (`@protocol: ['websocket', 'rest']`, anonymous) emit CDS events as Socket.IO messages on the `/ws/display` and `/ws/event-stream` namespaces. Approuter routes `^/socket\.io/` and `^/ws/` are `authenticationType: 'none'`; scope check happens at namespace join.
- **Jobs**: Scheduled tasks in `srv/jobs/` — scheduler.js orchestrates: account-merge-job, analytics, cleanup (including content GC), ngds-retry (with job-lock.js for distributed locking)
- **Bootstrap**: `srv/server.js` registers custom express routes on `cds.on('bootstrap')`, attaches jobs on `cds.on('served')` (the WebSocket plugin mounts itself on `served` independently)
- **Audit Logging**: `@cap-js/audit-logging` with `@PersonalData` annotations on Users/UserMetaData/TaskRecords (see `db/audit-logging.cds`). SecurityEvent emitted on user anonymization.
- **Change Tracking**: `@cap-js/change-tracking` on admin-managed entities (Events, Missions, Groups, Accomplishments, Prizes, ImsConfig, FeaturedTasks). See `db/change-tracking.cds`.
- **ORD**: `srv/ord-annotations.cds` registers all services for Open Resource Discovery.
- **Analytics ad-hoc queries** (`srv/analytics-service.js`): `AnalyticsService` exposes a curated subset of CDS views/entities marked with `@analytics.exposed` plus a `runSelectQuery(sql)` action. Queries are parsed via `srv/lib/analytics-sql-validator.cjs` (SELECT-only, allowlisted tables, no DDL/DML/multi-statement) and wrapped with `LIMIT 5001` to cap result size.

### Scanner (app/scanner/)

- **`app/scanner/webapp/`** — UI5 barcode scanner app using `sap.ndc.BarcodeScanner` for device camera scanning. Looks up contestant by account number (encoded in QR code), displays progress stats, and allows prize claiming.
- **ScannerService** (`srv/scanner-service.cds` + `.js`) — Two OData functions: `getContestant(accountNumber)` returns completion stats + prize text; `claimPrize(recordId)` marks a PrizeRecord as CLAIMED. Queries local DB directly (no HTTP destination needed).
- **Production access**: `/scanner-ui/` (XSUAA-protected via xs-app.json route)
- **Local dev access**: `/scanner-ui/` — served by `adminAppsHandler` middleware in `approuter/server.js`

### Admin UI (app/)

- **`app/admin-shell/`** — Unified admin shell using `sap.tnt.ToolPage` with collapsible side navigation, theme switching (light/dark/auto), and Router-managed content area. Includes custom views: Board (event overview), Statistics (mission completions export), TutorialDashboard, and Privacy policy.
- **`app/admin/`** — 10 Fiori Elements apps (events, missions, groups, accomplishments, prizes, tutorials, tags, operations, accounts, changelog) — loaded as headless components by the shell via `componentUsages`
- **`app/admin-annotations.cds`** — All @UI/@Common CDS annotations for admin screens
- Deployed as static files inside the approuter (`cp -r ../app/admin-shell/dist/. static/admin-ui/` in `.deploy/mta.yaml`)
- **Production access**: `/admin-ui/` route (XSUAA-protected, served from approuter `static/admin-ui/`)
- **Local dev access**: `/admin-ui/` — served by `adminAppsHandler` middleware in `approuter/server.js`; component sub-resources at `/admin-ui/components/<name>/`
- **Theme**: `sap_horizon` (light) / `sap_horizon_dark` (dark), auto-detects OS preference, persisted to `localStorage` key `sap-tutorials-admin-theme`

### Analytics Explorer (app/analytics-explorer/)

- **`app/analytics-explorer/`** — Vue 3 SPA bundled with Vite, peer of admin-shell. Ad-hoc analytics UI over `AnalyticsService` with an entity browser tab and a SQL tab (Monaco lazy-loaded).
- Built via `npm run build:analytics-explorer` and copied into the approuter at `static/analytics-ui/` (see `.deploy/mta.yaml`).
- **Production access**: `/analytics-ui/` (XSUAA-protected via xs-app.json route)

### Frontend (Hugo + Vue 3)

- **Hugo site** (`hugo/`): Static site generator. Layouts in `hugo/layouts/`, content generated into `hugo/content/tutorials/`. Styled with SAP Fundamental Styles (PostCSS pipeline). Config in `hugo/hugo.toml`.
- **Vue apps** (`hugo-apps/`): Public-facing Vue 3 components bundled by Vite, including `AppSpace.vue` (event-themed tutorial space with Joule/Sapphire themes). Fetches progress from `/api/getEventProgress`, displays QR codes via `/api/qrcode`.
- **Display dashboard** (`app/display-app/`): Standalone Vue+Vite app for event monitors — real-time dashboard with rotating views (Board, Statistics, Leaderboard). Connects via Socket.IO on the `/ws/display` namespace.

### Deployment (BTP Cloud Foundry)

Single MTA deployment (`mta.yaml`): AppRouter module serves Hugo static build from `approuter/static/` (excluding tutorials — those are served from HANA). XSUAA provides SAP IDP authentication. Routes in `approuter/xs-app.json` proxy to CAP backend via BTP Destination. The `/tutorials/*` route rewrites to `/content/tutorials/$1` on the CAP srv, which decompresses and serves HTML from HANA BLOBs. Tutorials are explicitly removed from the AppRouter static directory during build (`rm -rf approuter/static/tutorials`).

### Data Migration

Migration scripts in `scripts/` support parallel operation during cutover:
- `migrate-reference-data.js` — export/import tutorials, missions, events, tags; `populate-slugs` mode patches slug fields from CAP catalog cache
- `migrate-user-progress.js` — export/import users and task records (paged, resumable)
- `compare-systems.js` — endpoint-by-endpoint diff between Java IMS and CAP

Set `IMS_BASE_URL`, `CAP_BASE_URL`, and `IMS_AUTH_TOKEN` env vars. Export files go to `.migration-data/` (gitignored).

### CI/CD (.github/workflows/)

- **`deploy.yml`** — Full MTA build + deploy to BTP Cloud Foundry, followed by smoke tests
- **`rebuild-content.yml`** — Re-fetches tutorials, rebuilds Hugo, and publishes content to HANA (triggered manually or on tutorial source changes). Authors can force-refresh a single tutorial by running the workflow with the optional `slug` input filled in — the fetch step honors `TUTORIAL_SLUG` env var, busts that slug's markdown cache, regenerates the rest from cache, and skips the HANA `RepoCatalog` upload so the partial run doesn't overwrite the catalog. Leave `slug` blank for a full rebuild.

### Documentation (docs/)

Architecture and reference docs for developers (not deployed). Organized by persona:

- [docs/README.md](docs/README.md) — persona index, start here
- [docs/end-users/README.md](docs/end-users/README.md) — for tutorial consumers
- [docs/authors/README.md](docs/authors/README.md) — for tutorial authors and event operators
- [docs/developers/README.md](docs/developers/README.md) — for platform engineers (you)
- [docs/historic/README.md](docs/historic/README.md) — AEM, IMS, completed migrations

The same persona docs are published as a public VitePress site at <https://sap-tutorials.github.io/tutorials-poc/>. Build commands:

- `npm run docs:dev` — local preview at <http://localhost:5173/tutorials-poc/>
- `npm run docs:build` — production build (runs sidebar guard + font copy first)
- `npm run docs:preview` — preview the built site

Sidebar maintenance: `docs/.vitepress/config.ts` `themeConfig.sidebar`. The `predocs:build` check rejects unregistered pages or dead links.

Most-referenced developer docs:

- [docs/developers/getting-started.md](docs/developers/getting-started.md) — local dev setup
- [docs/developers/operations/testing-endpoints.md](docs/developers/operations/testing-endpoints.md) — UI + API endpoint reference
- [docs/developers/operations/qa-channel-bootstrap.md](docs/developers/operations/qa-channel-bootstrap.md) — QA author-preview setup
- [docs/developers/architecture/build.md](docs/developers/architecture/build.md) — content pipeline
- [docs/developers/architecture/authentication.md](docs/developers/architecture/authentication.md) — auth flow
- [docs/developers/operations/mta-deployment.md](docs/developers/operations/mta-deployment.md) — deploy runbook
- [docs/developers/reference/theme-variants.md](docs/developers/reference/theme-variants.md) — building event themes

### Parsers (scripts/parsers/)

The fetch script (`--target hugo`) detects parser format via frontmatter field `parser: v2`. V2 uses H3 headings to delimit steps; V1 (legacy) uses `[ACCORDION-BEGIN]`/`[ACCORDION-END]` markers. `images.ts` resolves relative image paths to `raw.githubusercontent.com` CDN URLs. `options.ts` converts `[OPTION BEGIN]`/`[OPTION END]` blocks to Hugo shortcodes. `sanitize-html.ts` cleans unsafe HTML from tutorial source. `hugo-delimiters.ts` handles Hugo-specific delimiter escaping. `cap.ts` fetches mission/group catalog from the CAP backend at build time. Shared types in `types.ts`.

### Testing

Three Vitest workspaces defined in `vitest.config.ts` (inline `projects` array):

- **unit** — In-memory SQLite, fast, no external dependencies. Runs with `npm test`.
- **hybrid** — Real HANA Cloud via `cds bind --exec`. Runs with `npm run test:hybrid` (requires `cf login` to DEV space). Files in `test/hybrid/` cover schema deploy, HANA sequences, views, the developer workflow, admin CRUD, and search. A write-safety guard (`test/hybrid/_guard.js`) checks `ALLOW_HYBRID_WRITES=true` before any INSERT/UPDATE/DELETE; tests prefix data with `__TEST__` and clean up in `afterAll`.
- **smoke** — HTTP-based tests against deployed URLs. Runs with `npm run test:smoke`. Set `SMOKE_BASE_URL` (approuter) and `SMOKE_SRV_URL` (srv) env vars. Files in `test/smoke/` cover health, public endpoints, auth enforcement, OData metadata, static content, content serve, search, and the WebSocket handshake. Runs automatically after deploy in CI.

## QA Channel Bootstrap

One-time setup for the QA author-preview channel — full procedure (CI secrets, dispatch-token distribution to every `-Contribution` repo, local deploy with both prod and QA Hugo built, sanity check, role-collection assignment) lives in [docs/developers/operations/qa-channel-bootstrap.md](docs/developers/operations/qa-channel-bootstrap.md). Day-to-day QA commands are in the Commands section above; channel-specific gotchas (`.tutorial-cache-qa/` marker, `hugo.qa.toml`, `CONTENT_API_KEY_QA`) are in Gotchas below.

## Gotchas

- **`hugo/content/tutorials/` is entirely generated** — never edit these files directly. They are overwritten by `npm run fetch-tutorials`. Edit the parsers in `scripts/parsers/` or the source tutorials in the `sap-tutorials` GitHub org instead.
- **POC tutorial list is hardcoded** — Tutorials are dynamically discovered from the `sap-tutorials` GitHub org via `discoverAllTutorials()` in `scripts/parsers/github.ts`. Repos in `EXCLUDED_REPOS` (tutorials-ims, meta-tutorials) are skipped. Discovery results are cached in `.tutorial-cache/discovery-map.json`. Use `npm run discover-repos` to list available repos without fetching.
- **Validation quiz data from `-Contribution` repos** — `fetchRulesVr()` in `scripts/parsers/github.ts` fetches `rules.vr` files from private `-Contribution` repos (e.g., `abap-core-development-Contribution`). Requires `GITHUB_TOKEN`. Cached in `.tutorial-cache/<slug>.rules.vr`. Parsed by `scripts/parsers/rules.ts` and injected into Hugo frontmatter steps.
- **`GITHUB_TOKEN` env var** — `scripts/parsers/github.ts` optionally uses this to avoid GitHub API rate limits when fetching commit metadata. Without it, unauthenticated requests may hit rate limits on repeated builds.
- **`CAP_BASE_URL` env var** — Used by `scripts/parsers/cap.ts` and migration scripts. Defaults to `http://localhost:4004`. Set to the deployed CAP srv URL for production builds.
- **Cache clearing** — `.tutorial-cache/` caches raw markdown, GitHub metadata, and CAP catalog data. Delete it to force a full re-fetch. There is no incremental invalidation.
- **Node.js >= 20 required** — Build scripts use native `fetch` (no polyfill).
- **Slug fields** — `Missions.slug` and `CompletionPaths.slug` must be populated for the build pipeline to generate mission/group pages. Run `node scripts/migrate-reference-data.js populate-slugs` after data import.
- **`app/` vs `hugo-apps/`** — Two separate directories. `app/` contains standalone UI applications (each with its own build): `admin-shell/`, `admin/` (11 Fiori Elements components loaded by the shell), `analytics-explorer/` (Vue 3 SPA), `scanner/` (UI5), and `display-app/` (Vue 3 event-monitor dashboard). Builds from `app/*` deploy by copying their `dist/`/`webapp/` into `approuter/static/<route>/`. `hugo-apps/` is a single Vite project that compiles 9 Vue 3 page-level islands (navigator, app-space, event-display, nav-dropdown, scanner-vue, tutorial-feedback, tutorial-rating, cmd-palette, me) into `hugo/static/js/` — these are loaded by Hugo templates as `<script>` tags, not deployed as routes. See [mta.yaml](mta.yaml) for the build sequence.
- **`/admin/` is OData only** — The AdminService OData endpoint lives at `/admin/`. The admin shell UI is served at `/admin-ui/` to avoid path collisions.
- **Hugo vs VitePress** — The project migrated from VitePress to Hugo. The `site/.vitepress/` directory still exists (with a built `dist/`) but is legacy. Active frontend work targets `hugo/`.
- **`CONTENT_API_KEY` env var** — Required for `POST /content/publish` and `POST /content/rollback`. Set in CI secrets and locally when testing publish. Without it, publish requests return 401.
- **`SUBMISSION_SALT_SECRET` env var** — Required by `srv/lib/feedback-salt.js` for hashing submitter IPs on `POST /feedback/submit`. The Express bridge returns 503 if missing. Set in CI secrets and locally when testing the feedback form. Rotation invalidates in-memory rate-limit keys (acceptable).
- **Tutorials are DB-only** — Tutorial HTML is served exclusively from HANA BLOBs. There is no static file fallback. If no content has been published to HANA, `/tutorials/*` returns 404.
- **Content garbage collection** — A daily cron job (03:00) prunes `SUPERSEDED`/`ROLLED_BACK` content versions older than 7 days, keeping the 3 most recent for rollback. Never touches `ACTIVE` or `PUBLISHING` manifests.
- **`publish-content.ts` delta detection** — The script fetches `/content/hashes` to compute which slugs changed. Use `--force` to bypass delta detection and republish everything. Use `--dry-run` to preview changes without uploading.
- **QA channel content** — `/tutorials-qa/*` is gated by XSUAA scope `Tutorial.Author`. Content sourced only from `*-Contribution` repos via `ONLY_CONTRIBUTION_REPOS=true`. Lives in `tutorials-db-qa` HDI; never queries prod tables.
- **`.tutorial-cache-qa/` vs `.tutorial-cache/`** — separate caches per channel. Running `fetch-tutorials` for a different channel writes a `.channel` marker; `dev` warns if the cache content channel doesn't match.
- **`CONTENT_API_KEY_QA` env var** — required for `POST /content/publish` and `/content/rollback` on QA srv.
- **`hugo.qa.toml`** — sibling Hugo config for QA. Strips Joule FAB, rating, completion buttons, progress UI when `site.Params.qa = true`.
- **HANA LOB locator expiry** — CDS QL returns HANA BLOBs as `Readable` streams with locators that expire before consumption when mixed with non-BLOB columns. `srv/lib/content-store.js` works around this by using raw SQL (`db.run()`) for BLOB retrieval on HANA, and CDS QL for SQLite (unit tests). Never SELECT a BLOB column alongside metadata in a single CDS QL query on HANA.
- **Tutorial embeddings live in `TutorialEmbedding` and are HANA-only at query time** — SQLite test path uses JS-side cosine. Never SELECT the `embedding` BLOB alongside metadata in a single CDS QL query on HANA (LOB locator expiry); use `db.run()` raw SQL in `srv/lib/embedding-query.js`.
- **`ChatSettings.ragEnabled`** — feature flag for the `getRelevantSteps` tool. When toggling on for the first time, click "Seed Embeddings Now" in the Joule Chat Settings tile to populate. Reconciliation cron at minute 17 of every hour catches any drift.

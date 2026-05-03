# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A tutorial hosting platform that replaces Adobe Experience Manager (AEM) as the frontend for developers.sap.com. Fetches tutorial markdown from the `sap-tutorials` GitHub organization at build time, parses it into Hugo static pages styled with SAP Fundamental Styles (Horizon theme), and deploys behind an AppRouter on SAP BTP Cloud Foundry with XSUAA authentication. Backed by a CAP Node.js service with SAP HANA Cloud for progress tracking (IMS rewrite) and tutorial content persistence (HTML stored as compressed BLOBs in HANA, served dynamically via CAP). AEM has been fully decommissioned.

## Commands

```bash
# Quick start
npm install && npm run fetch-tutorials && npm run dev

npm install                                   # Install dependencies
npm run fetch-tutorials                       # Fetch tutorial markdown from GitHub (required before dev/build)
npm run dev                                   # Hugo dev server (http://localhost:1313)
npm run build:all                             # Full production build (fetch + CSS + apps + Hugo + highlight + display)
npm run build:hugo                            # Hugo static build only
npm run build:css                             # PostCSS → hugo/static/css/sap-fundamental.css
npm run build:apps                            # Vue 3 public-facing apps (apps/)
npm run build:display                         # Display dashboard app (display-app/)
npm run build:admin                           # Fiori Elements admin apps (app/admin + app/admin-custom)
npm run generate-dark-theme                   # Generate dark theme CSS variables
npm run validate-tutorials                    # Validate fetched tutorial structure
npm run discover-repos                        # List available tutorial repos without fetching
npm run test                                  # Run unit tests (vitest, in-memory SQLite)
npm run test:watch                            # Run tests in watch mode
npm run test:hybrid                           # Run hybrid integration tests against real HANA (requires cf login)
npm run test:smoke                            # Run smoke tests against a deployed URL (set SMOKE_BASE_URL)
npm run test:all                              # Run all test workspaces (requires cds bind)
npx vitest run scripts/__tests__/v1.test.ts   # Run a single test file

# CAP backend
cds watch                                     # Start CAP server (http://localhost:4004)
npm run dev:hybrid                            # CAP with HANA binding + approuter (parallel)

# Migration & Comparison
npm run migrate:reference                     # Export reference data from Java IMS (or import to CAP)
npm run migrate:users                         # Export user progress from Java IMS (with resume support)
npm run migrate:hana                          # Direct HANA-to-HANA migration
npm run compare                               # Compare Java IMS and CAP responses side-by-side
node scripts/migrate-reference-data.js populate-slugs  # Patch slug fields from CAP catalog cache

# Content publishing
npm run publish-content                       # Publish Hugo tutorial HTML to HANA (delta-aware)
npm run publish-content -- --dry-run          # Show what would change without publishing
npm run publish-content -- --force            # Skip delta detection, publish all files
npm run publish-content -- --verbose          # Extra logging
```

Tutorials must be fetched before `dev` or `build`. Fetched markdown is cached in `.tutorial-cache/` and generated pages go to `hugo/content/tutorials/` — both are gitignored. To force re-fetch from GitHub, delete `.tutorial-cache/`.

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

- **Services**: `DeveloperService` (@path: /api), `AdminService` (@path: /admin), `DisplayService` (@path: /display), `ConsolidationService` (@path: /api/v1)
- **Custom endpoints**: `/api/qrcode` (QR code PNG generation), `/build/catalog` (unauthenticated mission/group data for build pipeline)
- **Content persistence** (`srv/lib/content-store.js`): Tutorial HTML stored as gzip-compressed BLOBs in HANA (`ContentFiles` + `ContentManifest` entities). Endpoints:
  - `POST /content/publish` — accepts `{ trigger, hugoVersion, files: { slug: base64gzip } }`, creates versioned manifest (bearer token auth via `CONTENT_API_KEY`)
  - `GET /content/tutorials/:slug` — serves decompressed HTML with ETag, Cache-Control, bounded LRU cache (50MB)
  - `GET /content/hashes` — returns `{ slug: sha256 }` map of active content (used by delta publish)
  - `GET /content/nav` — navigation metadata for all published tutorials
  - `POST /content/rollback` — reverts to previous manifest version (bearer token auth)
- **WebSocket**: STOMP broker at `/display/websocket` for real-time event dashboard updates
- **Jobs**: Scheduled tasks in `srv/jobs/` — scheduler.js orchestrates: account-merge-job, analytics, cleanup (including content GC), ngds-retry (with job-lock.js for distributed locking)
- **Bootstrap**: `srv/server.js` registers custom express routes on `cds.on('bootstrap')`, attaches STOMP broker and jobs on `cds.on('served')`
- **Audit Logging**: `@cap-js/audit-logging` with `@PersonalData` annotations on Users/UserMetaData/TaskRecords (see `db/audit-logging.cds`). SecurityEvent emitted on user anonymization.
- **Change Tracking**: `@cap-js/change-tracking` on admin-managed entities (Events, Missions, Groups, Accomplishments, Prizes, ImsConfig, FeaturedTasks). See `db/change-tracking.cds`.

### Admin UI (app/)

- **`app/admin-shell/`** — Unified admin shell using `sap.tnt.ToolPage` with collapsible side navigation, theme switching (light/dark/auto), and Router-managed content area
- **`app/admin/`** — 10 Fiori Elements apps (events, missions, groups, accomplishments, prizes, tutorials, tags, operations, accounts, changelog) — loaded as headless components by the shell via `componentUsages`
- **`app/admin-annotations.cds`** — All @UI/@Common CDS annotations for admin screens
- Deployed via HTML5 Application Repository (`tutorials-admin-ui-deployer` module in mta.yaml)
- **Production access**: `/admin-ui/` route (XSUAA-protected, served from HTML5 App Repository)
- **Local dev access**: `/admin-ui/` — served by `adminAppsHandler` middleware in `approuter/server.js`; component sub-resources at `/admin-ui/components/<name>/`
- **Theme**: `sap_horizon` (light) / `sap_horizon_dark` (dark), auto-detects OS preference, persisted to `localStorage` key `sap-tutorials-admin-theme`

### Frontend (Hugo + Vue 3)

- **Hugo site** (`hugo/`): Static site generator. Layouts in `hugo/layouts/`, content generated into `hugo/content/tutorials/`. Styled with SAP Fundamental Styles (PostCSS pipeline). Config in `hugo/hugo.toml`.
- **Vue apps** (`apps/`): Public-facing Vue 3 components bundled by Vite, including `AppSpace.vue` (event-themed tutorial space with Joule/Sapphire themes). Fetches progress from `/api/getEventProgress`, displays QR codes via `/api/qrcode`.
- **Display dashboard** (`display-app/`): Standalone Vue+Vite app for event monitors — real-time dashboard with rotating views (Board, Statistics, Leaderboard). Connects via STOMP WebSocket.

### Deployment (BTP Cloud Foundry)

Single MTA deployment (`mta.yaml`): AppRouter module serves Hugo static build from `approuter/static/` (excluding tutorials — those are served from HANA). XSUAA provides SAP IDP authentication. Routes in `approuter/xs-app.json` proxy to CAP backend via BTP Destination. The `/tutorials/*` route rewrites to `/content/tutorials/$1` on the CAP srv, which decompresses and serves HTML from HANA BLOBs. Tutorials are explicitly removed from the AppRouter static directory during build (`rm -rf approuter/static/tutorials`).

### Data Migration

Migration scripts in `scripts/` support parallel operation during cutover:
- `migrate-reference-data.js` — export/import tutorials, missions, events, tags; `populate-slugs` mode patches slug fields from CAP catalog cache
- `migrate-user-progress.js` — export/import users and task records (paged, resumable)
- `compare-systems.js` — endpoint-by-endpoint diff between Java IMS and CAP

Set `IMS_BASE_URL`, `CAP_BASE_URL`, and `IMS_AUTH_TOKEN` env vars. Export files go to `.migration-data/` (gitignored).

### Parsers (scripts/parsers/)

The fetch script (`--target hugo`) detects parser format via frontmatter field `parser: v2`. V2 uses H3 headings to delimit steps; V1 (legacy) uses `[ACCORDION-BEGIN]`/`[ACCORDION-END]` markers. `images.ts` resolves relative image paths to `raw.githubusercontent.com` CDN URLs. `options.ts` converts `[OPTION BEGIN]`/`[OPTION END]` blocks to Hugo shortcodes. `cap.ts` fetches mission/group catalog from the CAP backend at build time. Shared types in `types.ts`.

### Testing

Three Vitest workspaces defined in `vitest.workspace.ts`:

- **unit** — In-memory SQLite, fast, no external dependencies. Runs with `npm test`.
- **hybrid** — Real HANA Cloud via `cds bind --exec`. Runs with `npm run test:hybrid` (requires `cf login` to DEV space).
- **smoke** — HTTP-based tests against deployed URLs. Runs with `npm run test:smoke`. Set `SMOKE_BASE_URL` (approuter) and `SMOKE_SRV_URL` (srv) env vars. Runs automatically after deploy in CI.

Hybrid test files in `test/hybrid/`:

| File | Coverage |
| ---- | -------- |
| `schema-deploy.test.js` | All 35 entities accessible, column structure validation |
| `hana-sequences.test.js` | Legacy ID generation from 27 `.hdbsequence` files |
| `views.test.js` | Tasks UNION view and NavigatorCatalog view |
| `developer-workflow.test.js` | Task record creation, progress cascade, idempotent inserts |
| `admin-crud.test.js` | CRUD on Events, Tags, ImsConfig; read validation on Tutorials/Missions |

A write-safety guard (`test/hybrid/_guard.js`) checks `ALLOW_HYBRID_WRITES=true` before any INSERT/UPDATE/DELETE tests run. Tests that create data use a `__TEST__` prefix and clean up in `afterAll`.

Smoke test files in `test/smoke/`:

| File | Coverage |
| ---- | -------- |
| `health.test.js` | `/health` alive check, `/health/db` HANA connectivity |
| `public-endpoints.test.js` | `/build/catalog` and `/build/navigator` respond with JSON |
| `auth-enforcement.test.js` | Protected endpoints reject unauthenticated requests |
| `odata-metadata.test.js` | DeveloperService and AdminService `$metadata` return EDMX |
| `static-content.test.js` | Root serves HTML, security headers present via approuter |
| `content-serve.test.js` | Tutorial serving via AppRouter → CAP → HANA (ETag, 304, 404) |

## Gotchas

- **`hugo/content/tutorials/` is entirely generated** — never edit these files directly. They are overwritten by `npm run fetch-tutorials`. Edit the parsers in `scripts/parsers/` or the source tutorials in the `sap-tutorials` GitHub org instead.
- **POC tutorial list is hardcoded** — The 5 tutorials are defined in the `POC_TUTORIALS` array at the top of `scripts/fetch-tutorials.ts`. Adding tutorials means editing that array.
- **Validation quiz data is hardcoded** — The `VALIDATION_DATA` object in `scripts/fetch-tutorials.ts` contains step quiz questions, not the CAP backend. This is a POC shortcut.
- **`GITHUB_TOKEN` env var** — `scripts/parsers/github.ts` optionally uses this to avoid GitHub API rate limits when fetching commit metadata. Without it, unauthenticated requests may hit rate limits on repeated builds.
- **`CAP_BASE_URL` env var** — Used by `scripts/parsers/cap.ts` and migration scripts. Defaults to `http://localhost:4004`. Set to the deployed CAP srv URL for production builds.
- **Cache clearing** — `.tutorial-cache/` caches raw markdown, GitHub metadata, and CAP catalog data. Delete it to force a full re-fetch. There is no incremental invalidation.
- **Node.js >= 20 required** — Build scripts use native `fetch` (no polyfill).
- **Slug fields** — `Missions.slug` and `CompletionPaths.slug` must be populated for the build pipeline to generate mission/group pages. Run `node scripts/migrate-reference-data.js populate-slugs` after data import.
- **`app/` vs `apps/` vs `display-app/`** — Three separate directories. `app/` contains SAPUI5 admin apps: `app/admin-shell/` is the unified shell (sap.tnt.ToolPage with side navigation) and `app/admin/` holds 10 Fiori Elements feature components loaded by the shell. In production, deployed via HTML5 App Repository at `/admin-ui/`; locally, the approuter's `adminAppsHandler` middleware mounts them at `/admin-ui/`. `apps/` contains Vue 3 public-facing components bundled by Vite. `display-app/` is a standalone Vue+Vite dashboard app for event monitors. Do not mix them.
- **`/admin/` is OData only** — The AdminService OData endpoint lives at `/admin/`. The admin shell UI is served at `/admin-ui/` to avoid path collisions.
- **Hugo vs VitePress** — The project migrated from VitePress to Hugo. The `site/.vitepress/` directory still exists (with a built `dist/`) but is legacy. Active frontend work targets `hugo/`.
- **`CONTENT_API_KEY` env var** — Required for `POST /content/publish` and `POST /content/rollback`. Set in CI secrets and locally when testing publish. Without it, publish requests return 401.
- **Tutorials are DB-only** — Tutorial HTML is served exclusively from HANA BLOBs. There is no static file fallback. If no content has been published to HANA, `/tutorials/*` returns 404.
- **Content garbage collection** — A daily cron job (03:00) prunes `SUPERSEDED`/`ROLLED_BACK` content versions older than 7 days, keeping the 3 most recent for rollback. Never touches `ACTIVE` or `PUBLISHING` manifests.
- **`publish-content.ts` delta detection** — The script fetches `/content/hashes` to compute which slugs changed. Use `--force` to bypass delta detection and republish everything. Use `--dry-run` to preview changes without uploading.
- **HANA LOB locator expiry** — CDS QL returns HANA BLOBs as `Readable` streams with locators that expire before consumption when mixed with non-BLOB columns. `srv/lib/content-store.js` works around this by using raw SQL (`db.run()`) for BLOB retrieval on HANA, and CDS QL for SQLite (unit tests). Never SELECT a BLOB column alongside metadata in a single CDS QL query on HANA.

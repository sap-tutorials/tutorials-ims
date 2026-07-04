# CLAUDE.md

This file guides Claude Code (claude.ai/code) working in this repo.

## Project Overview

A tutorial hosting platform replacing Adobe Experience Manager (AEM) as the frontend for developers.sap.com. Fetches tutorial markdown from the `sap-tutorials` GitHub org at build time, parses it into Hugo static pages styled with SAP Fundamental Styles (Horizon theme), and deploys behind an AppRouter on SAP BTP Cloud Foundry with XSUAA auth. Backed by a CAP Node.js service with SAP HANA Cloud for progress tracking (IMS rewrite) and tutorial content persistence (HTML as gzip BLOBs, served dynamically). AEM has been fully decommissioned.

## Commands

Full script list: `jq '.scripts' package.json`. Operationally important:

```bash
# Quick start
npm install && npm run setup && npm run fetch-tutorials && npm run dev

# Frontend / build
npm run setup                # Fresh-worktree only: hugo-apps install + better-sqlite3 native rebuild
npm run fetch-tutorials      # Required before dev/build (caches in .tutorial-cache/)
npm run dev                  # Hugo dev server (http://localhost:1313)
npm run build:all            # Full production build (fetch + CSS + apps + Hugo + display)

# CAP backend
cds watch                    # Local CAP (http://localhost:4004), in-memory SQLite
npm run dev:hybrid           # CAP + approuter against real HANA (parallel)
npm run start:approuter      # Standalone approuter (port 5000)
npm run bind:setup           # First-time hybrid env binding setup
npm run setup-dev-data       # Populate slugs + clean autotest data (requires cds bind)

# Seed community events (fresh DB or first-run — Phase 4.8 #765)
node scripts/seed-community-events.cjs --commit  # via npx cds bind --exec -- ... for HANA

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
npm run publish-content                 # Default: delta + chunked, auto-verifies after commit
npm run publish-content -- --force      # Performance shortcut: skip /content/hashes round-trip
npm run publish-content -- --verify-only  # Compare local hashes to server; exit 2 on mismatch
npm run publish-content -- --heal       # Upload only slugs missing or hash-mismatched on the server
npm run publish-content -- --dry-run    # Preview without uploading

# Rebuild content workflow (one-tutorial hotfix republish — ~2 min wall-clock)
# Auto-infers mode=slug-targeted from the slug input; no -f mode= needed.
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f slug=tutorial-platform-feature-cookbook
# Multiple slugs (union with single-slug if both set):
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f slugs="foo,bar,baz"
# Full rebuild (only when dependencies/Vue/admin changed — ~10 min):
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full

# QA channel (author preview)
npm run fetch-tutorials:qa     # fetch from -Contribution repos only (cache: .tutorial-cache-qa/)
npm run build:qa               # Hugo build with QA flag, post-build verify
npm run publish-content:qa     # always force-publishes to QA srv
npm run qa:full                # full QA pipeline end-to-end
```

Tutorials must be fetched before `dev` or `build`. Fetched markdown caches in `.tutorial-cache/`, generated pages go to `hugo/content/tutorials/` — both gitignored. Delete `.tutorial-cache/` to force re-fetch.

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

> **⚠️ Workstation publishes are emergency-only.** Canonical path is `gh workflow run rebuild-content.yml`. Workstation publishes skip CI validation; the server-side no-revert guard (#672) catches the worst stale-cache regressions but not everything. Every publish records its initiator on `ContentManifest.initiator` + `PipelineLog.initiator` for attribution.

After Hugo builds, publish tutorial HTML to HANA via chunked protocol (begin → append batches → commit). Full runbook + flag reference: [content-rollback runbook](docs/developers/operations/content-rollback.md).

```bash
# API key: fetch DEV value from BTP credstore (do NOT commit)
export CONTENT_API_KEY="<DEV-content-api-key>"

# Publish to deployed CAP (default delta mode is correctness-equivalent to --force)
CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" npm run publish-content
```

CLI auto-verifies against `/content/hashes` after publish. **Exits with code 2 on hash mismatch** so CI can flag broken builds. Key flags (mutually exclusive: `--force`/`--heal`/`--verify-only`):
- `--force` — perf shortcut, skip hash round-trip and upload everything (not required for correctness).
- `--verify-only` — compare local vs server hashes, exit 0/2, no upload.
- `--heal` — upload only missing/mismatched slugs (mop up after failed publish).
- `--dry-run`, `--concurrency N` (default 6), `--batch-size N` (default 50), `--initiator <value>` (default `${user}@${hostname}`; CI passes `ci/$GITHUB_RUN_ID`).

Default targets ~90s wall-clock for full 1398-slug publish.

For deliberate rollbacks or when the no-revert guard blocks a legitimate re-publish, see the runbook. The guard rejects a slug if its incoming `sourceHash` appears in any version older than the most recent prior hash that differs — legitimate flaps (`A→B→A` where upstream IS `A`) pass; stale-cache regressions are caught.

If `CONTENT_API_KEY` is not set on the deployed srv app: `cf set-env tutorials-srv CONTENT_API_KEY "<key>"` then `cf restart tutorials-srv`.

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

- **Services**: `DeveloperService` (@path: /api), `AdminService` (@path: /admin), `AnalyticsService` (@path: /admin/analytics), `ExportsService` (@path: /admin/exports), `AuthorService` (`srv/author-service.cds`), `DisplayService` (@path: /display), `ConsolidationService` (@path: /api/v1), `ScannerService` (@path: /scanner), `SearchService` (@path: /search), `ChatService` (@path: /chat, no entities; ORD-symmetric, streams via `/chat/stream`), `EventStreamService` (@path: event-stream, WebSocket+REST)
- **Custom endpoints** (canonical list with auth + scope in [docs/developers/operations/testing-endpoints.md](docs/developers/operations/testing-endpoints.md)): `/api/qrcode`, `/api/recommendations`, `/api/advocates` (public JSON list, 60s cache + SWR), `/api/advocates/:slug/photo` (public WebP from HANA `AdvocatePhotos`, 86400s cache), `/build/catalog`, `/build/navigator`, `/build/slug-mapping`, `/build/co-completions`, `/build/repo-catalog` (GET unauth; POST bearer via `CONTENT_API_KEY`), `/feedback/submit` (rate-limited; `SUBMISSION_SALT_SECRET` required), `/chat/stream` (SSE), `/admin/embeddings/stats`, `/health`, `/health/db`, `/auth/user`
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
- **`app/admin/`** — 14 Fiori Elements apps (accomplishments, accounts, analytics, categories, changelog, events, feedback, groups, joule, missions, operations, prizes, tags, tutorials) — loaded as headless components by the shell via `componentUsages`
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
- **Developer Advocates page** (`hugo/content/developer-advocates/` + `hugo-apps/src/advocates/`): public Vue 3 island at `/developer-advocates/` showing the SAP Developer Advocates roster as hover-to-flip cards on a region-tinted gradient header band with an inline animated world map. Fetches `/api/advocates` at runtime; photos served from HANA via `/api/advocates/:slug/photo`. Admin CRUD at `/admin-ui/#advocates-display`. See [docs/developers/architecture/advocates.md](docs/developers/architecture/advocates.md).
- **Display dashboard** (`app/display-app/`): Standalone Vue+Vite app for event monitors — real-time dashboard with rotating views (Board, Statistics, Leaderboard). Connects via Socket.IO on the `/ws/display` namespace.

### Deployment (BTP Cloud Foundry)

Single MTA deployment (`mta.yaml`): AppRouter module serves Hugo static build from `approuter/static/` (excluding tutorials — those are served from HANA). XSUAA provides SAP IDP authentication. Routes in `approuter/xs-app.json` proxy to CAP backend via BTP Destination. The `/tutorials/*` route rewrites to `/content/tutorials/$1` on the CAP srv, which decompresses and serves HTML from HANA BLOBs. Tutorials are explicitly removed from the AppRouter static directory during build (`rm -rf approuter/static/tutorials`).

### Data Migration

Migration scripts in `scripts/` support parallel operation during cutover:
- `migrate-btp-roles.js` — copy BTP role-collection user assignments across subaccounts. See [btp-role-migration.md](docs/developers/operations/btp-role-migration.md).
- `migrate-reference-data.js` — export/import tutorials, missions, events, tags; `populate-slugs` patches slugs from CAP catalog cache
- `migrate-user-progress.js` — export/import users and task records (paged, resumable)
- `export-advocates.cjs` / `import-advocates.cjs` — snapshot + restore the Developer Advocate roster (records + topics + links + photos) between subaccounts. Idempotent upsert by slug; FKs re-resolved by `Users.email` / `Tags.slug`. Runbook: [docs/developers/operations/advocate-export-import.md](docs/developers/operations/advocate-export-import.md).
- `compare-systems.js` — endpoint-by-endpoint diff between Java IMS and CAP

Set `IMS_BASE_URL`, `CAP_BASE_URL`, `IMS_AUTH_TOKEN`. Exports go to `.migration-data/` (gitignored).

- **Change tracking suppression for REST migrators** — `x-migration-mode: true` header sent by `migrate-reference-data.js` and `migrate-user-progress.js`. HANA-to-HANA path (`migrate-from-hana.js`) still fires DB-level changelog triggers — see [migration-from-ims.md](docs/developers/operations/migration-from-ims.md) for mitigations.

### CI/CD (.github/workflows/)

- **`deploy.yml`** — Full MTA build + deploy to BTP Cloud Foundry, followed by smoke tests
- **`rebuild-content.yml`** — Re-fetches tutorials, rebuilds Hugo, publishes to HANA. Three scopes (`mode`): `catalog-only` (~5min, admin Mission/Group/Homepage saves — auto-classified; rebuilds+pushes approuter so homepage/data-feed changes reach visitors), `slug-targeted` (~2min, one-tutorial fix — auto-inferred when `slug`/`slugs` set), `full` (~10min, full catalog including tutorial fetch). `gh workflow run -f slug=<slug>` auto-infers `slug-targeted` (since #610). Admin writes auto-classify per entity via [srv/lib/_classify-rebuild-mode.js](srv/lib/_classify-rebuild-mode.js). Runbook: [rebuild-content-workflow.md](docs/developers/operations/rebuild-content-workflow.md).
- **`rebuild-content-qa.yml`** — QA sibling; sources only `*-Contribution` repos, publishes to `tutorials-srv-qa` via `CONTENT_API_KEY_QA`.
- **`docs-deploy.yml`** — Builds VitePress docs (`npm run docs:build`), deploys to GH Pages at <https://sap-tutorials.github.io/tutorials-ims/>.
- **`schema-drift-check.yml`** — Compares prod vs QA HDI artefacts; narrowed to `JobLocks` after shared-aspects refactor (PR #52).

### Documentation (docs/)

Architecture and reference docs for developers (not deployed). Organized by persona:

- [docs/README.md](docs/README.md) — persona index, start here
- [docs/end-users/README.md](docs/end-users/README.md) — for tutorial consumers
- [docs/authors/README.md](docs/authors/README.md) — for tutorial authors and event operators
- [docs/developers/README.md](docs/developers/README.md) — for platform engineers (you)
- [docs/historic/README.md](docs/historic/README.md) — AEM, IMS, completed migrations

The same persona docs are published as a public VitePress site at <https://sap-tutorials.github.io/tutorials-ims/>. Build commands:

- `npm run docs:dev` — local preview at <http://localhost:5173/tutorials-ims/>
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
- [docs/developers/architecture/homepage.md](docs/developers/architecture/homepage.md) — developer-portal homepage architecture (#639)

### Parsers (scripts/parsers/)

- **Fetch script format detection** — `--target hugo` detects parser format via frontmatter `parser: v2`. V2 uses H3 headings to delimit steps; V1 (legacy) uses `[ACCORDION-BEGIN]`/`[ACCORDION-END]`. `images.ts` resolves relative image paths to `raw.githubusercontent.com` CDN URLs. `options.ts` converts `[OPTION BEGIN]`/`[OPTION END]` to Hugo shortcodes. `sanitize-html.ts` cleans unsafe HTML. `hugo-delimiters.ts` handles Hugo delimiter escaping. `cap.ts` fetches mission/group catalog from CAP at build time. Shared types in `types.ts`.

### Testing

Three Vitest workspaces defined in `vitest.config.ts` (inline `projects`):

- **unit** — In-memory SQLite, fast, no external deps. `npm test`.
- **hybrid** — Real HANA Cloud via `cds bind --exec`. `npm run test:hybrid` (needs `cf login` to DEV). Files in `test/hybrid/` cover schema deploy, HANA sequences, views, workflows, admin CRUD, search. Write-safety guard (`test/hybrid/_guard.js`) checks `ALLOW_HYBRID_WRITES=true` before INSERT/UPDATE/DELETE; tests prefix data with `__TEST__` and clean up in `afterAll`.
- **smoke** — HTTP tests against deployed URLs. `npm run test:smoke`. Set `SMOKE_BASE_URL` (approuter) + `SMOKE_SRV_URL` (srv). Covers health, public endpoints, auth enforcement, OData metadata, static content, content serve, search, WebSocket handshake. Runs automatically after deploy in CI.

## QA Channel Bootstrap

One-time setup for the QA author-preview channel — full procedure (CI secrets, dispatch-token distribution to every `-Contribution` repo, local deploy with both prod and QA Hugo built, sanity check, role-collection assignment) lives in [docs/developers/operations/qa-channel-bootstrap.md](docs/developers/operations/qa-channel-bootstrap.md). Day-to-day QA commands are in the Commands section above; channel-specific gotchas (`.tutorial-cache-qa/` marker, `hugo.qa.toml`, `CONTENT_API_KEY_QA`) are in Gotchas below.

## Local Deploy & Conventions

- **Canonical local deploy** (CI is bypassed for most ad-hoc deploys):

  ```bash
  npm run build:all                       # Hugo MUST finish before mbt build
  cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
  ```

  `mbt build` only `cp`'s `hugo/public/` into the approuter — it does **not** run Hugo, and as of #494 (2026-06-21) also does not run `fetch-tutorials` (moved to pre-`mbt build` in `deploy.yml` to escape mbt's 10-min before-all timeout). Local builds MUST run `npm run build:all` before `mbt build`, else MTA builds against empty `hugo/content/tutorials/`. Skipping ships stale approuter (missing NEW badges, license icons, progress UI). Always confirm deploy scope with maintainer (backend-only / +content / +QA).
- **PR over direct merge** — Default to `gh pr create` from a feature branch; subagent code review is not a substitute for PR review. Only fast-merge to `main` if explicitly told to skip the PR.
- **`srv-qa` cp list audit** — When changing anything under `srv/lib/`, re-walk transitive `./` imports from `srv/lib/content-store.js` and confirm every dep is in `.deploy/mta.yaml`'s `srv-qa` `cp` list. Missing transitive deps crash QA boot at MTA deploy time.
- **CAP 10 readiness (June 2026)** — Node minimum becomes 22 (recommend 24 LTS); `compat_srv_getters`, `compat_texts_entities`, `legacyLocking`, `service_level_restrictions`, `consistent_params`, `compat_save_drafts`, `compat_assert_not_null`, `calc_elements` flags removed/flipped. Audit: `grep -rnE "ieee754compatible|compat_srv_getters|compat_texts_entities|legacyLocking|service_level_restrictions|consistent_params|compat_save_drafts|compat_assert_not_null|calc_elements" package.json .cdsrc*.* .env`.

## Gotchas

- **Fresh worktree setup needs `npm run setup` after `npm install`** — global npmrc has `ignore-scripts=true` (security policy against supply-chain attacks). Without `npm run setup`: `hugo-apps/node_modules` won't be populated and `better-sqlite3`'s native binding won't build. Symptoms: hugo-apps tests fail resolving `@mediapipe/tasks-vision`, `npm test` hangs. Issue #214.
- **`hugo/content/tutorials/` is entirely generated** — never edit these files directly. They are overwritten by `npm run fetch-tutorials`. Edit the parsers in `scripts/parsers/` or the source tutorials in the `sap-tutorials` GitHub org instead.
- **POC tutorial list is hardcoded** — Tutorials are dynamically discovered from `sap-tutorials` GitHub org via `discoverAllTutorials()` in `scripts/parsers/github.ts`. `EXCLUDED_REPOS` (just `tutorials-ims`) skipped. Private repos excluded by default; `INCLUDED_PRIVATE_REPOS` is allowlist (currently `meta-tutorials` — platform showcase). `-Contribution` private repos gated by `INCLUDE_CONTRIBUTION_REPOS` / `ONLY_CONTRIBUTION_REPOS` env vars. Discovery cached in `.tutorial-cache/discovery-map.json`. `npm run discover-repos` lists without fetching.
- **Validation quiz data from `-Contribution` repos** — `fetchRulesVr()` in `scripts/parsers/github.ts` fetches `rules.vr` from private `-Contribution` repos (e.g., `abap-core-development-Contribution`). Needs `GITHUB_TOKEN`. Cached in `.tutorial-cache/<slug>.rules.vr`. Parsed by `scripts/parsers/rules.ts`, injected into Hugo frontmatter steps.
- **`GITHUB_TOKEN` env var** — `scripts/parsers/github.ts` optionally uses this to avoid GitHub API rate limits when fetching commit metadata. Without it, unauthenticated requests may hit rate limits on repeated builds.
- **`CAP_BASE_URL` env var** — Used by `scripts/parsers/cap.ts` and migration scripts. Defaults to `http://localhost:4004`. Set to the deployed CAP srv URL for production builds.
- **Cache clearing** — `.tutorial-cache/` caches raw markdown, GitHub metadata, and CAP catalog data. Delete it to force a full re-fetch. There is no incremental invalidation.
- **Node.js >= 20 required** — Build scripts use native `fetch` (no polyfill).
- **Slug fields** — `Missions.slug` and `CompletionPaths.slug` must be populated for the build pipeline to generate mission/group pages. Run `node scripts/migrate-reference-data.js populate-slugs` after data import.
- **`app/` vs `hugo-apps/`** — Two separate directories. `app/` contains standalone UI apps (each with its own build): `admin-shell/`, `admin/` (14 Fiori Elements components loaded by shell), `analytics-explorer/` (Vue 3 SPA), `scanner/` (UI5), `display-app/` (Vue 3 event-monitor). Builds from `app/*` deploy by copying `dist/`/`webapp/` into `approuter/static/<route>/`. `hugo-apps/` is a single Vite project compiling ~17 Vue 3 page-level islands into `hugo/static/js/` — loaded by Hugo templates as `<script>` tags, not deployed as routes. `hugo-apps/src/{shared,composables}/` are utility modules, not islands. See [mta.yaml](mta.yaml).
- **Vite ↔ Hugo `js.Build` output collisions** — Vite entries in `hugo-apps/vite.config.ts` write to `hugo/static/js/<name>.js`. Hugo's `resources.Get "js/<X>.ts" | js.Build` writes to `hugo/public/js/<X>.js` after Hugo copies `static/` → `public/`, silently clobbering Vite if names collide (bit us in #251 — `tutorial.js` was both). `postbuild:apps` runs `tsx scripts/check-build-collisions.ts` which fails the build with file:line ref if a Vite entry name matches any Hugo `js.Build` output basename. Fix: rename one of them.
- **`/admin/` is OData only** — The AdminService OData endpoint lives at `/admin/`. The admin shell UI is served at `/admin-ui/` to avoid path collisions.
- **Hugo vs VitePress** — The project migrated from VitePress to Hugo. The `site/.vitepress/` directory still exists (with a built `dist/`) but is legacy. Active frontend work targets `hugo/`.
- **`CONTENT_API_KEY` env var** — Required for `POST /content/publish` and `POST /content/rollback`. Set in CI secrets and locally when testing. Without it, publish returns 401.
- **`GITHUB_DISPATCH_TOKEN` env var** — Read by `srv/lib/rebuild-trigger.js`; admin saves debounce-dispatch `rebuild-content.yml` after 60s when set. Sourced from `DISPATCH_TOKEN` GitHub Actions secret (**not** `GITHUB_DISPATCH_TOKEN` — GH reserves the `GITHUB_` prefix). All four mtaext placeholders (`${CONTENT_API_KEY}`, `${REBUILD_API_KEY}`, `${APPROUTER_URL}`, `${GITHUB_DISPATCH_TOKEN}`) resolve at deploy time via `envsubst` writing `deploy/<env>.resolved.mtaext`; `cf deploy -e` consumes it. `cf deploy --var` is NOT supported by multiapps-cli-plugin (#455). **Local manual deploy**: `export` the four env vars, `envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' < deploy/dev.mtaext > deploy/dev.resolved.mtaext`, then `cd .deploy && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f`. CI grep guard fails loudly if any placeholder survives. Rotation: [github-dispatch-pat-rotation.md](docs/developers/operations/github-dispatch-pat-rotation.md).
- **`rebuild-content.yml` mode auto-infer** — Manual `gh workflow run rebuild-content.yml -f slug=X` auto-infers `mode=slug-targeted` when `inputs.mode` is default `full` AND a slug input is set (#610). Don't pass `-f mode=slug-targeted` — leave mode off. `::notice::` in run UI shows resolved mode. Only `workflow_dispatch` gets auto-infer; `repository_dispatch` (admin auto-trigger) uses `srv/lib/_classify-rebuild-mode.js` authoritatively. Wall-clock: `catalog-only` ~5min (Vue/admin builds + approuter push, so homepage/data-feed admin saves reach visitors), `slug-targeted` ~2min, `full` ~10min. Runbook: [rebuild-content-workflow.md](docs/developers/operations/rebuild-content-workflow.md).
- **`SUBMISSION_SALT_SECRET` env var** — Required by `srv/lib/feedback-salt.js` for hashing submitter IPs on `POST /feedback/submit`. The Express bridge returns 503 if missing. Set in CI secrets and locally when testing the feedback form. Rotation invalidates in-memory rate-limit keys (acceptable).
- **`AICORE_EXPLAINER_GENERATOR_DISABLED` env var** — Kill-switch for the homepage explainer AI generation (#759). When set to `'true'`, all three `AdminService.generate*Explainers` actions return HTTP 503 immediately. Use for incident response (e.g., AI Core quota burned, prompt regression, cost runaway). Hand-authored content survives — only AI generation is blocked.
- **Tutorials are DB-only** — Tutorial HTML is served exclusively from HANA BLOBs. There is no static file fallback. If no content has been published to HANA, `/tutorials/*` returns 404.
- **Content garbage collection** — A daily cron job (03:00) prunes `SUPERSEDED`/`ROLLED_BACK` content versions older than 7 days, keeping the 3 most recent for rollback. Never touches `ACTIVE` or `PUBLISHING` manifests.
- **`publish-content.ts` flags** — Default mode is now correctness-equivalent to `--force`: the server's commit step carries forward unchanged slugs, so a delta-only payload no longer drops the rest of the catalog. `--force` is purely a performance/CI-convenience flag (skips the `/content/hashes` round-trip). After every successful publish the CLI auto-verifies against `/content/hashes` and **exits 2 on hash mismatch**. Use `--verify-only` to check without uploading, `--heal` to repair only the slugs that drifted, and `--dry-run` to preview. `--force`/`--heal`/`--verify-only` are mutually exclusive.
- **QA channel content** — `/tutorials-qa/*` is gated by XSUAA scope `Tutorial.Author`. Content sourced only from `*-Contribution` repos via `ONLY_CONTRIBUTION_REPOS=true`. Lives in `tutorials-db-qa` HDI; never queries prod tables.
- **`.tutorial-cache-qa/` vs `.tutorial-cache/`** — separate caches per channel. Running `fetch-tutorials` for a different channel writes a `.channel` marker; `dev` warns if the cache content channel doesn't match.
- **`CONTENT_API_KEY_QA` env var** — required for `POST /content/publish` and `/content/rollback` on QA srv.
- **`hugo.qa.toml`** — sibling Hugo config for QA. Strips Joule FAB, rating, completion buttons, progress UI when `site.Params.qa = true`.
- **HANA LOB locator expiry** — CDS QL returns HANA BLOBs as `Readable` streams with locators that expire before consumption when mixed with non-BLOB columns. `srv/lib/content-store.js` works around this by using raw SQL (`db.run()`) for BLOB retrieval on HANA, and CDS QL for SQLite (unit tests). Never SELECT a BLOB column alongside metadata in a single CDS QL query on HANA.
- **Tutorial embeddings live in `TutorialEmbedding` and are HANA-only at query time** — SQLite test path uses JS-side cosine. Never SELECT the `embedding` BLOB alongside metadata in a single CDS QL query on HANA (LOB locator expiry); use `db.run()` raw SQL in `srv/lib/embedding-query.js`.
- **`ChatSettings.ragEnabled`** — feature flag for the `getRelevantSteps` tool. When toggling on for the first time, click "Seed Embeddings Now" in the Joule Chat Settings tile to populate. Reconciliation cron at minute 17 of every hour catches any drift.
- **Tutorial slugs are lowercase canonical** — Hugo emits lowercase URLs; read path 301-redirects mixed-case (see `srv/lib/content-store.js:694`). Write path lowercases via `tutorialsTableInfo` helper (`srv/lib/_tutorials-table.js`), used by both `upsertTutorialMetadata` and legacy `publishHandler`. Source markdown filenames may ship with capitals (e.g. `extend-RAP-App.md`); never compare slugs to publish payload without `.toLowerCase()`. Mismatches manifest as "0 steps" on group SSR. Repair: [scripts/repair-mixed-case-tutorial-duplicates.cjs](scripts/repair-mixed-case-tutorial-duplicates.cjs) (idempotent, dry-run by default; hard-deletes orphan rows with zero FK refs, INACTIVE-flags where refs survive).
- **Tutorial/Mission/Group slugs are unique (case-insensitive)** — `@assert.unique.slug` on `Tutorials`, `Missions`, `Groups`. New write paths (migrators, importers, repair scripts) MUST upsert on slug, not blind-INSERT. Canonical pattern at `srv/lib/content-publish-session.js:285`: `SELECT id FROM table WHERE LOWER(slug)=?` then UPDATE-or-INSERT. Hybrid test `test/hybrid/duplicate-slugs.test.js` fails CI on duplicates. Repair: `npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit`.
- **TutorialMeta is a logical singleton (one row per tutorial)** — `@assert.unique.tutorial` on `TutorialMeta`. Auto-init at `srv/lib/content-publish-session.js:349` checks existing before INSERT; slug-merge script classifies `TutorialMeta.TUTORIAL_ID` as `kind: 'singleton'`. Hybrid test `test/hybrid/duplicate-tutorial-meta.test.js` guards. Repair: `npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs --commit`.
- **Tag labels are DB-driven; slugs are the join key** — Tutorial frontmatter carries raw slugs (`software-product>sap-s-4hana`). At Hugo build, `fetch-tutorials.ts` fetches slug→label map from `/build/tag-labels` and emits both `displayTags` (label) and `displayTagSlugs` (slug) into frontmatter + `_nav.json`. Navigator filter equality, license detection, topic categorization use `displayTagSlugs`; rendering (cards, filters, chips) uses `displayTags`. Labels admin-edited at `/admin-ui/#tags-display`. Missing slug falls back to lossy `humanizeTag()` heuristic — build never fails on missing labels. Seed from legacy AEM Solr: `npm run seed-tag-labels` (auth via `ADMIN_BEARER_TOKEN` or `ADMIN_BASIC_AUTH`). See [scripts/seed-tag-labels.ts](scripts/seed-tag-labels.ts).
- **AI code-check (issue #171, behind `ChatSettings.codeCheckEnabled`)** — author opt-in via `[CODECHECK_N]` blocks in rules.vr; trimmed spec ships in Hugo frontmatter, full spec (with reference solution) in `CodeCheckSpecs` HANA entity. Inline UI hits `/api/codecheck` (XSUAA, 30/hr/user, 5/5min/step); also reachable as `checkCode` Joule chat tool when flag on. Persistence: `CodeCheckSubmissions`. Spec: [2026-06-02-ai-code-check-spike-design.md](docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md).
- **AI-authored quizzes (issue #208, always-on as of #312)** — author opt-in via `[AUTOAUTHOR_*]` directives in `rules.vr`; per-step or tutorial-wide, with optional `:mcq`/`:text` type. Runs as post-parse expansion in `scripts/fetch-tutorials.ts` on every non-`catalog-only` rebuild. Per-tutorial content-hash cache at `.tutorial-cache/<slug>.ai-quiz-cache.json`. Hard cap default 200 LLM calls/build (`AI_AUTHOR_BUILD_CAP`). Bulk-seed: `npm run seed-ai-quizzes`. Model switch does NOT auto-invalidate cache — delete cache file manually to re-seed. Kill-switch: set `AI_AUTHOR_AICORE_SERVICE_KEY` repo secret to empty (SDK fails fast; AI expansion no-ops; hand-authored questions unaffected). AI questions emit same `ValidationQuestion` shape as hand-authored. Eval: `scripts/evaluate-ai-quizzes.ts` + `scripts/aggregate-ai-quiz-eval.ts`. Spec: [2026-06-05-208-ai-authored-quizzes-design.md](docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md).
- **Categories taxonomy is fixed in v1** — 8 categories seeded via `db/data/com.sap.developers.ims-Categories.csv` with stable UUIDs. Admins edit `label`/`sortOrder`/`seedDescription` at `/admin-ui/#categories-display` but cannot add/remove. Adding a new category is a v2 concern.
- **Categories reclassify is destructive** — admin `classifyCategories` action and per-OP "Classify this item" button DELETE-then-INSERT junction rows. Manual category edits survive only until next reclassify run. No provenance tracking (per spec #9). Force button shows destructive-confirm dialog.
- **`HYBRID_AI_TESTS=true` to opt into category-classifier hybrid test** — `npm run test:hybrid` runs are $0/run by default. Setting this env var enables `test/hybrid/categories-classifier.test.js` which consumes real AI Core quota (one classify call per mission fixture).
- **Alert saves do NOT trigger rebuilds** — alerts are runtime-served via `/api/alerts*`. Rebuild classifier returns `mode: 'none'` for `Alerts` ([_classify-rebuild-mode.js](srv/lib/_classify-rebuild-mode.js)). Cache-bust on `AdminService.Alerts` save is the only freshness mechanism; up-to-60s delay between admin save and visitor seeing new state is expected.
- **Observability metrics module** (`srv/lib/metrics.js`, #805) — In-memory counters/gauges/reservoirs drained every 5min by `srv/jobs/metrics-rollup-job.js` into `MetricSnapshots`. Env flags: `METRICS_ENABLED` (default `true`; kill-switch), `METRICS_DB_WRAP` (default `false`; when `true`, installs passive `cds.db.run`/`cds.db.tx` wrapper via `srv/lib/metrics-db-wrap.js` at `cds.on('served')` — emits `db.acquire.ms`, `db.tx.ms`, `db.tx.run.ms`, `db.pool.timeout`). Rollup job does NOT use `job-lock` — both CF instances write per-instance rows under composite PK `(windowStart, metric, instanceId)`. Retention jobs (30d/90d) DO use `job-lock`. Live snapshot: `/admin-ui/#metrics` (30s poll), `GET /admin/getMetricsSnapshot()` (CAP function), `GET /admin/metrics/live` (Express, checks `user.is('Admin')` since `basicAuthMiddleware` is pass-through). See [observability.md](docs/developers/architecture/observability.md).
- **Load tests (`test/load/`) are k6, not Vitest, and do NOT run on PRs** — five scenarios (`loadtest:smoke|baseline|ramp|tutorials|ws`) drive deployed DEV. CI: `.github/workflows/load-test.yml` runs weekly (Mon 03:00 UTC) + manual dispatch. Never on push/PR (DEV quota isn't free). Thresholds in `test/load/config.js` `THRESHOLDS` only; never hardcode ms in scenarios. Aborts if `/content/hashes` shows publish in flight. Runbook: [load-testing.md](docs/developers/operations/load-testing.md). Issue #804.

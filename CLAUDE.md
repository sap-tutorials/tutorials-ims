# CLAUDE.md

This file guides Claude Code (claude.ai/code) working in this repo.

## Project Overview

A tutorial hosting platform replacing Adobe Experience Manager (AEM) as the frontend for developers.sap.com. Fetches tutorial markdown from the `sap-tutorials` GitHub org at build time, parses it into Hugo static pages styled with SAP Fundamental Styles (Horizon theme), and deploys behind an AppRouter on SAP BTP Cloud Foundry with XSUAA auth. Backed by a CAP Node.js service with SAP HANA Cloud for progress tracking (IMS rewrite) and tutorial content persistence (HTML as gzip BLOBs, served dynamically from HANA — no static file fallback). AEM has been fully decommissioned. PROD cutover: end of July 2026.

## Commands

Full list: `jq '.scripts' package.json`. Operationally important:

```bash
# Quick start
npm install && npm run setup && npm run fetch-tutorials && npm run dev

# Frontend / build
npm run setup          # Fresh-worktree only: hugo-apps install + better-sqlite3 native rebuild
npm run fetch-tutorials  # Required before dev/build; caches in .tutorial-cache/
npm run dev            # Hugo dev server (http://localhost:1313)
npm run build:all      # Full production build (fetch + CSS + apps + Hugo + display)

# CAP backend
cds watch              # Local CAP (http://localhost:4004), in-memory SQLite
npm run dev:hybrid     # CAP + approuter against real HANA (parallel)
npm run bind:setup     # First-time hybrid env binding setup
npm run setup-dev-data # Populate slugs + clean autotest data (needs cds bind)

# Tests
npm test               # Unit (in-memory SQLite, fast)
npm run test:hybrid    # Hybrid (real HANA via cds bind --exec; requires cf login)
npm run test:smoke     # Smoke (HTTP against deployed; set SMOKE_BASE_URL/SMOKE_SRV_URL)

# Content publish (canonical: gh workflow; workstation is emergency-only)
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f slug=<slug>                        # one-tutorial hotfix, ~2 min (mode auto-inferred)
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full                          # full rebuild, ~10 min

# Migration & QA channel — see docs/developers/operations/{migration-from-ims,qa-channel-bootstrap}.md
```

Fetch tutorials before `dev` or `build`. Delete `.tutorial-cache/` to force re-fetch.

### Content publish CLI (emergency workstation path)

Runbook: [content-rollback.md](docs/developers/operations/content-rollback.md). Default mode is correctness-equivalent to `--force` (server carries forward unchanged slugs). Auto-verifies after publish; **exits 2 on hash mismatch**. Mutually exclusive flags: `--force` (skip hash round-trip), `--verify-only`, `--heal`. Every publish records initiator on `ContentManifest.initiator` for attribution.

## Architecture

```text
sap-tutorials GitHub repos
  → scripts/fetch-tutorials.ts (fetch + cache markdown, --target hugo)
    → scripts/parsers/ (frontmatter, steps, images, options)
      → hugo/content/tutorials/*.md → Hugo build → hugo/public/tutorials/*/index.html
        → scripts/publish-content.ts (delta publish to HANA BLOBs via /content/publish)

CAP backend (http://localhost:4004 or CAP_BASE_URL)
  → GET /build/catalog → missions/paths → hugo/content/missions/*.md and groups/*.md
```

Tutorial HTML is **not** served from static files. `publish-content.ts` uploads gzip BLOBs to HANA via `POST /content/publish`; AppRouter routes `/tutorials/*` to CAP `/content/tutorials/:slug`.

Deep dives (do not duplicate here — read the doc when relevant):

- [docs/developers/architecture/build.md](docs/developers/architecture/build.md) — content pipeline, parsers, testing workspaces
- [docs/developers/architecture/authentication.md](docs/developers/architecture/authentication.md) — auth flow, XSUAA, data privacy
- [docs/developers/architecture/homepage.md](docs/developers/architecture/homepage.md) — developer-portal homepage
- [docs/developers/architecture/advocates.md](docs/developers/architecture/advocates.md) — Developer Advocates page
- [docs/developers/architecture/observability.md](docs/developers/architecture/observability.md) — metrics module, snapshots
- [docs/developers/operations/testing-endpoints.md](docs/developers/operations/testing-endpoints.md) — **canonical UI + API endpoint reference** (services, custom endpoints, auth scopes)
- [docs/developers/operations/mta-deployment.md](docs/developers/operations/mta-deployment.md) — deploy runbook
- [docs/developers/operations/rebuild-content-workflow.md](docs/developers/operations/rebuild-content-workflow.md) — three rebuild modes, auto-classify
- [docs/developers/operations/qa-channel-bootstrap.md](docs/developers/operations/qa-channel-bootstrap.md) — QA author-preview channel
- [docs/developers/reference/tutorials-ims-gotchas.md](docs/developers/reference/tutorials-ims-gotchas.md) — everything else (build pipeline quirks, publish flags, AI features, env vars, migration)

Subsystem one-liners:

- **CAP srv/** — 12 services under `@path` prefixes (see testing-endpoints.md). Content persistence in `srv/lib/content-store.js`. WebSocket via `@cap-js-community/websocket` (Socket.IO) on `/ws/display` + `/ws/event-stream`. Jobs in `srv/jobs/` (scheduler.js) — scheduled via CAP 10's Scheduling API through the internal `CronService` in `srv/cron-service.js` (#958).
- **Admin UI** (`app/admin-shell/` + `app/admin/`) — 14 Fiori Elements components loaded as headless componentUsages inside a unified `sap.tnt.ToolPage` shell. Served at `/admin-ui/` (XSUAA-protected). Theme: `sap_horizon` with auto-detect.
- **Analytics Explorer** (`app/analytics-explorer/`) — Vue 3 SPA at `/analytics-ui/`. Ad-hoc SQL over `AnalyticsService`; SELECT-only allowlisted via `srv/lib/analytics-sql-validator.cjs`.
- **Scanner** (`app/scanner/`) — UI5 barcode scanner at `/scanner-ui/`. Uses `sap.ndc.BarcodeScanner`.
- **Hugo + Vue islands** — `hugo/` = static site, `hugo-apps/` = ~17 Vue 3 islands into `hugo/static/js/` (not routes). Standalone Vue app `app/display-app/` for event monitors.

## Local Deploy & Conventions

- **Canonical local deploy** (CI is bypassed for most ad-hoc deploys):

  ```bash
  npm run build:all                       # Hugo MUST finish before mbt build
  cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
  ```

  `mbt build` only `cp`'s `hugo/public/` into the approuter — it does **not** run Hugo or `fetch-tutorials`. Local builds MUST run `npm run build:all` before `mbt build`; skipping ships stale approuter (missing NEW badges, license icons, progress UI). Always confirm deploy scope with maintainer (backend-only / +content / +QA).

- **Local deploy is envsubst-free** — All four secrets (`CONTENT_API_KEY`, `REBUILD_API_KEY`, `APPROUTER_URL`, `GITHUB_DISPATCH_TOKEN`) formerly injected via `envsubst` now live exclusively in the BTP Credential Store (or have been removed entirely, in APPROUTER_URL's case). Run `cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f` directly. Rotation happens through `/admin-ui/#secrets` on the target env's approuter. See [mta-deployment.md](docs/developers/operations/mta-deployment.md) "Local deploy no longer needs envsubst" for the full context.

- **PR over direct merge** — Default to `gh pr create` from a feature branch; subagent code review is not a substitute for PR review. Only fast-merge to `main` if explicitly told to skip the PR.

- **`srv-qa` cp list audit** — When changing anything under `srv/lib/`, re-walk transitive `./` imports from `srv/lib/content-store.js` and confirm every dep is in `.deploy/mta.yaml`'s `srv-qa` `cp` list. Missing transitive deps crash QA boot at MTA deploy time.

## Top Gotchas (rest in [tutorials-ims-gotchas.md](docs/developers/reference/tutorials-ims-gotchas.md))

- **Fresh worktree setup needs `npm run setup` after `npm install`** — global npmrc has `ignore-scripts=true`. Without it, `hugo-apps/node_modules` won't be populated and `better-sqlite3`'s native binding won't build. Symptoms: hugo-apps tests fail resolving `@mediapipe/tasks-vision`, `npm test` hangs.

- **`hugo/content/tutorials/` is entirely generated** — Never edit; overwritten by `npm run fetch-tutorials`. Edit `scripts/parsers/` or source tutorials in `sap-tutorials` org.

- **Never run `publish-content` from a workstation** — Use `gh workflow run rebuild-content.yml`. Workstation publishes skip CI validation; the server-side no-revert guard catches the worst stale-cache regressions but not everything.

- **Tutorial slugs are lowercase canonical** — Hugo emits lowercase; read path 301-redirects mixed-case. Write path lowercases via `tutorialsTableInfo` helper. Never compare slugs to publish payload without `.toLowerCase()`. Mismatches manifest as "0 steps" on group SSR.

- **`TutorialMeta` and `Tutorials/Missions/Groups` slugs are unique** — `@assert.unique.slug` + `@assert.unique.tutorial`. New write paths MUST upsert on slug (SELECT-then-UPDATE-or-INSERT). Canonical pattern at `srv/lib/content-publish-session.js:285` / `:349`. Hybrid tests guard.

- **Never SELECT a HANA BLOB alongside metadata in a single CDS QL query** — LOB locators expire before consumption when mixed with non-BLOB columns. Use raw `db.run()` for BLOB retrieval on HANA (`srv/lib/content-store.js` + `srv/lib/embedding-query.js`). CDS QL works on SQLite for unit tests.

- **`CONTENT_API_KEY` env var required** for `POST /content/publish` and `/content/rollback`. Missing → 401. Set locally when testing publish.

- **GitHub Actions secret is `DISPATCH_TOKEN`, not `GITHUB_DISPATCH_TOKEN`** — GH reserves the `GITHUB_` prefix. The runtime env var is `GITHUB_DISPATCH_TOKEN`, read by `srv/lib/rebuild-trigger.js`.

- **`rebuild-content.yml` auto-infers `mode=slug-targeted`** when a `slug` input is set — don't pass `-f mode=slug-targeted`. Wall-clock: catalog-only ~5min, slug-targeted ~2min, full ~10min.

- **Alert saves do NOT trigger rebuilds** — Alerts are runtime-served. Cache-bust on save is the only freshness mechanism; up-to-60s admin-to-visitor delay expected.

- **`@cap-js/ai` plugin (issue #959, PR 2 of 2)** — adopted for RPT-1 recommendations on `@Common.ValueList` fields. Auto-hooks every such field in Fiori draft-enabled admin UIs. Local `cds watch` uses `AICore-mocked` (no recommendations, zero AI Core quota); hybrid/production use `AICore-btp` against the `aicore` VCAP binding. Per-field opt-out: `@UI.RecommendationState: 0`. Reference: [docs/developers/reference/cap-ai-plugin.md](docs/developers/reference/cap-ai-plugin.md).

- **`KG_PAGERANK_ENABLED` env var (issue #916)** — when `'true'`, `rankNeighborhood` in `srv/knowledge-graph-service.js` multiplicatively blends per-tutorial PageRank (`weight *= 1 + α × normPR`) into all three tutorial-targeted arms (`prerequisitesOf`, `sharedConcepts`, `whatToLearnNext`) and sorts `teaches` by concept-side PageRank. Default off. Scores recomputed nightly at 03:53 UTC by `srv/jobs/kg-pagerank-job.js` — PageRank runs in **Node.js** (not HANA GraphScript — that engine ships no PageRank primitive) over `KG_PG_VERTICES_V` + `KG_PG_EDGES_V`, materialized into `ConceptRank`/`TutorialRank` sidecars. Fail-opens on every fault path (missing sidecars, HANA hiccup, empty maps → multiplier collapses to 1.0). Toggle: `cf set-env tutorials-srv KG_PAGERANK_ENABLED true && cf restart tutorials-srv`. Blend strength via `KG_PAGERANK_ALPHA` (default `1.0` → weights grow at most 2×).

- **KG community detection (issue #917)** — Louvain community detection over `KG_PG_WORKSPACE` runs nightly at 03:57 UTC (`srv/jobs/kg-communities-job.js`) via HANA GraphScript `Communities_Louvain` in `db/src/procedures/KG_LOUVAIN_GRAPH.hdbprocedure`. Memberships materialize into the `KgCommunity` sidecar (`db/knowledge-graph-communities.cds`). Admin surface: `/admin-ui/#kgCommunities` renders a FE List Report (aggregated summary) + Object Page over `AdminService.KgCommunities` and `AdminService.KgCommunityMembers`. `promoteCommunityToMission(communityId, missionSlug, title)` action (SuperAdmin-gated) drafts a `Missions` row + `CompletionPaths` + `CompletionPathItems` sorted `Tutorials.title ASC`, with `Missions.sourceKgCommunityId` set so already-promoted communities can be filtered out. Nightly job fail-opens; empty sidecar renders as FE "No data", never a 500. **No env flag** — tile is always visible to XSUAA `Tutorial.Author` scope (Task 10 skipped: no shell-config precedent). **DEV-only in v1**; PROD rollout deferred. Metrics: `kg_communities_{duration_ms,count,max_size,failures}`.

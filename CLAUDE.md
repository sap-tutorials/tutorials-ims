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
npm run test:e2e       # Admin-UI Playwright smoke (post-deploy; set SMOKE_BASE_URL + SMOKE_TECH_USER/PASSWORD; self-skips when absent)

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

Tutorial HTML is **not** served from static files. `publish-content.ts` uploads gzip BLOBs to HANA via `POST /content/publish`; AppRouter routes `/tutorials/*` to CAP `/content/tutorials/:slug`. **Content pages** (`/browse/`, `/topics/`, verbs, sitemaps, etc.) use the same HANA BLOB pattern under the `page-<name>` key namespace — non-homepage routes are now **flipped to CAP** `/content/pages/*` (Phase 2). Homepage `/` flip is deferred (separate follow-up PR, flipped last after DEV cache/fail-open verification). See [docs/developers/architecture/build.md](docs/developers/architecture/build.md) §"Content Pages from HANA".

Deep dives (do not duplicate here — read the doc when relevant):

- [docs/developers/architecture/build.md](docs/developers/architecture/build.md) — content pipeline, parsers, testing workspaces
- [docs/developers/architecture/authentication.md](docs/developers/architecture/authentication.md) — auth flow, XSUAA, data privacy
- [docs/developers/architecture/homepage.md](docs/developers/architecture/homepage.md) — developer-portal homepage
- [docs/developers/architecture/advocates.md](docs/developers/architecture/advocates.md) — Developer Advocates page
- [docs/developers/architecture/observability.md](docs/developers/architecture/observability.md) — metrics module, snapshots
- [docs/developers/architecture/cross-container-integration.md](docs/developers/architecture/cross-container-integration.md) — reusable HDI↔HDI cross-container playbook (versioned views, grants/synonyms, `@cds.persistence.exists` facades, bootstrap sequencing)
- [docs/developers/operations/testing-endpoints.md](docs/developers/operations/testing-endpoints.md) — **canonical UI + API endpoint reference** (services, custom endpoints, auth scopes)
- [docs/developers/operations/mta-deployment.md](docs/developers/operations/mta-deployment.md) — deploy runbook
- [docs/developers/operations/rebuild-content-workflow.md](docs/developers/operations/rebuild-content-workflow.md) — three rebuild modes, auto-classify
- [docs/developers/operations/qa-channel-bootstrap.md](docs/developers/operations/qa-channel-bootstrap.md) — QA author-preview channel
- [docs/developers/operations/scheduler-troubleshooting.md](docs/developers/operations/scheduler-troubleshooting.md) — outbox-wedge recovery runbook
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
  # Point CAP_BASE_URL at the DEPLOYED backend so CAP-sourced pages (/concepts/,
  # advocates, homepage shelves) bake with real content. build:deploy fails fast
  # if CAP_BASE_URL is unset/localhost — guards the 2026-07-12 empty-concepts incident.
  export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
  npm run build:deploy                    # Hugo MUST finish before mbt build
  cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
  ```

  `mbt build` only `cp`'s `hugo/public/` into the approuter — it does **not** run Hugo or `fetch-tutorials`. Local builds MUST run `npm run build:all` before `mbt build`; skipping ships stale approuter (missing NEW badges, license icons, progress UI). Always confirm deploy scope with maintainer (backend-only / +content / +QA).

- **Local deploy is envsubst-free** — All four secrets (`CONTENT_API_KEY`, `REBUILD_API_KEY`, `APPROUTER_URL`, `GITHUB_DISPATCH_TOKEN`) formerly injected via `envsubst` now live exclusively in the BTP Credential Store (or have been removed entirely, in APPROUTER_URL's case). Run `cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f` directly. Rotation happens through `/admin-ui/#secrets` on the target env's approuter. See [mta-deployment.md](docs/developers/operations/mta-deployment.md) "Local deploy no longer needs envsubst" for the full context.

- **PR over direct merge** — Default to `gh pr create` from a feature branch; subagent code review is not a substitute for PR review. Only fast-merge to `main` if explicitly told to skip the PR.

- **`srv-qa` cp list audit** — When changing anything under `srv/lib/`, re-walk transitive `./` imports from `srv/lib/content-store.js` and confirm every dep is in `.deploy/mta.yaml`'s `srv-qa` `cp` list. Missing transitive deps crash QA boot at MTA deploy time.

- **Admin-UI changes need a FULL deploy + are bundle-gated** — the admin apps (`app/admin/*` + `app/admin-shell/`) are raw-copied into the approuter's `static/admin-ui/` by the MTA's approuter builder during `mbt build`. A `--skip-build` deploy (reuses a stale mtar), a module-scoped `cf deploy -m tutorials-srv`, or an mtar packaged before the change landed will silently ship a **stale admin UI** even though the fix is on `main` (this is why PR #1331/#1345's value-help fix looked "not deployed" on DEV). `npm run deploy` now runs **Step 3.5** (`scripts/check-shipped-admin-bundle.cjs`) which cracks the mtar and diffs the shipped admin component files against source, failing the deploy on drift. Rule: deploy admin-UI changes with a full `npm run deploy -- --env <env>` (NO `--skip-build`, NO `-m` scoping), and never bypass Step 3.5.

## Top Gotchas

The load-bearing few. **Full detail for every relocated item → [tutorials-ims-gotchas.md](docs/developers/reference/tutorials-ims-gotchas.md)** ("Top Gotchas — full detail" section); items with their own reference doc link straight to it.

- **Fresh worktree: run `npm run setup` after `npm install`** — global npmrc `ignore-scripts=true` skips native builds; without it `hugo-apps/node_modules` is empty and `better-sqlite3` won't build (tests hang / fail resolving `@mediapipe/tasks-vision`).
- **`ignore-scripts=true` silences all `pre*`/`post*` hooks** — local `build:all` does NOT fire `postbuild:apps`; island-manifest + `build:page-fallback` are wired as explicit `build:all` steps. Rely on the hook and merged JS/CSS ships dead (unhashed island paths) → "not deployed" despite a green deploy. → gotchas.md "Build artifacts & lifecycle hooks".
- **`hugo/content/tutorials/` is entirely generated** — never edit; `fetch-tutorials` overwrites. Edit `scripts/parsers/` or source repos.
- **Group/Mission completions are rollup-derived (#1934)** — `srv/lib/completion-rollup.js` recomputes parents after any TUTORIAL/PUZZLE/CHECKPOINT/PETOBERFEST completion; upserts on `(user_ID, taskLegacyId, taskType)`; NOT a `content-store.js` dep. → gotchas.md "Completions rollup".
- **Never run `publish-content` from a workstation** — use `gh workflow run rebuild-content.yml`; workstation publishes skip CI validation.
- **Tutorial slugs are lowercase canonical** — always `.toLowerCase()` before comparing to publish payload; mismatch = "0 steps" on group SSR.
- **`TutorialMeta` + `Tutorials/Missions/Groups` slugs are unique** — new write paths MUST upsert on slug (SELECT-then-UPDATE-or-INSERT); pattern at `srv/lib/content-publish-session.js:285`/`:349`.
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** — LOB locators expire; use raw `db.run()` (`srv/lib/content-store.js`, `srv/lib/embedding-query.js`). CDS QL is fine on SQLite unit tests.
- **`CONTENT_API_KEY` env var required** for `POST /content/publish` + `/content/rollback` (missing → 401).
- **Content served from mutable `ContentCurrent` (Option B, #2017)** — 3 env flags gate it (all default OFF, flip in order); rollback replays `ContentHistory`. Serve header `X-Content-Source: db-current` vs `db`. → gotchas.md "Content model — mutable ContentCurrent".
- **GitHub Actions secret is `DISPATCH_TOKEN`** (GH reserves `GITHUB_`) — runtime var `GITHUB_DISPATCH_TOKEN`, read by `srv/lib/rebuild-trigger.js`.
- **`rebuild-content.yml` auto-infers `mode=slug-targeted`** when `slug` is set — don't pass mode. Wall-clock: catalog ~5m, slug ~2m, full ~10m.
- **Alert saves do NOT trigger rebuilds** — runtime-served; cache-bust on save only, up-to-60s delay.
- **NGDS auto-send is PROD-only + DB-gated (double gate)** — fires only when CF `space_name==='prod'` AND `ImsConfig ngds.autosend.enabled==='true'`; edge-only, fails closed, never throws into the completion tx, allowlisted to TUTORIAL/GROUP/MISSION. → gotchas.md "NGDS auto-send".
- **`@cap-js/ai` for RPT-1 ValueList recommendations (#959)** — `AICore-mocked` locally, `AICore-btp` in hybrid/prod; per-field opt-out `@UI.RecommendationState: 0`. Ref: [cap-ai-plugin.md](docs/developers/reference/cap-ai-plugin.md).
- **Knowledge-graph feature flags (`KG_*`), all default OFF + DEV-only, all fail-open** — PageRank #916, WCC isolation #918, on-demand extraction #948, Louvain communities #917, orphan retirement #1115, community peers/labels #1126, community search weight #1171, coverage nudge #1172, cluster Q&A #1173. Toggles, nightly jobs, and fail-open specifics → gotchas.md "Knowledge graph feature flags".
- **HCQL protocol adapter (#995, CAP 10 beta)** — `@hcql` on 9 read services accepts CQN `SELECT` bodies at existing OData URLs. **CAP 10.0.3 exits the process on malformed CQN — do not expose to untrusted clients.** Kill: delete `srv/hcql-enablement.cds` + rebuild. Ref: [hcql-support.md](docs/developers/reference/hcql-support.md).
- **cds-caching CDS-DB store + metrics ON (#1222)** — `store:"cds"` in hybrid/prod, `memory` in base/unit. CF resolve-guard needs BOTH the baked csn entities AND `srv/lib/strip-precompiled-plugin-roots.js` (both load-bearing). Ref: [cds-caching-store.md](docs/developers/reference/cds-caching-store.md).
- **User-facing UI changes want a committed e2e spec** — advisory PR nudge on `app/**`/`hugo/**` changes; real coverage runs in the post-DEV-deploy `e2e` job. Ref: [e2e-coverage-pattern.md](docs/developers/reference/e2e-coverage-pattern.md).
- **`test:e2e` is post-deploy only, not on PRs** — self-skips without `SMOKE_BASE_URL`. Served tutorials render `<main>`+`<h1>`, NOT `<article>`. Runbook: `test/e2e/README.md`.
- **Freshness detector grounding needs the corpus-embedding backfill** — until `srv/jobs/freshness-corpus-embedding-job.js` runs, every API-obsolescence claim degrades to `confidence: Low`. Tutorial source from `ContentFiles.sourceContent` via `getTutorialSource(slug)`, NOT `Steps.description`. → gotchas.md "Freshness detector".

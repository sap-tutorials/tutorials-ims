# tutorials-ims Gotchas

Overflow for project-specific gotchas that used to live in `CLAUDE.md`. The top ~10 that repeatedly bite live in `CLAUDE.md` itself; everything else is here.

Cross-references:
- CAP/CDS gotchas → [cap-cds-gotchas.md](cap-cds-gotchas.md)
- HANA / HDI gotchas → [hana-hdi-gotchas.md](hana-hdi-gotchas.md)
- Vue islands gotchas → [vue-islands-gotchas.md](vue-islands-gotchas.md)

## Build pipeline

- **POC tutorial list is dynamic** — Tutorials are discovered from `sap-tutorials` GitHub org via `discoverAllTutorials()` in `scripts/parsers/github.ts`. `EXCLUDED_REPOS` (just `tutorials-ims`) skipped. Private repos excluded by default; `INCLUDED_PRIVATE_REPOS` is allowlist (currently `meta-tutorials`). `-Contribution` private repos gated by `INCLUDE_CONTRIBUTION_REPOS` / `ONLY_CONTRIBUTION_REPOS`. Discovery cached in `.tutorial-cache/discovery-map.json`. `npm run discover-repos` lists without fetching.
- **Validation quiz data from `-Contribution` repos** — `fetchRulesVr()` in `scripts/parsers/github.ts` fetches `rules.vr` from private `-Contribution` repos. Needs `GITHUB_TOKEN`. Cached at `.tutorial-cache/<slug>.rules.vr`. Parsed by `scripts/parsers/rules.ts`, injected into Hugo frontmatter steps.
- **`GITHUB_TOKEN` env var** — `scripts/parsers/github.ts` optionally uses it to avoid GitHub API rate limits.
- **`CAP_BASE_URL` env var** — Used by `scripts/parsers/cap.ts` and migration scripts. Defaults to `http://localhost:4004`.
- **Node.js >= 20 required** — Build scripts use native `fetch` (no polyfill).
- **Slug fields** — `Missions.slug` and `CompletionPaths.slug` must be populated for the build pipeline to generate mission/group pages. Run `node scripts/migrate-reference-data.js populate-slugs` after data import.

## Directory layout

- **`app/` vs `hugo-apps/`** — `app/` = standalone UI apps with their own builds (`admin-shell`, `admin`, `analytics-explorer`, `scanner`, `display-app`), each deploys by copying `dist/`/`webapp/` into `approuter/static/<route>/`. `hugo-apps/` = single Vite project compiling ~17 Vue 3 page-level islands into `hugo/static/js/` — loaded by Hugo templates as `<script>` tags, not deployed as routes. `hugo-apps/src/{shared,composables}/` are utility modules, not islands. See [mta.yaml](../../../mta.yaml).
- **Vite ↔ Hugo `js.Build` output collisions** — Vite entries write to `hugo/static/js/<name>.js`. Hugo's `resources.Get "js/<X>.ts" | js.Build` writes to `hugo/public/js/<X>.js` after Hugo copies `static/` → `public/`, silently clobbering Vite if names collide. `postbuild:apps` runs `tsx scripts/check-build-collisions.ts` — fix by renaming.
- **`/admin/` is OData only** — AdminService OData lives at `/admin/`. The admin shell UI is served at `/admin-ui/` to avoid path collisions.
- **Hugo vs VitePress** — Project migrated from VitePress to Hugo. `site/.vitepress/` still exists (with built `dist/`) but is legacy. Active frontend work targets `hugo/`.
- **`hugo/content/tutorials/` is entirely generated** — Never edit these files directly; they're overwritten by `npm run fetch-tutorials`. Edit `scripts/parsers/` or source tutorials in the `sap-tutorials` GitHub org.
- **Cache clearing** — `.tutorial-cache/` caches raw markdown, GitHub metadata, and CAP catalog data. Delete it to force a full re-fetch. No incremental invalidation.

## Content persistence & publish

- **Tutorials are DB-only** — HTML served exclusively from HANA BLOBs. No static file fallback. If nothing published, `/tutorials/*` returns 404.
- **Content garbage collection** — Daily cron (03:00) prunes `SUPERSEDED`/`ROLLED_BACK` versions older than 7 days, keeping the 3 most recent for rollback. Never touches `ACTIVE`/`PUBLISHING`.
- **`publish-content.ts` flags** — Default mode is now correctness-equivalent to `--force`: server's commit carries forward unchanged slugs. `--force` is a perf/CI-convenience flag (skips `/content/hashes` round-trip). CLI auto-verifies after publish; **exits 2 on hash mismatch**. `--verify-only` / `--heal` / `--dry-run`. `--force`/`--heal`/`--verify-only` mutually exclusive.
- **HANA LOB locator expiry** — CDS QL returns HANA BLOBs as `Readable` streams with locators that expire before consumption when mixed with non-BLOB columns. `srv/lib/content-store.js` uses raw SQL (`db.run()`) for BLOB retrieval on HANA, CDS QL for SQLite tests. Never SELECT a BLOB alongside metadata in a single CDS QL query on HANA.
- **Tutorial embeddings live in `TutorialEmbedding` and are HANA-only at query time** — SQLite test path uses JS-side cosine. Never SELECT the `embedding` BLOB alongside metadata in a single CDS QL query on HANA; use `db.run()` raw SQL in `srv/lib/embedding-query.js`.
- **Tutorial/Mission/Group slugs are unique (case-insensitive)** — `@assert.unique.slug` on `Tutorials`, `Missions`, `Groups`. New write paths MUST upsert on slug, not blind-INSERT. Canonical pattern at `srv/lib/content-publish-session.js:285`. Hybrid test `test/hybrid/duplicate-slugs.test.js` guards. Repair: `npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit`.
- **TutorialMeta is a logical singleton (one row per tutorial)** — `@assert.unique.tutorial` on `TutorialMeta`. Auto-init at `srv/lib/content-publish-session.js:349` checks existing before INSERT. Hybrid test `test/hybrid/duplicate-tutorial-meta.test.js` guards. Repair: `npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs --commit`.

## QA channel

- **QA channel content** — `/tutorials-qa/*` is gated by XSUAA scope `Tutorial.Author`. Content sourced only from `*-Contribution` repos via `ONLY_CONTRIBUTION_REPOS=true`. Lives in `tutorials-db-qa` HDI; never queries prod tables.
- **`.tutorial-cache-qa/` vs `.tutorial-cache/`** — separate caches per channel. `fetch-tutorials` writes a `.channel` marker; `dev` warns if content channel doesn't match.
- **`CONTENT_API_KEY_QA` env var** — required for `POST /content/publish` and `/content/rollback` on QA srv.
- **`hugo.qa.toml`** — sibling Hugo config for QA. Strips Joule FAB, rating, completion buttons, progress UI when `site.Params.qa = true`.
- **QA bootstrap runbook** — [docs/developers/operations/qa-channel-bootstrap.md](../operations/qa-channel-bootstrap.md).

## Rebuild workflow & admin writes

- **`rebuild-content.yml` mode auto-infer** — `gh workflow run rebuild-content.yml -f slug=X` auto-infers `mode=slug-targeted` when `inputs.mode` is default `full` AND a slug input is set. Don't pass `-f mode=slug-targeted`. Only `workflow_dispatch` auto-infers; `repository_dispatch` (admin auto-trigger) uses `srv/lib/_classify-rebuild-mode.js`. Wall-clock: `catalog-only` ~5min, `slug-targeted` ~2min, `full` ~10min. Runbook: [rebuild-content-workflow.md](../operations/rebuild-content-workflow.md).
- **`GITHUB_DISPATCH_TOKEN` env var** — Read by `srv/lib/rebuild-trigger.js`; admin saves debounce-dispatch `rebuild-content.yml` after 60s. Sourced from `DISPATCH_TOKEN` GitHub Actions secret (**not** `GITHUB_DISPATCH_TOKEN` — GH reserves `GITHUB_` prefix). All four mtaext placeholders resolve at deploy time via `envsubst` writing `deploy/<env>.resolved.mtaext`. Rotation: [github-dispatch-pat-rotation.md](../operations/github-dispatch-pat-rotation.md).
- **Alert saves do NOT trigger rebuilds** — Alerts are runtime-served via `/api/alerts*`. Rebuild classifier returns `mode: 'none'` for `Alerts` ([_classify-rebuild-mode.js](../../../srv/lib/_classify-rebuild-mode.js)). Cache-bust on save is the only freshness mechanism; up-to-60s delay expected.

## Content model quirks

- **Tag labels are DB-driven; slugs are the join key** — Frontmatter carries raw slugs (`software-product>sap-s-4hana`). At Hugo build, `fetch-tutorials.ts` fetches slug→label map from `/build/tag-labels`, emits `displayTags` (label) + `displayTagSlugs` (slug) into frontmatter + `_nav.json`. Navigator filter equality, license detection, topic categorization use `displayTagSlugs`; rendering uses `displayTags`. Labels admin-edited at `/admin-ui/#tags-display`. Missing slug falls back to lossy `humanizeTag()`. Seed from legacy AEM Solr: `npm run seed-tag-labels`.
- **Categories taxonomy is fixed in v1** — 8 categories seeded via `db/data/com.sap.developers.ims-Categories.csv` with stable UUIDs. Admins edit `label`/`sortOrder`/`seedDescription` but cannot add/remove.
- **Categories reclassify is destructive** — Admin `classifyCategories` and per-OP "Classify this item" DELETE-then-INSERT junction rows. Manual category edits survive only until next reclassify run.
- **Tutorial slugs are lowercase canonical** — Hugo emits lowercase URLs; read path 301-redirects mixed-case (see `srv/lib/content-store.js:694`). Write path lowercases via `tutorialsTableInfo` helper. Source markdown filenames may ship with capitals; never compare slugs to publish payload without `.toLowerCase()`. Mismatches manifest as "0 steps" on group SSR. Repair: [scripts/repair-mixed-case-tutorial-duplicates.cjs](../../../scripts/repair-mixed-case-tutorial-duplicates.cjs).

## AI features

- **AI code-check (issue #171, behind `ChatSettings.codeCheckEnabled`)** — Author opt-in via `[CODECHECK_N]` blocks in rules.vr; trimmed spec ships in Hugo frontmatter, full spec in `CodeCheckSpecs`. Inline UI hits `/api/codecheck` (XSUAA, 30/hr/user, 5/5min/step); also `checkCode` Joule chat tool. Persistence: `CodeCheckSubmissions`. Spec: [2026-06-02-ai-code-check-spike-design.md](../../superpowers/specs/2026-06-02-ai-code-check-spike-design.md).
- **AI-authored quizzes (issue #208, always-on as of #312)** — Author opt-in via `[AUTOAUTHOR_*]` in `rules.vr`. Post-parse expansion in `scripts/fetch-tutorials.ts`. Per-tutorial content-hash cache at `.tutorial-cache/<slug>.ai-quiz-cache.json`. Hard cap default 200 LLM calls/build (`AI_AUTHOR_BUILD_CAP`). Bulk-seed: `npm run seed-ai-quizzes`. Model switch does NOT auto-invalidate cache — delete cache file manually. Kill-switch: set `AI_AUTHOR_AICORE_SERVICE_KEY` empty. Eval: `scripts/evaluate-ai-quizzes.ts` + `scripts/aggregate-ai-quiz-eval.ts`.
- **`ChatSettings.ragEnabled`** — Feature flag for the `getRelevantSteps` tool. When toggling on first time, click "Seed Embeddings Now" in Joule Chat Settings tile. Reconciliation cron at minute 17 catches drift.
- **`HYBRID_AI_TESTS=true` to opt into category-classifier hybrid test** — Default hybrid runs are $0/run. This env var enables `test/hybrid/categories-classifier.test.js` (one classify call per mission fixture).
- **`AICORE_EXPLAINER_GENERATOR_DISABLED` env var** — Kill-switch for homepage explainer AI generation (#759). Set `'true'` → all three `AdminService.generate*Explainers` actions return HTTP 503. Hand-authored content survives.

## Observability & load

- **Observability metrics module** (`srv/lib/metrics.js`, #805) — In-memory counters/gauges/reservoirs drained every 5min by `srv/jobs/metrics-rollup-job.js` into `MetricSnapshots`. Env flags: `METRICS_ENABLED` (default `true`; kill-switch), `METRICS_DB_WRAP` (default `false`; installs passive `cds.db.run`/`cds.db.tx` wrapper). Rollup does NOT use `job-lock`; retention (30d/90d) does. Live snapshot: `/admin-ui/#metrics`, `GET /admin/getMetricsSnapshot()`, `GET /admin/metrics/live`. See [observability.md](../architecture/observability.md).
- **Load tests (`test/load/`) are k6, not Vitest, and do NOT run on PRs** — Five scenarios drive deployed DEV. CI runs weekly (Mon 03:00 UTC) + manual. Never on push/PR (DEV quota isn't free). Thresholds in `test/load/config.js`; never hardcode ms in scenarios. Aborts if `/content/hashes` shows publish in flight. Runbook: [load-testing.md](../operations/load-testing.md).

## Runtime env vars

- **`CONTENT_API_KEY` env var** — Required for `POST /content/publish` and `POST /content/rollback`. Set in CI secrets and locally. Without it, publish returns 401.
- **`SUBMISSION_SALT_SECRET` env var** — Required by `srv/lib/feedback-salt.js` for hashing submitter IPs on `POST /feedback/submit`. Express bridge returns 503 if missing.

## Data privacy

- **`@cap-js/data-privacy` deferred, annotations shipped (#960)** — Plugin install rolled back at 0.6.2 due to two `cds build --production` crashes. Annotation cleanups landed anyway. When retrying plugin adoption: verify `cds build --production` succeeds against schema FIRST; pick up Tasks 7/8/9 blueprints; do NOT re-annotate BranchDecisions as `DataSubjectDetails`. Spec: [2026-07-04-960-data-privacy-plugin-design.md](../../superpowers/specs/2026-07-04-960-data-privacy-plugin-design.md).

## Migration

- **Change tracking suppression for REST migrators** — `x-migration-mode: true` header sent by `migrate-reference-data.js` and `migrate-user-progress.js`. HANA-to-HANA path (`migrate-from-hana.js`) still fires DB-level changelog triggers — see [migration-from-ims.md](../operations/migration-from-ims.md) for mitigations.

## Personalization

- **Personalization endpoint MUST set `X-Personalization: 1` and `Cache-Control: private, no-store`** — the approuter is documented to never cache this header combination. Dropping either header silently allows a shared cache to serve one user's personalized payload to another user or to anonymous visitors. The smoke test (`test/smoke/homepage-personalized.test.js`) asserts both headers on every deployed environment.
- **Client-side ETag round-trip lives in `sessionStorage['sap-devs-homepage-personalized']`** — clearing sessionStorage forces the coordinator to fetch fresh (no `If-None-Match` header, 200 response). The session key is `sap-devs-homepage-personalized`; the bypass flag is `sap-devs-homepage-default`. Both are sessionStorage (not localStorage), so they clear on tab close.

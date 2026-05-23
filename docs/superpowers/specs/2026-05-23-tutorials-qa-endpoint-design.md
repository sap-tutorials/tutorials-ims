# /tutorials-qa Endpoint — Design

**Date:** 2026-05-23
**Status:** Approved (pending spec review + user review)
**Author:** Tom Jung

## Problem

Authors of SAP tutorials write content in `*-Contribution` GitHub repositories before
changes land in the public-facing main repos. Today there is no production-grade way
for them to preview that in-flight content as it will appear on developers.sap.com.
A separate true-Dev environment exists, but it serves the prod content from main
repos — not the unmerged work in `-Contribution`.

We need an author-only preview endpoint, deployed alongside production, that mirrors
the prod tutorial search and display experience but is sourced from the `-Contribution`
repos. It is *not* a place to test progress tracking, Joule, RAG, or analytics; those
features are out of scope and must not be reachable through the QA surface.

## Goals

1. Authors logged into developers.sap.com with a `Tutorial Author` role can browse
   `/tutorials-qa/<slug>` and `/tutorials-qa/search` to preview their in-flight content.
2. A push to `tutorials/<slug>/` in any `*-Contribution` repo causes that single
   tutorial to be re-fetched, re-rendered, and re-published to the QA endpoint within
   the time bounds of the existing rebuild workflow.
3. QA content has zero shared mutable state with production: a misconfigured QA build,
   a malformed tutorial, or a stuck publish must not affect production tables, jobs,
   or response paths.
4. The Joule chat backend, the RAG embedding tables, the `Users`/`TaskRecords`/
   progress entities, audit logging, and the admin UI are not exposed by — and not
   reachable through — the QA service.

## Non-Goals

- Mission/group preview. Missions and CompletionPaths are admin-managed and remain
  prod-only. Authors who need to test mission-level changes use the existing true-Dev
  environment.
- Statistics, leaderboards, completion timelines, or any analytics on QA content.
- Localization preview. Tutorials are English-only (en_us), per existing project
  scope.
- Long-term content garbage collection on QA HDI. Manual rollback exists; an
  automated GC job is deferred to a later iteration.
- Tutorial **authoring** UI. Authors continue to edit in VS Code + GitHub.

## Architecture Overview

```
                                      ┌────────────────────────┐
   author push to *-Contribution ────▶│  notify-qa.yml (in     │
                                      │  each -Contribution)   │
                                      └──────────┬─────────────┘
                                                 │ repository_dispatch
                                                 │ type: tutorial-qa-updated
                                                 ▼
                                      ┌────────────────────────┐
                                      │  rebuild-content-qa.yml│
                                      │  (in tutorials-poc)    │
                                      └──────────┬─────────────┘
                                                 │ fetch (--channel qa) → Hugo (qa cfg) → publish
                                                 ▼
  XSUAA login                         ┌──────────────────────────┐
  (Tutorial.Author scope)             │  AppRouter               │
       │                              │   /tutorials-qa/*  ──────┼──▶ tutorials-srv-qa
       └─────────▶ browser ───────────┤   /tutorials-qa/search   │     (CAP, content + search)
                                      │     served from           │            │
                                      │     static/qa/            │            ▼
                                      └──────────────────────────┘    tutorials-db-qa
                                                                       (HANA HDI, isolated)
```

**Key principles:**
- Same MTA as prod, two new modules (`tutorials-srv-qa`, `tutorials-db-qa`).
- Same Hugo source, two builds parameterized by `site.Params.qa`.
- Same CDS sources for the duplicated entities (via `using` import); different
  HDI containers, different physical schemas.
- Same parsers, same `lib/content-store.js` — service-shaped wrappers in `srv-qa/`
  are thin.

## Components

### New Components

#### MTA modules
- **`tutorials-srv-qa`** — CAP Node.js app. Exposes `ContentService` and
  `SearchService` only. Bound to `tutorials-db-qa` HDI and shared XSUAA. Same CF
  space as prod.
- **`tutorials-db-qa`** — HDI container module. Schema sourced from `db-qa/`.

#### CAP source tree
- **`srv-qa/content-service.cds`** + **`content-service.js`** — registers
  `/content/tutorials/:slug`, `/content/hashes`, `/content/nav`, `/content/publish`,
  `/content/rollback`. Implementation delegates to existing
  `srv/lib/content-store.js`.
- **`srv-qa/search-service.cds`** + **`search-service.js`** — registers `/search`
  with the BM25 helper used in prod, scoped to `TutorialBodyText` rows in the QA
  HDI.
- **`srv-qa/server.js`** — minimal bootstrap. No jobs, no STOMP, no audit-logging
  plugin, no `/api/qrcode`, no `/feedback/*`.

#### CDS schema
- **`db-qa/schema.cds`** — re-declares the four content entities (`ContentFiles`,
  `ContentManifest`, `TutorialBodyText`, `RepoCatalog`) verbatim under the
  `com.sap.developers.ims.qa` namespace. The actual prod namespace is
  `com.sap.developers.ims` (see `db/schema.cds:1`); QA gets its own namespace so
  HDI generates separate physical tables. A schema-drift CI job (below) keeps
  the two definitions in lockstep. Build target lists `db/` and `db-qa/`; the
  QA module's `cds.build.target` filter limits deploy artifacts to the
  qa-namespaced entities so only those `*.hdbtable`s ship to `tutorials-db-qa`.

#### Hugo configuration
- **`hugo.qa.toml`** — sets `params.qa = true`, `baseURL` for `/tutorials-qa/`
  prefix, and excludes the page kinds that don't apply (`/me/`, mission/group
  lists). Layouts gain `{{ if not site.Params.qa }}` guards around: Joule
  step-help FAB, rating widget, completion buttons, profile timeline, progress
  bars, leaderboard widgets.

#### Build scripts
- `scripts/fetch-tutorials.ts` — add `--channel <prod|qa>` flag. In `qa` mode:
  - Discovery filters to repos ending in `-Contribution` only (new
    `ONLY_CONTRIBUTION_REPOS` mode; the existing `INCLUDE_CONTRIBUTION_REPOS`
    flag retains its current semantics).
  - Cache directory: `.tutorial-cache-qa/` (gitignored).
  - Output to `hugo/content/tutorials/` is shared but only one channel runs at a
    time within a workflow.
- `scripts/publish-content.ts` — add `--channel <prod|qa>` flag. In `qa` mode:
  - `CAP_BASE_URL` defaults to `CAP_QA_BASE_URL` env.
  - Bearer token reads from `CONTENT_API_KEY_QA`.
  - Always uses delta detection bypass (effectively `--force` semantics —
    matches the existing prod gotcha).
  - Source dir: `hugo/public-qa/`.
- `scripts/install-qa-workflows.ts` — one-shot installer that opens a PR adding
  `.github/workflows/notify-qa.yml` to each `*-Contribution` repo. Idempotent;
  re-runnable when the workflow needs an update.
- `npm run build:qa` — runs `hugo --config hugo.qa.toml --source hugo
  --destination public-qa`.

#### GitHub workflows
- **`.github/workflows/rebuild-content-qa.yml`** (in tutorials-poc) — triggered
  by `repository_dispatch: types: [tutorial-qa-updated]` and `workflow_dispatch`.
  Honors `slug` input / `client_payload.slug` for single-slug fast path via the
  existing `TUTORIAL_SLUG` env mechanism.
- **`.github/workflows/notify-qa.yml`** (installed into each `*-Contribution`
  repo by the installer) — on push to `tutorials/**`, computes the changed slug
  and fires `repository_dispatch` to tutorials-poc.

#### AppRouter routing
- New routes in `approuter/xs-app.json`:
  - `^/tutorials-qa/search(.*)$` → `static/qa/search/...`, scope
    `Tutorial.Author`.
  - `^/qa-search/(.*)$` → destination `tutorials-srv-qa`, target `/search/$1`,
    scope `Tutorial.Author`.
  - `^/tutorials-qa/(.*)$` → destination `tutorials-srv-qa`, target
    `/content/tutorials/$1`, scope `Tutorial.Author`.
- Route order: most-specific first (`/tutorials-qa/search` before
  `/tutorials-qa/`).
- Static QA frontend deploys to `approuter/static/qa/` (search index page,
  list pages). Tutorial HTML is NOT copied to static — served from QA HANA.
- `mta.yaml` build hook adds `rm -rf approuter/static/qa/tutorials` mirroring
  the prod hook.

#### XSUAA
- New scope `Tutorial.Author` in `xs-security.json`.
- New role `Tutorial Author` bundling that scope.
- New role collection `Tutorial Author`. Initial assignment to authors is
  out-of-band via BTP cockpit / `btp assign`.

### Modified Components

- `mta.yaml` — adds two modules (`tutorials-srv-qa`, `tutorials-db-qa`), one
  destination row, two new resource references (`tutorials-db-qa-hdi`,
  CONTENT_API_KEY_QA secret).
- `xs-security.json` — adds `Tutorial.Author` scope, role, role-collection
  template.
- `approuter/xs-app.json` — adds 3 routes above.
- `approuter/server.js` — local-dev path: bypass Tutorial.Author scope check in
  hybrid mode (mirrors existing admin-UI bypass pattern).
- `package.json` — adds `build:qa` script and dependency wiring for any new
  helpers needed by the installer.
- `.gitignore` — adds `.tutorial-cache-qa/` and `hugo/public-qa/`.
- `vitest.config.ts` — adds a fourth project: `hybrid-qa`, pointing at
  `test/hybrid-qa/**` and using a separate `cds bind` target.

### Not Modified

- `srv/` — production service tree untouched.
- `db/schema.cds` — production schema untouched.
- `hugo/layouts/` — only adds conditional guards; no removals.
- `scripts/parsers/` — same parsers handle both channels.
- Production GitHub workflows — `rebuild-content.yml` and `deploy.yml`
  unchanged.
- Migration scripts — out of scope.

## Data Flow

### Author push → QA preview

1. Author pushes commit touching `tutorials/<slug>/` in `<repo>-Contribution`.
2. `notify-qa.yml` runs, computes the changed slug from the diff, fires
   `repository_dispatch` (event-type `tutorial-qa-updated`, payload includes
   `repo`, `slug`, `sha`).
3. `rebuild-content-qa.yml` in tutorials-poc receives the dispatch.
4. Workflow runs:
   - `npm run fetch-tutorials -- --channel qa` (with `TUTORIAL_SLUG=<slug>`
     for single-slug; `.tutorial-cache-qa/` busts that slug, regenerates the
     rest from cache).
   - `npm run build:qa` produces `hugo/public-qa/`.
   - `npm run publish-content -- --channel qa --force` POSTs the gzipped HTML
     to `tutorials-srv-qa` `/content/publish` with bearer
     `CONTENT_API_KEY_QA`.
5. Author refreshes `/tutorials-qa/<slug>` → AppRouter checks XSUAA scope →
   forwards to `tutorials-srv-qa /content/tutorials/<slug>` → HTML
   decompressed from QA HANA.

### QA search

1. Author hits `/tutorials-qa/search` → AppRouter serves
   `approuter/static/qa/search/index.html`.
2. The search page's JS calls `/qa-search/Tutorials?$search=<term>` →
   AppRouter routes to `tutorials-srv-qa` `/search/Tutorials?$search=...`.
3. SearchService runs BM25 over `TutorialBodyText` in QA HDI; returns
   matching slugs and snippets. Results link to `/tutorials-qa/<slug>`.

### Initial deployment

1. First MTA deploy creates empty `tutorials-db-qa` HDI container and the QA
   srv app (no `ContentManifest` rows → `/tutorials-qa/<slug>` returns 404
   for all slugs).
2. First successful `rebuild-content-qa.yml` run populates `RepoCatalog`,
   `ContentFiles`, `ContentManifest`, `TutorialBodyText`.
3. Authors are assigned the `Tutorial Author` role collection out-of-band
   before they need to access the endpoint.

## Error Handling

| Failure mode | Behavior |
|---|---|
| QA HDI missing entity / migration error | QA srv fails health check; AppRouter 502s on `/tutorials-qa/*`. Prod unaffected. |
| `notify-qa.yml` dispatch token expired | Push succeeds, dispatch fails with workflow logs. Author re-runs the workflow manually after token rotation. |
| `rebuild-content-qa.yml` fetch from `-Contribution` repo fails (private repo, missing token) | Workflow fails in fetch step; existing QA content untouched. Author sees prior published version at `/tutorials-qa/<slug>`. |
| Hugo build fails on QA-only template path | Workflow fails; existing QA content untouched. The build script greps the rendered output for `chat-fab`/`rating-indicator`/etc and fails if any are present (verifies the strip guards work). |
| Publish 401 (CONTENT_API_KEY_QA missing or wrong) | Workflow fails; existing QA content untouched. |
| Author hits `/tutorials-qa/<slug>` without role | AppRouter returns 403 (XSUAA scope check failed). |
| Author hits `/tutorials-qa/<unknown-slug>` | QA srv returns 404 with the same body shape as prod's content-serve 404. |
| QA srv crash | AppRouter 502s on `/tutorials-qa/*`. CF auto-restarts. Prod unaffected. |

## Testing Strategy

### Unit (`test/srv-qa/**`)
- ContentService: publish → serve → hashes → rollback round-trips on in-memory
  SQLite with the qa-namespaced entities.
- SearchService: BM25 search over a seeded `TutorialBodyText` returns expected
  slugs.
- Verify QA srv does NOT register routes for `/api/*`, `/admin/*`, `/display/*`,
  `/event-stream`, `/build/*` — assert 404 on those paths.

### Hybrid (`test/hybrid-qa/**`)
- Schema deploys cleanly to `tutorials-db-qa` HDI via a separate `cds bind`
  target (`hana-tutorials-db-qa`).
- Real-HANA round-trip on `/content/publish` → `/content/tutorials/<slug>`
  including LOB-locator workaround.
- Existing write-safety guard pattern (`ALLOW_HYBRID_WRITES=true`,
  `__TEST__` slug prefix, `afterAll` cleanup) applied to QA tests.

### Smoke (`test/smoke/qa-*.spec.ts`)
- HTTP-level: `/tutorials-qa/<seeded-slug>` returns 200 and HTML with the QA
  banner partial; same path without the role returns 403.
- `/qa-search/Tutorials?$search=...` returns expected matches.
- `/api/getEventProgress`, `/admin/Events`, etc. requested via QA destination
  → 404 (not exposed).
- Runs after deploy in CI (mirrors existing prod smoke pattern); env vars
  `SMOKE_QA_BASE_URL` and `SMOKE_QA_SRV_URL`.

### Schema-drift CI
- New CI job (`.github/workflows/schema-drift-check.yml`) runs `cds compile`
  against both prod and QA models and asserts that the duplicated entities
  (`ContentFiles`, `ContentManifest`, `TutorialBodyText`, `RepoCatalog`) have
  identical column definitions. Fails the build if they diverge.

## Deployment

- Single `cf deploy` with the updated MTA. New modules deploy alongside prod.
- First-time bootstrap:
  1. Add `CONTENT_API_KEY_QA`, `CAP_SRV_URL_QA`, `TUTORIAL_FETCH_TOKEN`
     secrets to tutorials-poc repo.
  2. Generate `TUTORIALS_POC_DISPATCH_TOKEN` (fine-grained PAT) and store as
     a per-repo secret in each `-Contribution` repo (the installer can also
     do this via `gh api`).
  3. Run `scripts/install-qa-workflows.ts` to open PRs adding
     `notify-qa.yml` to each `-Contribution` repo.
  4. Manually trigger `rebuild-content-qa.yml` (full rebuild) to populate
     QA HDI.
  5. Assign `Tutorial Author` role collection to author users.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Authors confuse QA URL with prod URL and report bugs against the wrong env | Mandatory banner partial on every QA page (yellow header: "QA preview — content from `<repo>` -Contribution branch"). Page title prefixed `[QA]`. |
| GitHub API rate limit on `-Contribution` discovery | Dedicated `TUTORIAL_FETCH_TOKEN` and dedicated `.tutorial-cache-qa/` so prod and QA budgets don't compete. |
| Schema drift between `db/` and `db-qa/` | Shared `using` import + CI drift check. |
| Joule/RAG features re-enabled in QA Hugo by accident | `site.Params.qa = true` template guards + post-build grep for forbidden DOM markers (`chat-fab`, `rating-indicator`, `progress-bar`, `completion-button`). Build fails if any present. |
| QA HDI fills with old content (no GC) | Manual rollback via `/content/rollback` for v1. GC job port deferred. |
| Author leaks PII into a tutorial | QA surface has no `Users`/`UserMetaData`/audit pipeline. Risk reduces to "tutorial body text contains PII" — same risk surface as prod. |
| QA srv outage masks itself because no one monitors | QA srv joins the existing CF health-check rotation; pager rule for prod srv is NOT extended to QA (lower priority). Smoke tests fail loudly in CI. |
| Local hybrid dev requires running two CAP instances | `dev:hybrid` script optionally starts QA srv on `localhost:4005`; can be skipped via `SKIP_QA=1` for prod-only debugging sessions. |

## Open Questions

None at design time. Remaining choices (cache subdir vs sibling, baseURL
shape, etc.) were resolved during brainstorming. Operational-detail decisions
(exact CF instance sizing for QA srv, retention policy for `tutorials-db-qa`)
are deferred to deploy time.

## References

- `CLAUDE.md` — project overview, gotchas, commands.
- `db/schema.cds:1` — prod namespace `com.sap.developers.ims`. QA uses
  `com.sap.developers.ims.qa` (literal-copy of the four entities, kept in
  sync via the schema-drift CI job).
- `db/schema.cds:307-347` — prod entity definitions (ContentFiles,
  ContentManifest, TutorialBodyText, RepoCatalog) duplicated verbatim in QA.
- `srv/lib/content-store.js` — gzip + LRU + LOB-locator workaround reused by QA.
- `.github/workflows/rebuild-content.yml` — prod template the QA workflow
  mirrors.
- `scripts/parsers/github.ts:432,477` — existing `INCLUDE_CONTRIBUTION_REPOS`
  flag; QA uses inverse `ONLY_CONTRIBUTION_REPOS` semantic.
- `feedback_publish_content_force.md` — published Tom-memory; QA always uses
  force-publish for the same reason.

# Concepts page scale: virtualization + CAP takeover

Status: Draft
Date: 2026-07-08
Owner: Tom Jung
Scope: DEV only (PROD cutover end-of-July 2026 is out of scope)

## Problem

The `/concepts/` page is a Hugo-static list that inlines every published concept as an `<li>` in a single HTML document. The published concept count has grown from ~150 (initial Phase-1 registry) to 5000+ today, with expected ceiling around 10k.

At the current 5k count:

- **Payload size.** ~1 MB of HTML, ~150-250 KB gzipped, is served to every visitor. At 10k that's 300-500 KB gzipped.
- **DOM parse cost.** ~5k `<li>` nodes with `data-*` attributes → 20k+ DOM nodes → 1-3 s of parse on mid-range mobile before interactive.
- **Filter cost.** The current Vue island (`hugo-apps/src/concepts-filter/App.vue`) filters by walking the full DOM and toggling `hidden` on each `<li>`. At 5k nodes each keystroke burns 20-50 ms — noticeable input lag.
- **Retained memory.** ~50-100 MB of live DOM per open tab.
- **Hugo build cost.** `scripts/fetch-concepts.ts` writes one `.md` per concept and Hugo renders one HTML per `.md`. 5k pages add ~30-60 s to every full rebuild.
- **Droplet bloat.** 5k static detail HTMLs land in the approuter droplet (~100-250 MB) even though CAP intercepts `/concepts/<slug>` and serves from HANA — the droplet copies are dead weight.

The list itself is Hugo-static and refresh cadence depends on which mode of `rebuild-content.yml` ran: full and catalog-only regenerate the list; slug-targeted (the common single-tutorial hotfix) does not. This means the DEV `/concepts/` page can lag published state by days.

Concept detail pages (`/concepts/<slug>/`) are already served from HANA — the AppRouter routes `/concepts/(.*)` to CAP `/content/concepts/$1`, which delegates to the same `serveHandler` that tutorials use, with slugs prefixed `concept-<slug>`. The Hugo-rendered detail HTMLs are uploaded to `ContentFiles` alongside tutorials by `publish-content.ts`. The detail-page render pipeline through Hugo is redundant with the CAP serve path.

## Goals

1. Fix the `/concepts/` list page so it stays fast and interactive at 5k-10k concepts.
2. Eliminate the Hugo dependency for concept rendering. Concepts become a fully CAP-owned subsystem, symmetrical with how tutorials work today.
3. Preserve SEO — every concept remains individually indexable via its detail page URL.
4. Ship with three layers of rollback so a bad render or a bad list page does not require a git revert.
5. DEV-only rollout. PROD cutover happens later (out of scope).

## Non-goals

- Refactor of the underlying `PublishedConcepts` projection or knowledge-graph data model.
- Any change to phase-4 link tables (learning journeys, blog posts, missions, videos, api docs, samples, help docs, community events).
- Any change to `/content/concepts/<slug>` serve path — reused as-is.
- PROD rollout.
- Deletion of legacy Hugo concept path in this project — it stays dormant. Cleanup is a follow-up.

## High-level shape

Two mostly independent workstreams, sharing only the `PublishedConcepts` read path and the `LEGACY_CONCEPT_RENDER` rollback flag.

### Thread A — List page virtualization

CAP takes over `/concepts/` (the list URL). A new endpoint `GET /content/concepts-index` reads `PublishedConcepts` on demand, renders a small shell HTML (top 100 cards for SEO/no-JS + full-list JSON embedded in a `<script type="application/json">` tag), gzips, caches in-process keyed on `ContentManifest.version`. The Vue island `hugo-apps/src/concepts-filter/App.vue` is rewritten to read the embedded JSON and use `vue-virtual-scroller`'s `RecycleScroller` to render only the ~40 visible cards as live DOM, with all filtering/sorting operating on the in-memory array.

Approuter route swap: `/concepts/?$` proxies to CAP instead of returning the static `hugo/public/concepts/index.html`.

### Thread B — CAP takeover for concept detail rendering

`publish-content.ts` gains a new phase between tutorial batches and commit that calls `POST /content/publish/render-concepts`. That endpoint reads `PublishedConcepts` + phase-4 tables, renders each concept via `srv/lib/templates/concept-detail.ejs`, gzips, appends `concept-<slug>` BLOBs to the same publish session using existing session helpers.

`scripts/fetch-concepts.ts` and `hugo/layouts/concepts/{list,single}.html` stay in the repo, guarded by `LEGACY_CONCEPT_RENDER=true` env / workflow input. Default is off (new path).

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      TODAY                                       │
├──────────────────────────────────────────────────────────────────┤
│ CI: fetch-tutorials → fetch-concepts → Hugo builds 5k .md into   │
│     hugo/public/concepts/<slug>/index.html + hugo/public/        │
│     concepts/index.html  ──►  approuter droplet (both files)     │
│                                                                  │
│ Then publish-content.ts uploads detail HTMLs to HANA (redundant  │
│ with droplet copy — CAP intercepts /concepts/<slug> anyway)      │
│                                                                  │
│ Approuter serves /concepts/  ← STATIC file with 5k <li>s inline  │
│ Approuter proxies /concepts/<slug> → CAP /content/concepts/:slug │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                       AFTER                                      │
├──────────────────────────────────────────────────────────────────┤
│ CI: fetch-tutorials → Hugo builds tutorials only                 │
│     (no concept .md, no concept HTML in droplet)                 │
│                                                                  │
│ publish-content.ts:                                              │
│   1. begin session                                               │
│   2. tutorials appendBatch × N (unchanged)                       │
│   3. NEW: POST /content/publish/render-concepts                  │
│      → CAP queries PublishedConcepts + phase-4, renders each     │
│        via srv/lib/templates/concept-detail.ejs, gzips,          │
│        appends concept-<slug> BLOBs to the session               │
│   4. commit                                                      │
│                                                                  │
│ Approuter:                                                       │
│   /concepts/?$  ─────►  CAP /content/concepts-index              │
│                          (SSR shell w/ top 100 + embedded JSON)  │
│   /concepts/(.*) ────►  CAP /content/concepts/$1 (unchanged)     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                    DORMANT (legacy)                              │
├──────────────────────────────────────────────────────────────────┤
│ scripts/fetch-concepts.ts (guarded by LEGACY_CONCEPT_RENDER)     │
│ hugo/layouts/concepts/single.html + list.html (kept, built)      │
│ Rollback: one PR flips the flag, next full rebuild uses Hugo     │
└──────────────────────────────────────────────────────────────────┘
```

### Component boundaries

- **`srv/lib/concept-list-page.js`** (new) — reads `PublishedConcepts`, builds the list JSON + shell HTML, owns the version-keyed in-process cache. One purpose: back `GET /content/concepts-index`.
- **`srv/lib/concept-detail-render.js`** (new) — pure function: given one `PublishedConcept` row + its phase-4 arrays + shell fragments, returns a gzipped HTML buffer. No I/O. Unit-testable.
- **`srv/lib/publish-concepts.js`** (new) — orchestrates the render-concepts phase during a publish session. Reads DB, calls `concept-detail-render`, writes to `ContentFiles` via existing session helpers.
- **`srv/lib/templates/concept-detail.ejs`** (new) — HTML template mirroring the current Hugo `single.html` layout, reusing the `__shell__` sidecar fragments already in HANA.
- **`hugo-apps/src/concepts-filter/App.vue`** (rewritten) — swaps DOM-toggle filtering for JSON-array filtering + windowed rendering via `RecycleScroller`.
- **`hugo-apps/src/concepts-filter/ConceptCard.vue`** (new) — extracted card component matching the current `<li>` DOM shape.

Everything else (`ContentFiles`, `serveHandler`, `contentAuthMiddleware`, `beginPublishSession` / `appendToSession` / `commitSession`, xs-app.json for `/concepts/<slug>`, existing `srv/lib/published-concepts-query.js`) is reused unchanged.

## Data flow + endpoints

### New CAP endpoints

**`GET /content/concepts-index`** (public, no auth)

Serves the list page HTML. Called by approuter passthrough from `/concepts/`.

1. Read `activeVersion` from `ContentManifest`.
2. Check in-process `listPageCache` keyed on `activeVersion`. Hit → return cached Buffer + ETag → `Cache-Control: public, max-age=300`, `ETag: "<manifestVersion>"`, `X-Content-Source: memcache`.
3. Miss → query `PublishedConcepts` for `{slug, title, description, teachesCount, requiresCount, tutorialCoverageCount}` only. No BLOB fetch. No phase-4 joins.
4. Sort by `title ASC` (matches today's Hugo `.ByTitle` default sort).
5. Render EJS shell template with:
   - `<head>` — canonical, OG tags, title, meta description (preserved from current Hugo layout).
   - `<main>` — search box + A-Z strip + sort dropdown chrome unchanged from current template.
   - `<ul id="concepts-list">` — top 100 cards as real `<li>` for SEO/no-JS. Ranking: PageRank-weighted via `ConceptRank` sidecar (already exists per #916). Fail open to alphabetical first 100 if `ConceptRank` is empty or query fails.
   - `<script type="application/json" id="concepts-data">` — full array (~5k objects) with the slim fields above.
   - `<noscript>` — "Showing 100 of N. Browse alphabetically:" + A-Z anchor links to a representative detail page per letter.
   - `<script src="/js/concepts-filter.js">` — the modified Vue island bundle.
6. Gzip the HTML → cache the gzipped Buffer + hash → serve.

Cost budget: cold ~150 ms end-to-end; warm ~1 ms + wire time. Cache invalidates naturally when `activeVersion` changes.

**`POST /content/publish/render-concepts`** (CONTENT_API_KEY auth, session-scoped)

Called by `publish-content.ts` after tutorial batches finish, before `commitSession`.

Request: `{ "sessionId": "…", "hugoVersion": "…" }`

1. Auth via existing `contentAuthMiddleware`.
2. Read `PublishedConcepts` (full projection — all fields `fetch-concepts.ts` writes today).
3. For each batch of 20 concepts:
   - Parallel query phase-4 tables for those 20 concept IDs (same queries `srv/lib/published-concepts-query.js` uses).
   - For each concept: assemble render context, run through `concept-detail.ejs`, gzip.
   - Compute SHA-256 of decompressed HTML, compare to `contentHash` of previous ACTIVE version's `concept-<slug>` row — skip if unchanged (same delta shape as tutorials).
   - Send the batch through existing `appendToSession` (`concept-<slug>` keys).
4. Return counts: `{ conceptsSeen, conceptsChanged, conceptsSkipped, durationMs }`.

Cost budget: ~30-60 s wall-clock for 5k concepts with 20-way concurrency + delta skip.

### Modified endpoints

**`GET /content/concepts/:slug`** — unchanged. Serves BLOBs written by the new render path exactly like the ones written by the old one.

**`POST /content/publish/commit`** — unchanged. New concept BLOBs went through `appendToSession` and are already in session state; commit promotes them like any other slug. Carry-forward handles slugs not present in the current delta.

### AppRouter route change (`approuter/xs-app.json`)

```diff
- {
-   "source": "^/concepts/?$",
-   "target": "/concepts/index.html",
-   "localDir": "static"
- },
+ {
+   "source": "^/concepts/?$",
+   "destination": "srv-api",
+   "target": "/content/concepts-index",
+   "authenticationType": "none"
+ },
  {
    "source": "^/concepts/(.*)$",
    "destination": "srv-api",
    "target": "/content/concepts/$1",
    "authenticationType": "none"
  }
```

Same swap applied for the QA channel route(s) if any exist for `/concepts-qa/*` — audit `xs-app.json` before shipping.

### `publish-content.ts` changes

New phase between tutorial batches and commit:

```
begin → tutorials appendBatch × N → renderConcepts (NEW) → commit
```

Under `LEGACY_CONCEPT_RENDER=true` the `renderConcepts` call is skipped (Hugo pipeline generates `.md`, builds HTML, uploads to HANA as today).

### `rebuild-content.yml` changes

- "Fetch published concepts" step — conditional on `LEGACY_CONCEPT_RENDER=true` input (defaults false). When false, skip the fetch step entirely and let CAP handle rendering.
- No change to slug-targeted mode gating — concept regen still tied to full and catalog-only modes.
- New workflow input `legacy-concept-render` (bool, default false) for the escape hatch.

## Template + Vue island rewrite

### `srv/lib/templates/concept-detail.ejs`

Mirrors `hugo/layouts/concepts/single.html` output byte-for-byte where possible.

```ejs
<!DOCTYPE html>
<html lang="en">
<head>
  <title><%= title %> - SAP Developers</title>
  <meta name="description" content="<%= description %>">
  <link rel="canonical" href="/concepts/<%= slug %>/">
  <meta property="og:title" content="<%= title %>">
  <meta property="og:type" content="article">
  <meta property="og:url" content="/concepts/<%= slug %>/">
  <%- shellHead %>
</head>
<body>
  <%- shellHeader %>
  <main class="concept-detail">
    <h1><%= title %></h1>
    <p class="concept-description"><%= description %></p>

    <% if (requires.length) { %>
      <section class="concept-prerequisites">
        <h2>Prerequisites</h2>
        <ul>
          <% requires.forEach(r => { %>
            <li><a href="/concepts/<%= r.slug %>/"><%= r.title %></a></li>
          <% }) %>
        </ul>
      </section>
    <% } %>

    <% ['teaches', 'requiredBy', 'relatedTo'].forEach(kind => { /* similar */ }) %>

    <% ['learningJourneys', 'blogPosts', 'discoveryMissions', 'videos',
        'apiDocs', 'samples', 'helpDocs', 'communityEvents'].forEach(section => {
      /* iterate section arrays, emit link cards */
    }) %>
  </main>
  <%- shellFooter %>
</body>
</html>
```

`shellHead / shellHeader / shellFooter` are read from the existing `__shell__` sidecar in `ContentFiles` (which `publish-content.ts` writes on the first tutorial batch). This is what preserves visual parity: same nav, footer, CSS, JS bundles as the rest of the site. No CSS to port.

**Data escaping.** All user-visible fields use EJS `<%=` (HTML-escaped). Raw interpolation (`<%-`) is only for the shell fragments (which are trusted HTML from HANA). Description and title are treated as plain text; any legitimate HTML in a concept must be added to the template, not the data.

### `hugo-apps/src/concepts-filter/App.vue` rewrite

Current shape: reads DOM `<li>`s emitted by Hugo, toggles `hidden` for filtering, `appendChild` for sorting. All operations walk the full DOM (~5k nodes).

New shape:

```
onMount:
  1. Read <script id="concepts-data"> → JSON.parse → allConcepts array
  2. Compute derived indexes (A-Z buckets, coverage-sorted array) — one-time
  3. Remove the SSR'd top-100 <li>s (they were for crawlers/no-JS only)
  4. Render windowed slice into #concepts-list via RecycleScroller

watch(searchQuery, sortMode, activeLetter):
  1. Filter allConcepts array in-memory via filter-logic.ts (~5k items = <5 ms)
  2. Update visibleSlice → RecycleScroller re-renders ~40 DOM nodes

Scroll handler: RecycleScroller owns this natively
```

- **Virtualization library**: `vue-virtual-scroller`'s `RecycleScroller`, already in root `package.json` (used by Analytics Explorer). Added to `hugo-apps/package.json`.
- **Card component**: extract current `<li>` shape from `hugo/layouts/concepts/list.html` into `ConceptCard.vue`. Same DOM, same classes, same `data-*` attrs — existing CSS keeps working.
- **Item height**: fixed at ~140 px (measure and pin, don't let it be dynamic — huge perf win on virtual scrollers).
- **Filter logic**: `filter-logic.ts` already exists as a DOM-free pure function. Extended to accept the JSON array shape. Existing tests port with minimal changes.
- **URL sync, A-Z jump, count updater, clear-all button**: keep working, operating on the array.

### No-JS fallback

- SSR'd top 100 cards are real HTML — Ctrl-F works, browsing works.
- `<noscript>` block shows "Showing 100 of N. Browse alphabetically:" + one link per letter to a representative concept detail page. From that detail page users navigate via existing `requires`/`teaches` links.
- Real users with JS see all N concepts via virtualization.

### Which 100 land in the SSR'd shell

PageRank-weighted top 100 from `ConceptRank` (the sidecar already populated by #916's nightly job). Fail open to alphabetical first 100 if the sidecar query fails or returns empty. Same fail-open pattern as `KG_PAGERANK_ENABLED`.

## Error handling

| Failure | Where | Behavior |
|---|---|---|
| `PublishedConcepts` query fails (HANA down) on `GET /concepts-index` | `concept-list-page.js` | Return last-known-good cached Buffer if any exists (even across manifest versions). Else 503 with a static "Concepts temporarily unavailable" HTML page. Log `concept_list_query_failure` metric. |
| Phase-4 query fails for one batch during `render-concepts` | `publish-concepts.js` | Abort the whole session (`abortHandler`). Publish fails atomically. Log `concept_render_batch_failure` with the failing concept slugs. Retry safe on next publish. |
| Template render throws for one concept | `concept-detail-render.js` | Log `concept_render_error` with slug + error. Skip that concept — leave previous version's BLOB in place via carry-forward. Publish continues. If >5% of concepts skip in one publish, abort the session (treat as corrupt run). |
| ETag mismatch on concept BLOB write | `content-publish-session.js` | Existing tutorial path handles this. No change. |
| `LEGACY_CONCEPT_RENDER=true` and `fetch-concepts.ts` also fails | Hugo build | Job fails, deploy blocks, revert PR. Standard CI behavior. |
| Vue island fails to hydrate (JSON parse error) | Client | SSR'd top 100 cards + `<noscript>` fallback remain visible. Log to console. User sees a degraded but functional page. |

### Edge cases

- **Concept with zero phase-4 links** — renders `<h1>` + description only. Empty sections omitted (`<% if (arr.length) %>`).
- **Concept description with HTML** — escaped via EJS `<%=`. Description is plain text from the DB.
- **Concept slug with unicode** — already lowercase-canonical in the DB. Template does no re-encoding. Existing `serveHandler` slug canonicalization handles URL edge cases.
- **`__shell__` sidecar not yet published** — render-concepts phase runs **after** all tutorial batches complete (which include the shell sidecar in batch 1). If shell hasn't landed yet, `concept-detail-render.js` throws → session aborts.
- **Concept count is 0** — list page renders a "No concepts yet" empty state. No SSR'd cards, no JSON blob. Vue island renders empty state too.
- **Concept added between list-page cache fill and detail-page click** — user clicks a card, detail page hits `serveHandler`, 404s. Natural race, already handled by tutorials the same way. Fixes on next publish.
- **Delta short-circuit** — same SHA-256 hash comparison as tutorials (#672 short-circuit in `publish-content.ts`). New concepts render every publish; unchanged concepts skip.
- **CAP restart wipes in-process list-page cache** — first request per instance per manifest version pays cold cost. Cloud Foundry rolling restarts mean up to N instances × ~150 ms cold hits per deploy. Acceptable.
- **Publish partially fails mid-render-concepts** — abort deletes session state. Previous ACTIVE manifest still serves everything. Concepts stay at previous version.

## Rollback mechanics (three layers)

### Layer 1 — Config flag rollback (no code change)

Setting `legacy-concept-render=true` on the next `rebuild-content.yml` run reverts to Hugo generation for that publish. `publish-content.ts` skips the `render-concepts` phase call. Hugo pipeline produces the `.md` → HTML → publish uploads to HANA as before. AppRouter serves whatever's in HANA — same slugs, same route. No AppRouter or CAP code change needed.

Caveat: `/content/concepts-index` still exists and still serves from `PublishedConcepts`. The list page shape stays "new" even under this rollback. That is intentional — the list page issue is separate from detail-page rendering.

### Layer 2 — List page rollback

If the list page has issues (SSR bug, Vue island crashes), one PR reverts the `approuter/xs-app.json` `/concepts/?$` route back to `/concepts/index.html` (static). `hugo/layouts/concepts/list.html` continues to build in Hugo (a few KB), it just isn't served under normal operation.

### Layer 3 — Full nuclear rollback

`git revert` the PR + redeploy. Detail pages continue to serve from HANA (the `concept-<slug>` BLOBs are still there from prior publishes — the revert doesn't wipe them). List page reverts to static. `render-concepts` endpoint is gone. Everything back to today's shape.

### Artifact fates

| Artifact | Fate |
|---|---|
| `scripts/fetch-concepts.ts` | Guarded (`if (process.env.LEGACY_CONCEPT_RENDER !== 'true') process.exit(0)` early exit unless true). Kept. |
| `hugo/layouts/concepts/list.html` | Kept as-is (still built by Hugo, not served by default). |
| `hugo/layouts/concepts/single.html` | Kept as-is (built by Hugo under legacy flag). |
| `hugo/content/concepts/*.md` | Not generated by default. Under legacy flag, regenerated as today. |
| `hugo-apps/src/concepts-filter/App.vue` | **Rewritten**. Old logic in git history — revert if needed. |
| `hugo-apps/src/concepts-filter/filter-logic.ts` | Extended, tests updated. |
| `srv/lib/published-concepts-query.js` | Unchanged. Reused by new `publish-concepts.js`. |
| `srv/server.js` | Adds `/content/concepts-index` and `/content/publish/render-concepts` route registrations. Keeps `/content/concepts/:slug`. |

## Testing

### Unit tests

- **`test/unit/concept-detail-render.test.js`** — golden-file assertions on ~10 fixture shapes. Empty arrays omitted. Unicode escaping. Missing shell fragment → clear error.
- **`test/unit/concept-list-page.test.js`** — SSR'd top 100 correct count. JSON blob has expected slim shape. `<noscript>` block present. Empty-state case. Cache identity across same-version calls.
- **`test/unit/publish-concepts.test.js`** — 20-item batching. Delta short-circuit. Batch failure → abort, no partial writes. Metrics emitted.
- **`hugo-apps/src/concepts-filter/App.test.ts`** (rewritten) — reads JSON, filter/sort work on array, URL sync, empty state. Does NOT test `RecycleScroller` itself.
- **`hugo-apps/src/concepts-filter/filter-logic.test.ts`** (updated) — existing tests port to JSON array shape.

### Hybrid tests (real HANA via `cds bind`)

- **`test/hybrid/concept-render-hybrid.test.js`** — publish end-to-end against hybrid HANA with 3-5 real concepts. Asserts `concept-<slug>` BLOBs land in `ContentFiles`, `ContentManifest` advances, carry-forward works. Asserts `GET /content/concepts/<slug>` returns unzipped HTML matching template. Asserts `GET /content/concepts-index` returns valid shell containing expected slugs. Guards LOB-alongside-metadata regression.

### Snapshot parity test (merge gate)

- **`test/snapshot/concept-parity.test.js`** — 10 hand-picked slugs in `test/fixtures/concept-parity-slugs.json` (varied shapes). Fetches Hugo output from DEV. Renders same slugs via new pipeline. Diffs, allowing an explicit list of expected diffs (render-source marker, whitespace inside `<script>` blobs). Fails PR if unexpected diffs appear. **Required PR check.**

### Smoke tests (post-deploy)

- **`test/smoke/concepts-page.test.js`** — `GET /concepts/` returns 200, `Content-Type: text/html`, gzipped size < 2 MB. Response contains `<script id="concepts-data">` with a JSON array of expected length. SSR'd `<li>` count is exactly 100 (or PublishedConcepts count, whichever smaller). `GET /concepts/cap/` returns 200. Cache header assertions. Response time p50 < 200 ms cold, < 30 ms warm.

### Load characterization (pre-cutover, not a merge gate)

`hyperfine` run against DEV: 100 sequential `GET /concepts/`, cold → warm. Document actual p50/p95 in the PR description. Block cutover if p95 > 300 ms cold pending investigation. Same for `GET /concepts/<slug>` — should be indistinguishable from tutorial detail pages.

### Regression coverage

- Full `npm test` — should be green with zero changes (underlying data model untouched).
- Existing concept detail-page tests in `srv/lib/content-store.test.js` — `concept-<slug>` serve path is unchanged.
- Full `npm run test:hybrid` — should be green.

## Rollout order

Six landings, each independently mergeable and safe to deploy. Anything can be paused between steps without leaving the site in a bad state. All target DEV only.

### Step 1 — `GET /content/concepts-index` (dark launch)

Ship:
- `srv/lib/concept-list-page.js` + template
- `srv/server.js` registers `/content/concepts-index`
- Vue island rewrite (`App.vue`, `filter-logic.ts`, new `ConceptCard.vue`, `vue-virtual-scroller` dep)
- Unit tests + hybrid test for the endpoint
- **AppRouter route NOT flipped yet**

Verify: hit `https://<dev-srv-url>/content/concepts-index` manually — note that direct-to-CAP requests will render unstyled since approuter is not in the loop (relative asset paths, no shell rewrites). Structure verifiable from view-source. Assert p50/p95 numbers via `hyperfine`.

Rollback: revert PR. Zero user impact.

### Step 2 — Flip the AppRouter route

Ship:
- `approuter/xs-app.json` `/concepts/?$` → `/content/concepts-index`
- Deploy DEV
- Smoke test verifies the swap

Verify: production DEV page loads, all N concepts visible via search, A-Z jump works, virtualization smooth on mobile emulation.

Rollback: one-line xs-app.json revert, redeploy. `hugo/public/concepts/index.html` is still in the droplet.

### Step 3 — `POST /content/publish/render-concepts` (dark launch)

Ship:
- `srv/lib/publish-concepts.js` + `concept-detail-render.js` + `templates/concept-detail.ejs`
- `srv/server.js` registers `/content/publish/render-concepts`
- Unit tests + hybrid test
- **`publish-content.ts` NOT updated yet** — endpoint reachable but no CI caller

Verify: manually invoke against DEV with a small session, confirm 5-10 concept BLOBs land in `ContentFiles`, verify BLOB rendering, run snapshot parity test locally.

Rollback: revert PR. Zero user impact.

### Step 4 — Snapshot parity test passes

Ship:
- `test/snapshot/concept-parity.test.js` + fixtures
- Run against DEV. Fix template diffs if any. Mark test as required PR check.

Verify: test is green.

Rollback: N/A (test only).

### Step 5 — Wire `publish-content.ts` to call `render-concepts`

Ship:
- `publish-content.ts` `renderConceptsPhase` call between tutorial batches and commit
- Guarded by `LEGACY_CONCEPT_RENDER` env — default off (new path)
- `scripts/fetch-concepts.ts` early-exit unless `LEGACY_CONCEPT_RENDER=true`
- `rebuild-content.yml` gains `legacy-concept-render` workflow input (default false)
- Hugo layouts + fetch script preserved but dormant

Verify:
- Run `rebuild-content.yml` on DEV with default inputs — new path runs, concept BLOBs get written by CAP, list page reflects fresh data.
- Compare sample DEV detail pages against pre-cutover snapshot — visually identical.
- Time full rebuild — should be shorter than today (no 5k Hugo pages).
- Run once with `legacy-concept-render=true` to verify escape hatch.

Rollback:
- Immediate: rerun `rebuild-content.yml` with `legacy-concept-render=true`.
- Nuclear: revert PR + redeploy.

### Step 6 — Bake time + cleanup (deferred, not this project)

2 weeks of DEV stability observed. Follow-up PR eventually deletes `scripts/fetch-concepts.ts`, `hugo/layouts/concepts/*.html`, and the `LEGACY_CONCEPT_RENDER` branches (~200 lines net deletion). Own PR when confident.

### Deploy pattern per step

Each step: PR → merge → local `npm run build:all && cd .deploy && mbt build && cf deploy` from primary tree on `main`. Standard project deploy shape.

### Never rolled out to PROD in this project

Everything above targets DEV only. PROD cutover end-of-July 2026 is out of scope.

## Metrics

Wire into existing metrics module (`docs/developers/architecture/observability.md`):

- `concept_list_render_ms` (histogram) — list page render latency
- `concept_list_cache_hits` / `concept_list_cache_misses` (counters)
- `concept_render_ms` (histogram) — per-concept render latency in publish path
- `concepts_rendered_total` / `concepts_skipped_total` (counters per publish)
- `concept_list_query_failure` / `concept_render_batch_failure` / `concept_render_error` (counters)

## Open questions

None at design close. Any surface changes during implementation get raised on the PR.

## References

- `docs/developers/architecture/build.md` — content pipeline, parsers
- `docs/developers/operations/testing-endpoints.md` — canonical endpoint reference
- `docs/developers/operations/rebuild-content-workflow.md` — three rebuild modes
- `docs/developers/reference/tutorials-ims-gotchas.md` — LOB-alongside-metadata, publish flags
- `srv/lib/content-store.js` — reference implementation of tutorial serve path
- `srv/lib/published-concepts-query.js` — reference implementation of the PublishedConcepts query
- `scripts/publish-content.ts` — reference implementation of the publish session client
- Issue #672 — source-hash short-circuit for delta publishes
- Issue #916 — `ConceptRank` sidecar (source for top-100 SSR ranking)

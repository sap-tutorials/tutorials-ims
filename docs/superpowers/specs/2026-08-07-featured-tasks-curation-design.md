# Featured Tasks Curation → Tutorial Navigator — Design

**Date:** 2026-08-07
**Status:** Approved (design), pending implementation plan
**Surfaces:** Admin UI (`/admin-ui/#/operations` → Featured Tasks) + Tutorial Navigator (`/tutorial-navigator/`)
**Out of scope:** Homepage (keeps its existing concept-based `featured-topics-carousel`, #1032)

## Problem

The `FeaturedTasks` admin tile at `#/operations` shows an empty table with no Create
button, and the curated list it would produce is only weakly wired into the site
(`/learn/` curated-paths + the 404 popular-rail). Two gaps:

1. **No usable curation UI.** `AdminService.FeaturedTasks` is not `@odata.draft.enabled`,
   so Fiori Elements renders no Create/Edit/Delete. The stored shape
   (`taskLegacyId` : Integer + `taskType` + `featuredOrder`) is title-less and unfriendly
   to hand-edit even if Create existed.
2. **Not wired into the Tutorial Navigator.** The navigator's "Featured missions"
   `<section>` (`hugo/layouts/tutorial-navigator/list.html:64`) renders `first 6` missions
   in Hugo page order — it does **not** read `FeaturedTasks`. Legacy IMS surfaced the
   admin-curated featured list here; this is the parity target.

## Goal

Make `FeaturedTasks` fully curatable through the existing FE tile, and render the curated
list (mixed tutorial/mission/group, in curated order) in the Tutorial Navigator's Featured
section — SSR at build time, rehydrated live (~60s) without a rebuild, with an auto-pick
fallback when the curated list is empty.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Curation UX | Native FE ListReport: value-help pick by title + editable order column |
| Item types | Mixed — tutorials, missions, AND groups |
| Empty fallback | Auto-pick fallback preserved (never blank the section) |
| Freshness | Live rehydrate (~60s) via a public build endpoint + ETag |
| Homepage | Out of scope — navigator only |

## Architecture

```text
Admin (FE ListReport, draft)         Build time                    Runtime (navigator page)
─────────────────────────────       ────────────────────          ──────────────────────────
FeaturedTasks (draft CRUD)           GET /build/catalog            SSR: browse.json.featured[]
  taskType + taskLegacyId  ──┐         → resolveFeatured()           → card-{mission,group,tutorial}.html
  featuredOrder              │         → featured[] (top 6)        Rehydrate: GET /build/featured
  value-help: FeaturedTask   │       writeBrowseData()               → ETag/304, 60s cache
    Candidates (union view)  │         → browse.json.featured[]      → replace section cards if changed
                             │
  on save → resetFeaturedCache()  (in-process cache bust, mirrors resetFtCache)
```

### Component 1 — Admin curation UI (`app/admin/operations/` + annotations)

- **Enable draft:** add `@odata.draft.enabled` to `entity FeaturedTasks` in
  `srv/admin-service.cds` (mirrors `Alerts` on the same service). FE then renders
  Create/Edit/Delete/Save on the existing `FeaturedTasksList` target.
- **Value-help by title:** the stored key is `taskLegacyId` (Integer) + `taskType`, which
  is title-less. Add a read-only helper projection to `AdminService`:

  ```cds
  // Union candidate list for the FeaturedTasks value help. Read-only, unpaged-safe
  // (bounded by content volume). taskLegacyId + taskType together identify a row.
  @readonly @cds.persistence.skip
  entity FeaturedTaskCandidates {
    key taskLegacyId : Integer;
    key taskType     : String(20);   // TUTORIAL | MISSION | GROUP
        title        : String;
        slug         : String;
  }
  ```

  Backed by an `on('READ')` handler in `srv/admin-service.js` that UNIONs
  `Tutorials` + `Missions` + `Groups` (legacyId, title, slug), honoring `req.query`
  search/`$filter` so type-ahead works. `@cds.persistence.skip` because it's a
  runtime-computed union, not a table (see [[cap10-before-read-results-empty-no-shortcircuit]]
  — the `on('READ')` must honor `req.query`, not return `[]` early).
- **Annotate the picker** in `app/admin-annotations.cds` (replace the current plain
  `taskLegacyId` label block): `taskLegacyId` gets `@Common.ValueList` on
  `FeaturedTaskCandidates` with **two** `ValueListParameterInOut` params
  (`taskLegacyId` + `taskType`) so choosing a title fills both keys, plus
  display-only `title`/`slug`. Keep `taskType` shown (read-only after pick) and
  `featuredOrder` editable.
- **Order default:** `before('CREATE', FeaturedTasks)` sets `featuredOrder = max+1`
  when the field is empty, so admins normally don't type it. Reuses the `max+1`
  intent from legacy `setFeaturedOrder`.
- **Uniqueness:** add `@assert.unique.feature: [taskLegacyId, taskType]` on the entity
  so the same item can't be featured twice. NB this is CAP-runtime only, not a DB
  constraint (cf. [[concepts-slug-assert-unique-not-a-db-constraint]]); acceptable here
  because all writes go through the service layer (no raw-SQL writer for FeaturedTasks).
- **Cache bust:** `after('SAVE', FeaturedTasks)` (draft activate) + `after('DELETE')`
  call a new `resetFeaturedCache()` exported from the build layer.

### Component 2 — Live endpoint `GET /build/featured`

- New public handler registered in `srv/server.js` alongside `/build/featured-topics`
  (bootstrap-registered, pre-auth — public by design like `/build/catalog`).
- Returns the **resolved** featured list only (not the whole catalog):
  `{ featured: [{ type, slug, title, description }], etag, computedAt }`.
  Reuses `resolveFeatured()` from `srv/lib/build-catalog.js` (extract the featured-only
  query + resolve into a small shared helper so the handler and `buildCatalogHandler`
  don't diverge).
- **ETag + 60s in-process cache + 304**, modeled exactly on `featuredTopics()`
  (`srv/homepage-service.js:788`) and `_getFeaturedTopicsPayload`. ETag is a hash of
  the resolved slug+order list. Cache invalidated by `resetFeaturedCache()`.
- Rationale for a dedicated endpoint over reusing `/build/catalog`: the catalog payload
  is large (all missions/tutorials/groups); the navigator only needs ≤6 resolved cards.

### Component 3 — Navigator surface (`hugo/`)

- **SSR:** rewrite the Featured `<section>` in `hugo/layouts/tutorial-navigator/list.html`
  to iterate `browse.json`'s `featured[]` (already emitted by `writeBrowseData`) and
  dispatch on `type` to the shared `browse/_partials/card-{mission,group,tutorial}.html`
  partials — same partials the SSR grid + `/browse/` use, keeping card markup in lockstep.
  The section sits **outside** `#tutorial-navigator`, so the Vue island never overwrites it.
- **Fallback:** when `featured[]` is empty, render today's `first 6`
  `where .Site.RegularPages "Type" "missions"` block, so the section is never blank on a
  fresh/empty table.
- **Rehydrate:** add a small standalone script (pattern:
  `hugo/static/js/popular-rail.js`) that on load fetches `/build/featured` with
  `If-None-Match`, and on a changed ETag rebuilds the section's cards client-side
  (type-aware href: `/tutorials/<slug>` for tutorial, `/<type>s/<slug>/` for
  mission/group). Fail-silent: keep SSR content on any error/304. Loaded via a
  `<script defer>` from the navigator layout. No change to the navigator Vue island.
- **QA channel:** the section must respect the QA base paths already handled in this
  layout (`data-search-base`/`data-nav-base` when `site.Params.qa`), and read
  `data-qa/browse.json` on the QA channel. The rehydrate script reads the base from a
  `data-*` attribute rather than hardcoding `/tutorials/`.

## Error handling

- Value-help union READ failure → return `[]` (empty picker), never 500.
- `/build/featured` DB failure → 500 with logged message (consistent with other
  `/build/*` handlers); the navigator keeps SSR content because the rehydrate script
  fail-silents.
- Empty curated list → auto-pick fallback (SSR) + rehydrate no-ops.
- Unresolvable curated row (e.g. unpublished mission) → `resolveFeatured` already returns
  `null` and is `.filter(Boolean)`'d out.

## Testing

- **Unit** (`test/`):
  - `resolveFeatured` mixed-type resolution + null-drop for unresolvable rows.
  - `FeaturedTaskCandidates` union READ: search filter honored, all three types present,
    shape `{ taskLegacyId, taskType, title, slug }`.
  - `before(CREATE)` order default = max+1 (and respects an explicit value).
  - ETag stability: same list → same ETag; reorder → different ETag.
- **Hybrid** (`test/hybrid/`, `--project hybrid`):
  - draft SAVE → `resetFeaturedCache()` → `/build/featured` returns fresh ETag.
  - `@assert.unique.feature` rejects a duplicate `(taskLegacyId, taskType)`.
- **E2E** (`test/e2e/`, committed spec per #1378 rule): admin creates a featured item via
  value-help on `#/operations`; assert `/build/featured` includes it; assert the navigator
  Featured section renders its card after rehydrate.
- **Schema gate:** `npx cds deploy --to sqlite::memory:` before committing the `.cds`
  changes (runtime-only asserts don't fail at build otherwise — see memory).

## Files touched (anticipated)

- `srv/admin-service.cds` — `@odata.draft.enabled`, `@assert.unique.feature`,
  `FeaturedTaskCandidates` entity.
- `srv/admin-service.js` — candidates union READ handler, CREATE order default,
  SAVE/DELETE cache-bust hook.
- `app/admin-annotations.cds` — value-help annotation on `taskLegacyId`.
- `app/admin/operations/webapp/manifest.json` — confirm Create enabled on the target
  (draft flag drives it; likely no manifest change needed).
- `srv/lib/build-catalog.js` — extract shared featured-resolve helper +
  `resetFeaturedCache()` + cache.
- `srv/server.js` — register `GET /build/featured`.
- `hugo/layouts/tutorial-navigator/list.html` — SSR Featured section from `browse.json`.
- `hugo/static/js/featured-rail.js` (new) — live rehydrate.
- Tests as above.

## Open items for the plan

- Confirm whether `Groups` slug vs `CompletionPaths` is the right source for GROUP
  candidates (build-catalog resolves GROUP via `pathByLegacyId`, keyed on
  `CompletionPaths.legacyId`, name from path). The candidates union must match that
  resolution or picks won't resolve.
- Confirm `admin-ui` bundle-gating: annotation/manifest changes ship via the approuter
  raw-copy, so this needs a FULL `mbt build` deploy (no `--skip-build`/`-m`) and a
  `sap.app.applicationVersion` bump for IndexedDB cache (see memory).

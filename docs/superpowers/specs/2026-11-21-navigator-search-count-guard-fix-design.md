# Navigator search: count-guard fix + pinned selected filters (#3112 follow-up)

**Date:** 2026-11-21
**Issue:** sap-tutorials/tutorials-ims#3112 (follow-up comment 2026-11-18 by `thecodester`)
**Supersedes the search half of:** `2026-11-12-navigator-search-filter-improvements-design.md` (PR #3123, merged + promoted to `main` 2026-11-12) — whose G2 fix did not work in PROD.

## Intent and why

Issue #3112's follow-up (2026-11-18) reports that search **still** drops missions in
production, five days after PR #3123 ("fully delivered in production and live") merged and
promoted. Tom's repro: on `/tutorial-navigator/?...&q=Device` the mission lozenge shows a
count but no mission card renders. He also restated the filter ask: selected filters should
be visible **outside** the scrolling facet box, not merely floated to the top inside it. He
confirmed the completed-tutorials filter is good and de-prioritized the filter-visibility ask
("not really that important"), but it is cheap and worth doing.

The point of this work: make a matched mission actually render in the search grid, and keep
the selected filters in view.

## Root cause (proven, not theorized)

The #3123 design attributed the dropped mission to three things — low mission rank, missing
search-mode pagination, and `getFacets` ignoring `$filter` — and fixed all three. **None was
the cause.** The real cause is a single guard:

```
srv/search-service.js:283   if (!sel || sel.count) return;   // before('READ', SearchableItems)
```

The island's cards query **always** sends `$count=true` (`hugo-apps/src/navigator/useSearch.ts:201-212`;
no `$select`, no `$orderby`). In CAP 10.2.2 the OData adapter dispatches `$count=true` as a
**single** `READ` with `SELECT.count` truthy on the same query object (`@sap/cds` `libx/odata/middleware/read.js:262`,
grammar `:906`); the db-service derives the count by cloning that **already-processed** query
(`@cap-js/db-service` `SQLService.js:170-172, 336-361`). So the guard makes the `before('READ')`
hook bail on **every** island search, which means:

- `applyWordBoundarySearch` never runs → `sel.search` survives → CAP's default `$search`
  translation fires (broad, wrong match-set: **count 91**, not the word-boundary **56**).
- `attachSearchRank` never runs → no `_searchRank` column, no `_searchRank DESC` orderBy →
  **raw UNION-ALL view order**; `searchScore` is `null` on every row.
- The mission that would rank **#0 (score 7 = 3 title + 2 desc + 2 type-boost)** is buried
  behind ~80 concepts, past the `$top=48` page → "counted but never shown."

The #3123 rank boost (`search-service.js:214`) is correct but **dead code** on the live path,
because this guard shadows it.

### Proof (PROD, developers.sap.com, 2026-11-21)

| Request | Count | Order | Mission |
|---|---|---|---|
| `$search=Device&$top=48&$count=true` (island shape) | 91 | raw (searchScore null ×48) | absent |
| `$search=Device&$top=48` (no `$count` → hook runs) | 56 | ranked | **#0, score 7** |

### What is NOT broken (verified, so do not "re-fix")

- **getFacets product-mirroring already works.** `getFacets(search='Device', products=['software-product>sap-build-apps'])`
  returns totalCount 1 / TUTORIAL:1 / **no mission** — agrees with the items query under the
  same filter (count 1, TUTORIAL only). #3123 wired `products`/`isNew` into `getFacets`
  (`search-service.js:559-564`) and it functions. Bug "B" (lozenge ≠ grid under a product
  filter) does **not** reproduce today; Tom's 2026-11-18 screenshot predates that wiring
  reaching PROD or shows a stale lozenge. We lock it with a regression test, not a new fix.

## Goals / non-goals / anti-goals

**Goals**
- G1 — A mission/group that matches a free-text query **renders in the grid**, at its ranked
  position, on the island's real request shape (`$search=…&$top=48&$skip=0&$count=true`).
- G2 — The `@odata.count` returned for that request reflects the **word-boundary** match-set
  (the 56-set), not CAP's default-`$search` 91-set, so the pager total is honest.
- G3 — Selected facets are visible **outside** the capped scroll box, in all applicable
  columns, removed by clicking the pinned chip.

**Non-goals**
- Changing what counts as a match (the word-boundary tokenization, stopwords, KG/community
  rerank). Match semantics stay identical.
- Re-touching `getFacets` filtering (already correct).
- The homepage `/` flip or `/browse/` (shares the composable but not this bug).

**Anti-goals**
- Do **not** add `_searchRank` to a `COUNT(*)` projection — the guard's original concern
  (comment `search-service.js:281-282`) is real: a count-clone keeps `columns`, so a pushed
  rank column could break the count SQL.
- Do not make the count honest in the wrong direction (render a non-matching mission, or
  double-count).

## Constraints

- CAP `@sap/cds` 10.2.2; UNION-ALL view `SearchableItems` (`db/views.cds:98-166`).
- `searchScore` is a virtual (`srv/search-service.cds:61`) populated only by the after-hook
  from `_searchRank`.
- Must not regress `getFacets`, the MCP `search_tutorials`/semantic-search paths, or internal
  `srv.run(SELECT…search…)` callers (which arrive with no `sel.columns` → `attachSearchRank`
  already self-bails at `:232`).
- Full suite is hook-blocked locally; scope tests with `npm test -- <file>`. e2e is post-deploy
  only (`test/e2e/navigator-search-filter.spec.ts`).

## Approaches considered

1. **Surgical guard split (CHOSEN).** Apply `applyWordBoundarySearch` (the *filter*) on all
   reads, including when `sel.count` is truthy; gate only `attachSearchRank` (the *column +
   orderBy*) behind `!sel.count`. The count-clone keeps the `.where` from the filter (so count
   = 56, honest) and drops `orderBy`/`limit`; the data read gets both filter and rank. Smallest
   change, preserves the guard's real intent (no rank column on a count projection), fixes G1+G2
   together.
   - *Trade-off:* relies on CAP keeping `where` (not `orderBy`) in the count-clone — verified in
     SQLService.js and reproducible via the no-`$count` repro. A future CAP change to count-clone
     behavior would need a re-check; pinned by a hybrid test.

2. **Remove the guard outright.** Let rewrite + rank run on every read. Simpler diff, but pushes
   `_searchRank` into `sel.columns` on the count path — exactly what the "MANDATORY" comment
   warns against; risks a `COUNT(*)`-projection SQL error on HANA. Rejected.

3. **Client-side: stop sending `$count`, derive total from a separate count call.** Moves the
   fix to `useSearch.ts`. Larger blast radius (pager math, two round-trips), and leaves the
   server hook wrong for any other `$count` caller. Rejected.

**Chosen: Approach 1.**

## The how (decided)

### Server — `srv/search-service.js`, `before('READ', SearchableItems)` (~:279-323)

- Replace `if (!sel || sel.count) return;` with `if (!sel) return;`. The existing phrase guard
  (`:285-287`) already short-circuits any read with no usable `$search` phrase, so a plain
  `$count` with no search term stays untouched.
- Keep `applyWordBoundarySearch(req.query, phrase)` unconditional (runs for count + data).
- Wrap the KG/community fragment computation (`:291-320`) and the `attachSearchRank(…)` call
  (`:322`) in `if (!sel.count) { … }`, so the rank column + orderBy are added **only** on the
  data read, never the count projection. Skipping KG/community on the count path is also a free
  latency win.
- `after('READ')` (`:251-268`) is unchanged — on the count path it early-returns on the numeric
  result (`:253`).

### Server — no change to `getFacets` (already correct). Add a regression test only.

### Client — `hugo-apps/src/navigator/*` + `hugo/assets/css/home.css`

- G3 pinned selected filters: render a **per-column** selected-chips block **above** each
  `.filter-list` (inside `<section class="navigator-filters">`, `TutorialNavigator.vue:391-476`),
  driven by the existing `filters.topics/products/levels/types` arrays; each chip removes its
  selection via the existing `toggleFilter`/`toggleProduct`.
- **DECIDED (Tom, 2026-11-21): one PR, filters at this default.** No pre-mock gate — Tom
  reviews the UI on the PR itself. Per-column (not one global bar) to preserve which dimension
  a selection belongs to.
- **Keep** the in-list `partitionSelected` float. Dropping it would break the existing G1 e2e
  assertion (which checks selected items float to the top of the list); keeping it costs
  nothing and the pinned block sits above it. So the pinned chips are additive, not a
  replacement.
- CSS: a `.filter-selected-pins` row above `.filter-list`, chips styled with existing Horizon
  tokens; no change to the `max-height` cap.

### What's left to the builder

- Exact chip markup/ARIA (follow Horizon token conventions already in `home.css`).

## Verification

- **Spike first (builder, ~20 min):** confirm whether the in-memory **SQLite** unit harness
  reflects the hook's `.where` on a combined `$search`+`$count=true` request (the existing suite
  `test/search-service.test.js:125-188` drives the real OData adapter over SQLite but never
  combines the two). If SQLite's count-clone picks up the filter, the honest-count (G2)
  assertion is unit-testable; if not, G2's count assertion lives **only** in the hybrid test.
  Do not promise a local count assertion until the spike settles this.
- **Unit (scoped):** `npm test -- test/search-service.test.js` — assert `before('READ')` applies
  the word-boundary filter when `sel.count` is truthy and does **not** push `_searchRank` onto a
  count projection (no SQL error, no rank column in the count path). Count-value assertion only
  if the spike proves it observable on SQLite.
- **Hybrid (real HANA, authoritative for counts):** assert `$search=Device&$top=48&$count=true`
  → `@odata.count` **56** and a MISSION present at searchScore 7 within the first page; assert
  the product-filtered case (`primaryTag eq 'software-product>sap-build-apps'`) stays
  TUTORIAL-only. Also assert the server `@odata.count` and the getFacets-derived lozenge count
  for the same query **agree** (Q4 — after the fix both should be the word-boundary 56-set; a
  residual mismatch would be a new off-by-set bug).
- **e2e (must flip red→green, not self-skip):** update
  `test/e2e/navigator-search-filter.spec.ts:106-173` (G2) to search **`Device`** (the proven
  repro), not the generic `SAP`. `Device` is known to match a mission that pre-fix sorts past
  `$top=48` and post-fix ranks #0. Tighten the assertion so a mission card MUST be visible when
  the lozenge ≥ 1 (keep that invariant) — but the term choice is what makes the test actually
  exercise the bug. Verify locally that the pre-fix tree fails this and the post-fix tree passes.
- **Manual PROD-parity curl** (pre/post deploy to DEV): the two-row proof table above.

## Rollout

- Branch from fresh `origin/DEV`; PR → `DEV` (not `main`; no main-hotfix path).
- Server fix is behind no flag (a straight correctness fix on an existing path); ship with the
  e2e + hybrid assertions green on DEV before promotion.

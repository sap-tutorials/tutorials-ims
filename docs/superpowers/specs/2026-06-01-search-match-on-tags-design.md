# Search: match on tags — design spec

**Issue:** [tutorials-ims #154](https://github.com/sap-tutorials/tutorials-ims/issues/154)
**Date:** 2026-06-01
**Status:** Draft, pending implementation plan

## Problem

`/search` does not match against tutorial tags. A user typing a tag name (or part of one) into the main search box does not surface tutorials carrying that tag. Daniel Wroblewski reported the gap on 2026-06-01.

The current `SearchableItems` view exposes `primaryTag` (a single slug per row) but ignores the many-to-many `Tags` relationship — so tutorials with rich tag sets (e.g., `software-product>sap-s-4hana`, `software-product-function>abap-development`, `topic>cap`) are only discoverable by the one slug stamped on `Tutorials.primaryTag`.

## Acceptance criteria (from issue)

1. Free-text search matches against tag names/display names in addition to title/description.
2. Tag matches are weighted so they don't drown out title matches.

## Goals

- Typing a tag's display label (e.g., "SAP S/4HANA") or its slug (e.g., `sap-s-4hana`) returns every tutorial/mission/group that carries that tag.
- A tutorial with the term in its title still ranks above a tutorial that only carries it as a tag.
- Tag edits in the admin Tags app take effect immediately for the next search — no re-publish, no nightly job.
- Joule's `searchTutorials` chat tool gets the same coverage automatically (it shares the predicate).

## Non-goals

- Changing the facet UI (`getFacets` / `tagCounts`).
- Changing the admin search (Fiori Elements native search).
- Changing the frontend search composable (`useSearch.ts`).
- Indexing `Steps` / `Checkpoints` (not in `SearchableItems` today).

## Architecture

```text
                ┌──────────────────────────────────────────────┐
                │ SearchableItems  (UNION ALL view, db/views)  │
                │  — adds tagBag column per branch via         │
                │    correlated subquery against {x}Tags+Tags  │
                └────────────┬─────────────────────────────────┘
                             │
                             ▼
   /search/$search=…  ─►  before('READ') in search-service.js
                             │
                             │  applyWordBoundarySearch:
                             │  ORs across title/description/
                             │  primaryTag/tagBag with the
                             │  existing replace+lower+pad chain.
                             │
                             │  attachSearchRank:
                             │  appends _searchRank virtual
                             │  column (CASE WHEN…) and prepends
                             │  it to ORDER BY.
                             ▼
                   after('READ') strips bodyText AND _searchRank
                             │
                             ▼
                          response

   /chat → searchTutorials tool → SearchService.SearchableItems.search()
                                          (same predicate, no separate code path)
```

Three files change. No schema migration.

## Components

### 1. `db/views.cds` — `SearchableItems` view

Each of the three UNION-ALL branches gains a `tagBag : LargeString` column from a correlated subquery:

```cds
view SearchableItems as
  SELECT from ims.Tutorials as t
    left join ims.TutorialBodyText as bt on bt.slug = t.slug
  {
    key t.ID, t.legacyId, t.title, t.description, t.slug,
    t.primaryTag, t.experienceTag, t.averageTimeToComplete, t.status,
    'TUTORIAL' as taskType : String(20),
    bt.bodyText as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.TutorialTags tt
       inner join ims.Tags tg on tg.ID = tt.tag.ID
       where tt.tutorial.ID = t.ID
    ) as tagBag : LargeString
  } where t.status is null or t.status = 'ACTIVE'
  UNION ALL
  SELECT from ims.Missions {
    ID, legacyId, title, description, slug,
    primaryTag, experienceTag, averageTimeToComplete, status,
    'MISSION' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.MissionTags mt
       inner join ims.Tags tg on tg.ID = mt.tag.ID
       where mt.mission.ID = ID  -- placeholder; final SQL uses outer alias
    ) as tagBag : LargeString
  } where (status is null or status = 'ACTIVE') and published = true
  UNION ALL
  SELECT from ims.Groups { ... analogous via GroupTags };
```

**Why aggregate `lower(label || ' ' || name)`?** The runtime predicate already lowercases the search input; doing it once at view-time avoids a per-row `lower()` call. Both fields go into the bag because users type either the human label ("SAP S/4HANA") or, when pasted from a URL or a frontmatter dump, the slug (`sap-s-4hana`).

**`string_agg`** is supported on HANA Cloud and SQLite ≥ 3.44 (project's local dev SQLite is current). No portability concern.

### 2. `srv/search-service.cds` — annotation update

```cds
@cds.search: { title, description, primaryTag, tagBag }
entity SearchableItems as projection on ims.SearchableItems {
  @Search.fuzzinessThreshold: 0.85
  @Search.ranking: #HIGH
  title,
  ...
  @Search.fuzzinessThreshold: 0.85
  @Search.ranking: #LOW
  primaryTag,
  @Search.fuzzinessThreshold: 0.85
  @Search.ranking: #LOW
  tagBag,
  *
} excluding { bodyText };
```

The fuzzy/ranking annotations only affect CAP's built-in `$search` path, which `search-service.js` overrides — but listing `tagBag` in `@cds.search` keeps the model self-documenting and ensures any future code that reads `entity.search` keys finds it.

### 3. `srv/search-service.js` — predicate + ranking

#### 3a. `applyWordBoundarySearch` extension

Add a fourth OR clause for `tagBag` mirroring the existing three:

```js
or (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(
  lower(coalesce(tagBag,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),
  '(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
```

The `replace()` chain is preserved (not skipped) because slugs aggregated into tagBag still contain `-` and `>` separators. Consistency with title/description costs a few extra string ops per row — acceptable given the search is paged at `$top=48`.

Multi-token semantics are unchanged: each token must match somewhere across the four columns; tokens AND together.

#### 3b. New ranking column

The current `before('READ')` hook strips CAP's built-in `$search` and substitutes the word-boundary predicate. We append two more steps:

1. **Compute `_searchRank` per row.** A `CASE WHEN` summed across columns:
   - `+3` if any token matches title
   - `+2` if any token matches description
   - `+1` if any token matches primaryTag OR tagBag
2. **Prepend `_searchRank DESC` to ORDER BY.**

Implementation sketch:

```js
function attachSearchRank(query, tokens) {
  // Build per-column LIKE-OR-tokens fragment, then CASE WHEN (any-match) THEN N ELSE 0
  // Sum the four fragments. Append as virtual column, prepend to ORDER BY.
  const sel = query.SELECT;
  // ... build CDS QL xpr tree representing CASE WHEN sum
  sel.columns = [...(sel.columns ?? [{ ref: ['*'] }]),
    { as: '_searchRank', xpr: rankExpr }];
  sel.orderBy = [{ ref: ['_searchRank'], sort: 'desc' },
    ...(sel.orderBy ?? [])];
}
```

Detail: tag-only-match rows still surface (rank ≥ 1) — they just sort below title hits, satisfying acceptance criterion #2.

#### 3c. Strip `_searchRank` from response

The existing `after('READ')` hook already deletes `bodyText` from each row. Add `_searchRank` to the strip list:

```js
this.after('READ', SearchableItems, (results) => {
  if (!results) return;
  const rows = Array.isArray(results) ? results : [results];
  for (const r of rows) {
    if (!r) continue;
    delete r.bodyText;
    delete r._searchRank;
  }
});
```

#### 3d. `getFacets` action — unchanged

The existing implementation runs its own SELECT and buckets in Node; ranking and tag-match flow through `applyWordBoundarySearch` automatically because both code paths call the same helper. No changes.

### 4. Joule `searchTutorials` — no code change

The chat orchestrator at [srv/lib/chat-orchestrator.js:189-225](srv/lib/chat-orchestrator.js#L189-L225) calls `SearchService.SearchableItems.search(args.query)`, which goes through the same `before('READ')` hook. Tag-matching and ranking apply automatically. No update needed.

## Data flow

1. Admin renames a tag's `label` in `/admin-ui/#tags-display`.
2. Next `/search?$search=…` request reads `SearchableItems`; the correlated subquery picks up the new label.
3. `before('READ')` rewrites the search clause to ANDed word-boundary LIKEs across all four columns and adds `_searchRank` ORDER BY.
4. HANA returns rows with `_searchRank`; `after('READ')` strips it.
5. Frontend renders the same shape it already renders — no contract change.

## Error handling

- **Subquery returns NULL** (a tutorial has no tags): `coalesce(tagBag,'')` keeps the LIKE harmless. No match, no error.
- **Empty search phrase**: existing guard returns early — no rank column added, no order rewrite.
- **`_searchRank` leak in response**: stripped by the existing `after('READ')` hook (one-line addition). Defense-in-depth: even if a CDS QL change later loses the column, the strip is a no-op.
- **Single-token query of length 1** (e.g., "C"): existing `t.length >= 2` filter rejects it before we ever build the predicate. Unchanged.

## Testing

| Layer | File | What it asserts |
|---|---|---|
| **Unit** (in-memory SQLite) | `test/search-tag.test.js` (new) | (a) Seed 4 tutorials with overlapping tags; search for a label only present in `Tags.label` returns the matching tutorial. (b) Searching for the slug also matches. (c) When a search term appears in one tutorial's title and another's tag, the title-hit is the first row of `value`. (d) `_searchRank` is not present in any returned row (after-hook strips it). |
| **Hybrid** (real HANA) | `test/hybrid/search-hana.test.js` (extend) | Add an assertion: search for a tag label whose row data is real HANA test data; expect ≥ 1 hit, no `_searchRank` field. Confirms HANA correlated subquery + string_agg work in production-shaped SQL. |
| **Smoke** (deployed) | `test/smoke/search.test.js` (extend) | `GET /search/SearchableItems?$search=BTP&$top=10` returns ≥ 1 hit; assert no row has `_searchRank`. |

The unit test pattern follows [test/hybrid/search-hana.test.js](test/hybrid/search-hana.test.js) (existing) for setup/teardown shape; SQLite is fine for the predicate logic since the only HANA-specific construct (`string_agg`) is also supported by SQLite ≥ 3.44.

## Migration & rollout

- **HDI redeploy.** View is rebuilt; no table migration. Use the fast path from [memory: cf-push-db-deployer-fast-path]:
  ```bash
  cf push tutorials-db-deployer -p ../gen/db --no-route --health-check-type process -b nodejs_buildpack
  ```
- **Srv restart.** `search-service.js` changes require a `cf restart tutorials-srv` (and `tutorials-srv-qa`).
- **No content republish.** `publish-content` is unaffected.
- **`srv-qa` cp-list audit.** Walk transitive imports from `srv/search-service.js` and confirm no new files entered `srv/lib/` that need adding to `.deploy/mta.yaml`. The current change keeps imports inside `srv/search-service.js` itself, so the cp list should be unchanged — but verify, per [memory: srv-qa cp-list recurring].
- **CAP 10 readiness.** Listed flags are unaffected by this change; no audit needed.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Correlated subquery cost on UNION ALL hurts HANA latency | Bounded by paging (`$top=48`); add a timing assertion in the hybrid test (< 2 s for a 50-row page over `$search=cap`). If breached, materialize `tagBag` as a column and refresh on `Tags.label` change + tutorial-tag link change. |
| `string_agg` order non-determinism | Position-independent — `LIKE '% term %'` doesn't care about order. |
| Tag rename takes effect mid-search session | Goal, not bug. |
| Virtual column on `$select`-narrowed requests | `before('READ')` only adds `_searchRank` when `$search` is present. Plain projections (no search) are unaffected. |
| HANA LOB locator interaction with `tagBag : LargeString` | The view aggregates `String(255)` fields into a string; HANA's locator-expiry rule is for genuine LOB columns selected alongside metadata. `tagBag` is built from `String(255)` columns and projected in the same SELECT — no separate locator is involved. Verify in hybrid test. |
| Frontend trips over a leaked `_searchRank` field | After-hook strips it; smoke test asserts absence. |

## Out of scope (explicit)

- Changing the facet `tagCounts` payload — still counts top-20 `primaryTag`.
- Adding a tag-only filter chip — out of scope; existing product chips already handle that flow.
- Changing the search input UI in `useSearch.ts` — no contract change required.
- Indexing `Steps` / `Checkpoints` — `SearchableItems` is tutorial/mission/group only.
- Renaming `_searchRank` to a public sortable column — internal-only ranking signal.

## Open questions

None.

## References

- [srv/search-service.cds](srv/search-service.cds)
- [srv/search-service.js](srv/search-service.js)
- [db/views.cds](db/views.cds) — `SearchableItems` view
- [db/schema.cds](db/schema.cds) — `Tags`, `TutorialTags`, `MissionTags`, `GroupTags`
- [srv/lib/chat-orchestrator.js:189-225](srv/lib/chat-orchestrator.js#L189-L225) — Joule `searchTutorials` tool
- [hugo-apps/src/navigator/useSearch.ts](hugo-apps/src/navigator/useSearch.ts) — frontend consumer (unchanged)
- [test/hybrid/search-hana.test.js](test/hybrid/search-hana.test.js) — existing hybrid test
- [test/smoke/search.test.js](test/smoke/search.test.js) — existing smoke test

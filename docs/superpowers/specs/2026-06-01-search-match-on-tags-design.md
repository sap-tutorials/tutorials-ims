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

Each of the three UNION-ALL branches gains a `tagBag : String(5000)` column from a correlated subquery. Each branch is given an explicit outer alias (`t` / `m` / `g`) so the correlated subquery can bind to the outer row unambiguously — the existing Missions/Groups branches are unaliased today, so the spec adds aliases:

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
       from ims.TutorialTags as tt
       inner join ims.Tags as tg on tg.ID = tt.tag.ID
       where tt.tutorial.ID = t.ID
    ) as tagBag : String(5000)
  } where t.status is null or t.status = 'ACTIVE'
  UNION ALL
  SELECT from ims.Missions as m {
    m.ID, m.legacyId, m.title, m.description, m.slug,
    m.primaryTag, m.experienceTag, m.averageTimeToComplete, m.status,
    'MISSION' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.MissionTags as mt
       inner join ims.Tags as tg on tg.ID = mt.tag.ID
       where mt.mission.ID = m.ID
    ) as tagBag : String(5000)
  } where (m.status is null or m.status = 'ACTIVE') and m.published = true
  UNION ALL
  SELECT from ims.Groups as g {
    g.ID, g.legacyId, g.title, g.description, null as slug : String(255),
    g.primaryTag, g.experienceTag, g.averageTimeToComplete, g.status,
    'GROUP' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.GroupTags as gt
       inner join ims.Tags as tg on tg.ID = gt.tag.ID
       where gt.group.ID = g.ID
    ) as tagBag : String(5000)
  } where (g.status is null or g.status = 'ACTIVE') and g.published = true;
```

**Why `String(5000)` instead of `LargeString`?** Avoids HANA LOB locator semantics for the aggregated tag text. Per-row tag count is bounded (typical ≤ 10 tags × ~50 chars label + slug + delimiter ≈ 700 chars; 5000 leaves comfortable headroom). Keeping `tagBag` as a sized string sidesteps the [memory: HANA LOB locator] rule that LOB columns selected alongside metadata expire mid-stream — see Risks table for the explicit hybrid-test assertion.

**Why aggregate `lower(label || ' ' || name)`?** The runtime predicate already lowercases the search input; doing it once at view-time avoids a per-row `lower()` call. Both fields go into the bag because users type either the human label ("SAP S/4HANA") or, when pasted from a URL or a frontmatter dump, the slug (`sap-s-4hana`).

**`string_agg`** is supported on HANA Cloud and SQLite ≥ 3.44 (project's local dev SQLite is current). No portability concern.

### 2. `srv/search-service.cds` — annotation update

The current projection (`srv/search-service.cds:30-41`) lists `title`, `description`, `primaryTag`, `*` and excludes `bodyText`. We add `tagBag` to `@cds.search` and project it explicitly with the same fuzzy/ranking annotations as `primaryTag` so it's visible in the model — `*` would still bring it through, but explicit is clearer:

```cds
@readonly
@cds.search: { title, description, primaryTag, tagBag }
entity SearchableItems as projection on ims.SearchableItems {
  @Search.fuzzinessThreshold: 0.85
  @Search.ranking: #HIGH
  title,
  @Search.fuzzinessThreshold: 0.9
  @Search.ranking: #MEDIUM
  description,
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

Add a fourth OR clause for `tagBag` mirroring the existing three. The new clause is added **inside** the existing per-token loop (`for (const tok of tokens) { query.where(...) }`), preserving AND-across-tokens semantics (each token must still match somewhere; tokens AND together):

```js
or (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(
  lower(coalesce(tagBag,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),
  '(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
```

The `replace()` chain is preserved (not skipped) because slugs aggregated into tagBag still contain `-` and `>` separators. Consistency with title/description costs a few extra string ops per row — acceptable given the search is paged at `$top=48`.

#### 3b. New ranking column

The current `before('READ')` hook strips CAP's built-in `$search` and substitutes the word-boundary predicate. We append a virtual `_searchRank` column and reorder.

Ranking rule (per row, summed across columns; **+1 total** if either `primaryTag` OR `tagBag` matches, not +1 per matching column):

| Column matched by ANY token | Contribution |
|---|---|
| `title` | +3 |
| `description` | +2 |
| `primaryTag` OR `tagBag` (either or both) | +1 |

Max rank: 6. A title-only hit (3) outranks a tag-only hit (1) by 3×. A title+description+tag hit (6) is the ceiling. Tag-only-match rows still surface (rank ≥ 1) — they sort below title hits, satisfying acceptance criterion #2.

**The rank SQL must use the same word-boundary `replace()` chain as the predicate**, otherwise rank can disagree with match (a row whose `description` matches via word-boundary could rank 0 if the rank used plain LIKE). The fragment per-column-per-token-OR is the same shape as the predicate's column clauses — wrap in `CASE WHEN (col-clause-OR-tokens) THEN N ELSE 0 END` and sum:

```sql
(
  CASE WHEN ((' '||replace(...title...)||' ') like '% tok1 %'
          OR (' '||replace(...title...)||' ') like '% tok2 %')
       THEN 3 ELSE 0 END
+ CASE WHEN ((' '||replace(...description...)||' ') like '% tok1 %'
          OR (' '||replace(...description...)||' ') like '% tok2 %')
       THEN 2 ELSE 0 END
+ CASE WHEN ((' '||replace(...primaryTag...)||' ') like '% tok1 %'
          OR (' '||replace(...primaryTag...)||' ') like '% tok2 %'
          OR (' '||replace(...tagBag...)||' ') like '% tok1 %'
          OR (' '||replace(...tagBag...)||' ') like '% tok2 %')
       THEN 1 ELSE 0 END
) AS _searchRank
```

Note the third CASE-WHEN folds primaryTag and tagBag into a single OR — this is what produces "+1 total when either matches." Implementation factors a helper `buildColumnClause(col, tokens)` that emits the per-column OR-of-tokens fragment, used by both the predicate and the rank.

Implementation sketch:

```js
function buildColumnClause(col, tokens) {
  // Returns a parameterized SQL fragment string + params:
  //   ((' '||replace(...col...)||' ') like ? OR ... like ? OR ...)
  // One LIKE per token; tokens come in already-normalized.
}

function attachSearchRank(query, tokens) {
  const titleClause = buildColumnClause('title', tokens);
  const descClause  = buildColumnClause('description', tokens);
  const tagClause   = buildColumnClause('primaryTag', tokens) /* OR */ + buildColumnClause('tagBag', tokens);
  // Compose CASE WHEN sum as a CDS QL xpr or as cds.ql`...` raw-SQL fragment.
  const sel = query.SELECT;
  sel.columns = [...(sel.columns ?? [{ ref: ['*'] }]),
    { as: '_searchRank', xpr: rankExpr }];
  sel.orderBy = [{ ref: ['_searchRank'], sort: 'desc' },
    ...(sel.orderBy ?? [])];
}
```

Tag-only-match rows still surface (rank ≥ 1) — they just sort below title hits, satisfying acceptance criterion #2.

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

#### 3d. `getFacets` action

The existing implementation runs its own SELECT and buckets in Node. Tag-matching flows through automatically because both code paths call the same `applyWordBoundarySearch` helper — the facet counts now reflect tag-matched rows. **Ranking does NOT apply** to faceting (counts are unranked by design); `attachSearchRank` is only called from the `before('READ')` hook on the entity, not from `getFacets`. No code change.

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
| **Unit** (in-memory SQLite) | `test/search-tag.test.js` (new) | (a) Seed 4 tutorials with overlapping tags; search for a label only present in `Tags.label` returns the matching tutorial. (b) Searching for the slug also matches. (c) **Ordering with distractors:** seed 5 tag-only matching rows + 1 title-matching row for the same query; assert the title row is `value[0]` and all 5 tag rows follow (proves rank arithmetic, not just first-row ordering). (d) `_searchRank` is not present in any returned row (after-hook strips it). (e) Multi-token query "sap btp" matches a row whose title has "sap" and whose tagBag has "btp" — confirms AND-across-tokens still spans the new column. |
| **Hybrid** (real HANA) | `test/hybrid/search-hana.test.js` (extend) | Three additions: (1) Search for a tag label whose row data is real HANA test data; expect ≥ 1 hit, no `_searchRank` field. (2) **LOB-locator regression check:** select `_searchRank, title, tagBag` together in one round-trip and assert all three populate (confirms `String(5000)` typing keeps the read on the metadata path, not the LOB-locator path). (3) Timing assertion: 50-row page over `$search=cap` completes < 2 s. |
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
| HANA LOB locator interaction with `tagBag` | `tagBag` is typed `String(5000)` (not `LargeString`) — HANA returns it as a regular VARCHAR, not a CLOB locator, so the [memory: HANA LOB locator] expiry rule doesn't apply. Hybrid test (case 2 above) explicitly selects `_searchRank, title, tagBag` together to catch any silent regression. |
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

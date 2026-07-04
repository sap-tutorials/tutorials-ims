# Server-Side KG-Boosted Search Ranking

**Issue:** [#945](https://github.com/sap-tutorials/tutorials-ims/issues/945) — search: server-side KG-boosted ranking in searchTutorials / SearchableItems
**Depends on (shipped):** [#953](https://github.com/sap-tutorials/tutorials-ims/pull/953) — Concept embeddings, ConceptEdges, TutorialConceptLinks, `expandSearchConcepts` Joule tool
**Date:** 2026-07-03
**Status:** Design — approved by user, proceeding to implementation

---

## Summary

Push the KG signal (concept embeddings, concept edges, tutorial→concept links) into the primary search ranking. Two entry points, one internal helper, one shared cache, one feature flag.

- **Part A — OData rerank.** `/search/SearchableItems` re-orders results using KG concept overlap in addition to the existing HANA fuzzy `_searchRank`. The rank formula becomes `fuzzy_rank + 2.0 × kg_score` where `kg_score` is the per-tutorial score from the concept-cosine + 1-hop-edge-walk pipeline. Fuzzy signal stays untouched — KG is purely additive. When KG returns empty (flag off, timeout, zero ACTIVE concepts), the formula reduces byte-identically to today's.
- **Part B — searchTutorials Joule blend.** The tool's internal `SELECT.from(SearchableItems).search(...)` already flows through `SearchService.before('READ')`, so the SQL-side blend from Part A automatically applies. The remaining work is attaching per-hit `rationale` strings ("Teaches Async ABAP and RAP") from the cached KG signal so the LLM sees a single, pre-ranked, pre-annotated list instead of needing to reconcile two tools.

Both paths share:

- `srv/lib/search-kg-signal.js` — new helper wrapping embed + `topConceptsByCosine` + edge walk + link fetch + LRU cache + single-flight coalescing.
- One in-process LRU cache (500 entries, 5-min TTL, keyed by `phrase.trim().toLowerCase()`).
- One feature flag: `ChatSettings.searchKgRerankEnabled` (default `true`).

## Goals

- Improve navigator search relevance for every visitor, not just Joule users.
- Give Joule a single pre-blended, rationale-annotated result list so its answers can explain *why* a tutorial matched.
- Ship as a coupled, feature-flagged capability with a single kill-switch.

## Non-goals

- New primary-ranking algorithms beyond the additive blend (v2 concern).
- Removing the fuzzy CASE-WHEN or the word-boundary predicate (only additive here; deprecation is a v2 decision informed by production metrics).
- Multi-language concept expansion (parked → #947).
- On-demand KG rebuild triggers (parked → #948).

---

## Section 1 — Architecture

```
┌─────────────────── /search/SearchableItems (OData) ───────────────────┐
│  SearchService.before('READ')                                          │
│    ├─ existing: word-boundary tokenize + attachSearchRank(3/2/1)       │
│    └─ NEW: if settings.searchKgRerankEnabled && sel.search present     │
│              → kgSignal = await computeKgSignal(phrase)  ← cache       │
│              → append `+ 2.0 * CASE slug WHEN ... END` to _searchRank  │
│                (values from kgSignal.slugScores)                       │
│  SearchService.after('READ')                                           │
│    ├─ existing: strip bodyText                                         │
│    └─ NEW: alias _searchRank → searchScore when $selected              │
└────────────────────────────────────────────────────────────────────────┘
                          │
                          ▼  shared LRU cache (in-process, per instance)
                          │
┌─────────── searchTutorials Joule tool (chat-orchestrator.js) ─────────┐
│  existing: SELECT.from(SearchableItems).search(...).limit(5)          │
│    → flows through SearchService.before('READ') — SQL blend applies   │
│    └─ NEW: if settings.searchKgRerankEnabled                          │
│              → attach `rationale` from cache.slugRationale on each hit│
│              → LLM sees ranked-and-explained list, one signal         │
└───────────────────────────────────────────────────────────────────────┘
```

Key insight: because Part B runs its query *through* the same `before('READ')` hook, the SQL-side blend is automatic. Part B collapses to "attach cached rationale."

### File inventory

**New files**

- `srv/lib/search-kg-signal.js` — compute + cache the KG signal per query.
- `test/unit/search-kg-signal.test.js` — in-memory SQLite; cache, single-flight, empty-KG, flag-off, sanitization.
- `test/unit/search-service-kg-blend.test.js` — asserts `before('READ')` SQL formula extension.
- `test/hybrid/search-kg-rerank.test.js` — real HANA path parity vs SQLite.
- Extension to `test/smoke/search.smoke.test.js` — post-deploy assertion that `searchScore` is present and monotone-DESC.

**Modified**

- `srv/search-service.cds` — add `searchScore : Decimal(8,4)` to the `SearchableItems` projection.
- `srv/search-service.js` — extend `before('READ')` and `after('READ')`.
- `srv/lib/chat-orchestrator.js` — annotate `searchTutorials` hits with `rationale` from cache when flag on.
- `db/schema.cds` — add `searchKgRerankEnabled : Boolean default true;` to `ChatSettings`.
- `db/last-dev/csn.json` — regenerated via `cds build --production`.
- `app/admin/chat-settings/webapp/manifest.json` or annotations — add the toggle (mirror existing `kgSearchExpansionEnabled` pattern).

---

## Section 2 — Data flow & scoring

### Cache entry shape

```js
{
  slugScores: Map<slug, number>,       // per-tutorial score, ~0..1.5, drives SQL CASE
  slugRationale: Map<slug, string>,    // e.g. "Teaches Async ABAP and RAP"
  topConcepts: Array<{ slug, name, score }>,
  computedAt: number,                  // Date.now() at insertion
  latencyMs: number,
}
```

- **Key:** `phrase.trim().toLowerCase()`; empty phrase → no cache entry, no signal.
- **Size cap:** 500 entries; simple insertion-order eviction (`Map` iteration).
- **TTL:** 5 minutes; expired entries dropped on next access.
- **Scope:** per Node process (per CF instance). Two-instance deploy = 2 caches. Warm-up cost is one embed per query per instance; acceptable at current traffic.
- **Single-flight coalescing:** an in-flight promise map keyed by the same phrase; concurrent callers `await` the same promise, so an embed-storm on a shared query is impossible.

### KG algorithm (reused from `joule-tool-expand-concepts.js`)

1. Embed phrase via `srv/lib/embedding-client.js` (5s `AbortController`).
2. `topConceptsByCosine({ db, queryVector, limit: 5 })` — publish gate `status='ACTIVE' AND publishedAt IS NOT NULL AND mergedInto IS NULL` is inside the helper.
3. 1-hop `ConceptEdges` walk on predicates `requires`, `relatedTo`. Neighbours boosted by `WALK_BOOST(0.5) × seed_score × edge_confidence`. Neighbour metadata hydrated with the same publish gate.
4. `TutorialConceptLinks` join (predicate = `teaches`), by concept id → `tutorial_slug`, `title`.
5. Per-tutorial aggregate: `Σ(concept_score × link_confidence)`.
6. Rationale = names of top-2 contributing concepts joined with " and " (top-1 fallback).

**Reuse pattern:** the four DB-fetch helpers (`fetchEdges`, `fetchConceptsByIds`, `fetchLinks`, plus `topConceptsByCosine`) exist inside `joule-tool-expand-concepts.js`. Rather than duplicate, `search-kg-signal.js` imports the helpers or a shared internal module. The plan step "extract the fetch helpers into a shared internal `srv/lib/kg/_search-fetches.js`" isolates the change so both tools import from one place.

### SQL-side blend inside `_searchRank`

The existing rank builds an integer sum via CASE-WHEN. We extend it with an additive KG term:

```sql
(case when (<title token match>) then 3 else 0 end
 + case when (<desc token match>) then 2 else 0 end
 + case when (<tag token match>) then 1 else 0 end
 + 2.0 * (case slug
            when 'abap-async-rap' then 0.8100
            when 'cap-outbox'     then 0.6400
            ...
            else 0 end))
```

- **Value formatting:** each score is `.toFixed(4)` (matches `Decimal(8,4)`), inlined as an SQL numeric literal — no string quoting, no injection surface.
- **Slug formatting:** goes through the same `_safeQuotedLiteral` sanitizer already present in `search-service.js` (`String(...).replace(/[%_'\\]/g, '')` then wrapped in single quotes). Extra defensive check: reject any slug that doesn't match `/^[a-z0-9-]+$/` — `Tutorials.slug` is lowercase-kebab by DB constraint (`_tutorials-table.js`), so a bad slug means bug or attack, and we skip that row rather than trust it.
- **Empty signal:** when `slugScores.size === 0`, the extra `+ 2.0 * (...)` term is not appended. Formula reduces byte-identically to today's. Guarded by a unit test.
- **Bound on CASE size:** `slugScores` capped at ~100 entries (top 5 concepts × avg 20 links per concept). Even at 200 rows, the CASE expression is well under HANA's SQL length limit and the DB planner handles it in one pass.

### `after('READ')` — expose `searchScore`

- Rename the strip logic: still strip `bodyText`, still strip `_searchRank` from OData output when not requested.
- If `$select` includes `searchScore`, expose the value (aliased from `_searchRank` at map time — a single field-copy per row).
- Non-navigator OData consumers (admin apps, exports) don't request `searchScore` and see zero payload change.

### `searchTutorials` Joule blend

In `dispatchTool('searchTutorials')`:

- After the existing SELECT returns, if `searchKgRerankEnabled` and cache holds the phrase, map each hit:
  ```js
  const rationale = cache.slugRationale.get(hit.slug)
  return rationale ? { ...hit, rationale } : hit
  ```
- Hits with no KG rationale keep today's shape.
- No new embed call — the OData rerank populated the cache in the same turn.

### End-to-end trace ("abap async")

```
User → navigator search "abap async"
  → GET /search/SearchableItems?$search=abap+async&$select=slug,title,...,searchScore
    → before('READ'):
        tokens = ['abap','async']
        computeKgSignal('abap async')  [cache miss]
          → embed('abap async')                                   ~180ms
          → topConceptsByCosine → [async-abap:.87, event-driven-arch:.71]
          → ConceptEdges walk → +[rap:.54 via requires]
          → TutorialConceptLinks → [abap-async-rap:.81, cap-outbox:.64, ...]
          → cache.put('abap async', ...)
        rank = (case title...3, desc...2, tag...1) + 2.0 * CASE slug ...
    → DB orders by rank DESC, then existing tiebreakers
    → after('READ'): _searchRank → searchScore, strip bodyText

User → clicks Joule handoff button
  → LLM → tool_use searchTutorials {query:'abap async'}
    → dispatchTool('searchTutorials')
      → SearchableItems.search('abap async').limit(5)
        → before('READ'): computeKgSignal('abap async') [cache HIT ~0ms]
      → attach cache.slugRationale per hit
    → LLM sees pre-blended, rationale-annotated hits
```

---

## Section 3 — Error handling, testing, rollout

### Error handling

| Failure                              | Behaviour                                                                                   |
|--------------------------------------|---------------------------------------------------------------------------------------------|
| `searchKgRerankEnabled = false`      | `computeKgSignal` short-circuits with empty signal; rank formula identical to today.        |
| Embed timeout (>5s)                  | Empty signal; `search.kg.embed_failed` metric; empty result cached briefly (60s) to avoid embed-storm. |
| Embed error (non-timeout)            | Empty signal; `search.kg.embed_failed` metric; not cached (transient errors retry).         |
| KG has zero ACTIVE concepts          | Empty signal; cached normally (5-min TTL); rank formula unchanged.                          |
| Cache miss + concurrent calls        | Single-flight promise map — both awaits share one embed.                                    |
| HANA raw `db.run` fails              | Empty signal; `search.kg.db_error` metric; not cached.                                      |
| Bad slug in `slugScores` map         | Filtered by `_safeQuotedLiteral` + regex `/^[a-z0-9-]+$/`. If ALL filtered, extra CASE skipped. |
| KG signal appends slug that no longer exists in Tutorials | Harmless — CASE just never matches; row keeps its fuzzy-only rank. |

### Metrics (via `srv/lib/metrics.js`)

- `search.kg.rerank.ms` — histogram; total time inside `computeKgSignal` incl. cache lookup.
- `search.kg.cache.hit` — counter.
- `search.kg.cache.miss` — counter.
- `search.kg.tutorial_count` — gauge per emit; distribution of how many tutorials KG scored.
- `search.kg.error` — counter tagged `{ cause: 'embed_failed' | 'db_error' | 'timeout' }`.
- (existing) `kg.joule.search_expansion_*` metrics unchanged; still emitted by the `expandSearchConcepts` tool from #953.

Watch on `/admin-ui/#metrics` for a week post-deploy.

### Testing plan

Four tiers (project convention, `vitest.config.ts` inline projects):

1. **Unit — `test/unit/search-kg-signal.test.js`** (in-memory SQLite, deterministic)
   - Seeds 3 concepts + 2 edges + 4 links + 2 tutorials (mirrors `joule-tool-expand-concepts.test.js`).
   - Assertions:
     - Cache miss → embed called once, entry stored.
     - Second call same phrase → cache hit, embed NOT re-called.
     - Concurrent identical calls → single-flight coalescing (one embed for two awaits).
     - Flag off → returns empty signal without calling embed.
     - Zero ACTIVE concepts → empty signal, still cached.
     - Embed throws → empty signal + not cached.
     - Malformed slug in `slugScores` → filtered before SQL emit.

2. **Unit — `test/unit/search-service-kg-blend.test.js`** (in-memory SQLite)
   - Empty signal → rank SQL byte-identical to today's (regression test).
   - Non-empty signal → rank SQL contains `+ 2.0 * (case slug ...)` fragment.
   - `$select=searchScore` → response row includes `searchScore` number.
   - `$select` without `searchScore` → response row does NOT include `searchScore`.

3. **Hybrid — `test/hybrid/search-kg-rerank.test.js`** (`--project hybrid`, `ALLOW_HYBRID_WRITES=true`)
   - Seeds `__TEST__`-prefixed concepts, edges, links, tutorials.
   - Verifies HANA raw SQL path (SELECT SLUG, EMBEDDING FROM ...) matches SQLite path within ordering tolerance.
   - `afterAll` cleans up all `__TEST__`-prefixed rows.

4. **Smoke — extension to `test/smoke/search.smoke.test.js`**
   - `GET /search/SearchableItems?$search=abap&$select=slug,title,searchScore&$top=5` — asserts `searchScore` present, monotone DESC.

### CI Node 22 traps (from project memory)

- Use `cds.entities('com.sap.developers.ims')` refs, not bare projection names.
- Guard against `cds.context` leak in module-scoped cache via `x.context = x` self-reference where relevant.

### Rollout

1. Land schema change → `cds build --production` → stage `db/last-dev/csn.json`.
2. Land `search-kg-signal.js` + `search-service.{cds,js}` + `chat-orchestrator.js` changes.
3. Add admin toggle for `searchKgRerankEnabled` in Chat Settings tile (mirror existing `kgSearchExpansionEnabled` pattern).
4. Deploy DEV; verify smoke tests; watch `/admin-ui/#metrics`.
5. Manual walkthrough:
   - Search "abap async" in navigator; open browser devtools; confirm `searchScore` field present and non-zero for at least one row.
   - Click Joule handoff (from #953); confirm at least one `tool_use` block for `searchTutorials` in the SSE stream contains hits with `rationale` strings.
6. Watch metrics one week.
7. If regression: admin toggles `searchKgRerankEnabled = false` at `/admin-ui/#chat-settings`. Effect propagates to next chat turn + next OData search request (no deploy).

## Open questions

None at design time. UI polish for admin toggle inherits the existing Chat Settings tile chrome — no new patterns.

## References

- Issue [#945](https://github.com/sap-tutorials/tutorials-ims/issues/945)
- Precursor PR [#953](https://github.com/sap-tutorials/tutorials-ims/pull/953) — KG infra + `expandSearchConcepts` tool
- Design [`docs/superpowers/specs/2026-07-03-943-navigator-joule-kg-design.md`](2026-07-03-943-navigator-joule-kg-design.md) — parent design; §2 documents the algorithm this spec reuses
- `srv/search-service.js` — existing `attachSearchRank` and word-boundary predicate
- `srv/lib/kg/joule-tool-expand-concepts.js` — algorithm ancestor for `search-kg-signal.js`
- `srv/lib/kg/concept-embedding-query.js` — `topConceptsByCosine` (already handles HANA LOB expiry)
- `srv/lib/metrics.js` — metrics module (#805)

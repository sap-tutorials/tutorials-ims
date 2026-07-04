# KG: PageRank for whatToLearnNext ranking — Design

**Issue:** [#916](https://github.com/sap-tutorials/tutorials-ims/issues/916)
**Prereq:** [#919](https://github.com/sap-tutorials/tutorials-ims/issues/919) (widen `KG_PG_WORKSPACE` to 9-predicate parity) — MUST be merged first.
**Parent spike:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913), design in [`2026-07-02-913-kg-property-graph-spike-design.md`](2026-07-02-913-kg-property-graph-spike-design.md), gate graduated 2026-07-04.
**Scope:** DEV-only in v1. PROD rollout is out of scope.
**Date:** 2026-07-04

## Problem

The `whatToLearnNext` arm in the KG sidebar widget currently ranks candidates
using **hardcoded per-arm weights** in
[`db/src/procedures/KG_QUERY.hdbprocedure`](../../../db/src/procedures/KG_QUERY.hdbprocedure)
(`BIND(1.0 AS ?weight)` for `teaches`, `BIND(0.9 AS ?weight)` for `prereqOf`,
default `0.5` fallthrough for the rest). These are hand-tuned heuristics — not
data-driven importance signals. As the knowledge graph grows, the ordering of
"what should this learner see next" doesn't get any smarter.

## Proposal

A nightly PageRank pass over `KG_PG_WORKSPACE` (widened by #919 to include the
full 9-predicate set, including `coCompletedWith`) produces per-concept and
per-tutorial importance scores. Scores are materialized into two sidecar tables
(`ConceptRank`, `TutorialRank`) and consumed at request time by the ranker in
[`srv/knowledge-graph-service.js`](../../../srv/knowledge-graph-service.js) as a
multiplicative blend on top of the existing arm weights. Gated behind
`KG_PAGERANK_ENABLED` env flag; fail-open when off, when scores are missing,
or when the load path errors.

## Design decisions (locked during brainstorm)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| Q1 | Dependency on #919 | **Wait for #919** | Clean sequencing; `coCompletedWith` is the whole point of nightly cohort signal. |
| Q2 | Compute engine | **HANA GraphScript `Compute_Pagerank` in `KG_PAGERANK.hdbprocedure`** | In-DB, sub-second at prod scale, sibling of `KG_SHORTEST_PATH_GRAPH`. |
| Q3 | Score storage | **Sidecar tables** `ConceptRank`, `TutorialRank` | No change-tracking trigger noise on `Concepts`/`Tutorials`; no accidental OData exposure. |
| Q4 | Ranker integration | **Multiplicative blend** in Node, `weight *= (1 + α × normPR)` | Preserves arm semantics; PageRank breaks ties + lifts global hubs; SPARQL literals stay as fail-open fallback. |
| Q5 | PageRank flavor | **Plain global**, α_damping = 0.85 | Matches issue framing; cheap and deterministic. Personalized/per-category is YAGNI. |
| Q6 | Missing-scores behavior | **Fail-open** (multiplier collapses to 1.0) | Bootstrap-safe; same as flag-off. |
| Q7 | Test scope | **Procedure-only hybrid test** with hub-and-spoke fixture | Deterministic; ranker blend is a 4-line function verifiable by inspection. |

## Architecture

```
Nightly cron (03:53 UTC)                Request-time ranker
─────────────────────                    ────────────────────
scheduler                                DeveloperService.onNeighborhood
  └─ kg-pagerank-job.js                    └─ rankNeighborhood(...)
       │                                         │
       ├─ acquireLock (job-lock, ttl 600s)       ├─ IF KG_PAGERANK_ENABLED
       ├─ CALL "KG_PAGERANK"()                   │    └─ rankMaps = loadRankMaps() [LRU 5min]
       │    │                                    ├─ ELSE
       │    └─ HANA GraphScript                  │    └─ rankMaps = EMPTY
       │       Compute_Pagerank(g, 0.85, 100)    └─ per arm:
       │       → TRUNCATE + INSERT INTO               weight *= (1 + α × normalize(PR))
       │         ConceptRank, TutorialRank
       ├─ metrics.observe('kg_pagerank_duration_ms')
       ├─ metrics.gauge('kg_pagerank_nodes_scored')
       └─ releaseLock
```

Two independent pieces communicating through two sidecar tables. Writer is
HANA-side (nightly). Reader is Node-side (request-time), with an in-process
LRU cache to avoid a DB round-trip per neighborhood call.

## Components

### New files

1. **`db/src/procedures/KG_PAGERANK.hdbprocedure`** — GraphScript procedure,
   no params, no OUT. Illustrative body (exact primitive signature to be
   confirmed against HANA docs at implementation time):

   ```graphscript
   CREATE PROCEDURE KG_PAGERANK ()
     LANGUAGE GRAPH READS SQL DATA AS
   BEGIN
     GRAPH g = Graph("KG_PG_WORKSPACE");
     -- HANA's built-in PageRank primitive (name/args per SAP HANA GraphScript
     -- reference — one of PAGE_RANK / Compute_PageRank / PageRank depending
     -- on HANA version). Damping α = 0.85, max_iterations = 100.
     MAP<Vertex, DOUBLE> pr = PAGE_RANK(:g, 0.85, 100);

     SELECT :v.SLUG AS SLUG, :pr[:v] AS SCORE, CURRENT_TIMESTAMP AS COMPUTED_AT
       FROM :g.Vertices v WHERE :v.VERTEX_TYPE = 'concept'
       INTO tt_concept_scores;
     SELECT :v.SLUG AS SLUG, :pr[:v] AS SCORE, CURRENT_TIMESTAMP AS COMPUTED_AT
       FROM :g.Vertices v WHERE :v.VERTEX_TYPE = 'tutorial'
       INTO tt_tutorial_scores;

     INSERT INTO "COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"
       SELECT * FROM :tt_concept_scores;
     INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"
       SELECT * FROM :tt_tutorial_scores;
   END;
   ```

   No `SQL SECURITY DEFINER` — GraphScript ACLs pin via workspace ownership,
   matching `KG_SHORTEST_PATH_GRAPH`. Header comment block mirrors the existing
   KG procedures: purpose, spec + issue links, error codes if any, schema-local
   reference note. Caller is responsible for `TRUNCATE` before the `CALL`.

2. **`db-qa/src/procedures/KG_PAGERANK.hdbprocedure`** — QA-channel stub.
   Signals `KG_NOT_AVAILABLE_ON_QA` (condition already declared under
   `db-qa/src/procedures/`). Matches every other KG procedure's QA duality.

3. **`srv/jobs/kg-pagerank-job.js`** — Job body:

   ```js
   import cds from '@sap/cds';
   import * as metrics from '../lib/metrics.js';
   const LOG = cds.log('kg-pagerank');

   export async function runKgPageRank() {
     const t0 = Date.now();
     const db = await cds.connect.to('db');
     try {
       await db.tx(async tx => {
         await tx.run('TRUNCATE TABLE "COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"');
         await tx.run('TRUNCATE TABLE "COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"');
         await tx.run('CALL "KG_PAGERANK"()');
       });
       const [{ N: cN }] = await db.run(
         'SELECT COUNT(*) AS N FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"');
       const [{ N: tN }] = await db.run(
         'SELECT COUNT(*) AS N FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"');
       const durationMs = Date.now() - t0;
       metrics.observe('kg_pagerank_duration_ms', durationMs);
       metrics.gauge('kg_pagerank_nodes_scored', cN + tN);
       LOG.info(`PageRank: ${cN} concepts, ${tN} tutorials, ${durationMs}ms`);
       return { conceptsScored: cN, tutorialsScored: tN, durationMs };
     } catch (err) {
       metrics.counter('kg_pagerank_failures');
       LOG.error('PageRank failed', err);
       throw err;
     }
   }
   ```

4. **`test/hybrid/kg-pagerank.test.js`** — hub-and-spoke fixture (see Testing).

### New CDS entities (`db/knowledge-graph.cds`)

```cds
entity ConceptRank {
  key slug       : String(80);
      score      : Double;
      computedAt : Timestamp;
} @cds.autoexpose: false;

entity TutorialRank {
  key slug       : String(255);
      score      : Double;
      computedAt : Timestamp;
} @cds.autoexpose: false;
```

- **Not `managed`** — nightly job overwrites the whole table; `createdBy` /
  `modifiedBy` would be noise.
- **`@cds.autoexpose: false`** — keeps them off any accidental service
  projection. Not exposed on `AdminService` (issue non-goal #1).
- **Slug widths** mirror source: `Concepts.slug` = 80, `Tutorials.slug` = 255.

### Modified files

5. **`srv/knowledge-graph-service.js`** —
   - New `loadRankMaps()` helper. Reads both tables into `Map<slug, score>`,
     wrapped in a per-instance LRU with 5-minute TTL and a single-flight
     guard (concurrent callers share the in-flight promise).
   - At map-fill time, compute `minScore` and `maxScore` for the tutorial map
     once; stash on the cached object for O(1) normalization.
   - `rankNeighborhood(...)` gains a `rankMaps` argument. When
     `KG_PAGERANK_ENABLED === 'true'`, the caller passes populated maps;
     otherwise the caller passes empty maps and the blend collapses to 1.0.
   - Per-arm blend (applied uniformly to **all four** arms — `teaches`,
     `prerequisitesOf`, `sharedConcepts`, `whatToLearnNext`):
     `weight *= (1 + α × normalize(rankMaps.tutorialRank.get(candidate.slug) ?? 0))`
     where `α = Number(process.env.KG_PAGERANK_ALPHA) || 1.0` and
     `normalize(s) = (max === min) ? 0 : (s - min) / (max - min)`.

     The blend uses `tutorialRank` for tutorial candidates (all four arms
     yield tutorial slugs). `conceptRank` is materialized alongside for
     completeness and for future callers (e.g. concept-neighborhood views),
     but is not consumed by `rankNeighborhood` in v1.

6. **`srv/jobs/scheduler.js`** — register the job:

   ```js
   registerJob({
     jobName: 'kg-pagerank',
     schedule: '53 3 * * *',      // 03:53 UTC nightly (off-minute convention)
     ttlMs: 600000,               // 10 min ceiling; expected wall-clock < 5s
     description: 'Nightly PageRank over KG_PG_WORKSPACE. Populates ConceptRank/TutorialRank.',
     fn: () => runKgPageRank(),
   });
   ```

7. **`CLAUDE.md`** — new Gotcha line under the KG section:

   > **`KG_PAGERANK_ENABLED` env var** — when `'true'`, `rankNeighborhood`
   > multiplicatively blends `ConceptRank`/`TutorialRank` scores into arm
   > weights. Default off. Populated nightly at 03:53 UTC by `kg-pagerank-job`;
   > fail-opens when scores missing. Toggle via `cf set-env tutorials-srv
   > KG_PAGERANK_ENABLED true && cf restart tutorials-srv`.

### Explicitly NOT touched

- **`KG_QUERY.hdbprocedure`** — SPARQL literal weights stay as fail-open
  fallback. Per issue non-goal #2 (no weighting v1's PREREQ query) and
  Q4 (blend happens Node-side).
- **`AdminService` / OData surface** — non-goal #1.
- **SPARQL fallback path** — untouched; ranker still receives the same
  `{type, targetSlug, weight?}` rows it does today.

## Data flow

### Nightly write (03:53 UTC, one CF instance via `job-lock`)

```
scheduler.runJobByName('kg-pagerank')
  └─ runWithLock('kg-pagerank', ttlMs=600s)
       └─ runKgPageRank()
            ├─ t0 = Date.now()
            ├─ db.tx:
            │    TRUNCATE ConceptRank
            │    TRUNCATE TutorialRank
            │    CALL "KG_PAGERANK"()          ← GraphScript Compute_Pagerank
            ├─ SELECT COUNT(*) FROM ConceptRank  → conceptsScored
            ├─ SELECT COUNT(*) FROM TutorialRank → tutorialsScored
            ├─ metrics.observe('kg_pagerank_duration_ms', Date.now() - t0)
            ├─ metrics.gauge('kg_pagerank_nodes_scored', total)
            └─ return summary → scheduler → PipelineLog
```

### Request-time read

```
Client → GET /knowledge-graph/neighborhood?slug=X
  → knowledge-graph-service.js::onNeighborhood
       ├─ rows        = await callKGQuery('NEIGHBORHOOD', X)   [SPARQL, unchanged]
       ├─ coMap       = await loadCoCompletions(X)              [existing]
       ├─ teachesMap  = await loadTutorialTeaches(X)            [existing]
       ├─ rankMaps    = KG_PAGERANK_ENABLED
       │                  ? await loadRankMaps()   [LRU-cached, 5-min TTL]
       │                  : { conceptRank: EMPTY, tutorialRank: EMPTY }
       └─ rankNeighborhood(rows, X, coMap, teachesMap, rankMaps, opts)
            └─ per arm builder:
                 const pr = rankMaps.tutorialRank.get(candidate.slug) ?? 0;
                 const norm = rankMaps.tutorialRank._normalize(pr);  // stashed helper
                 base.weight *= (1 + α × norm);
```

**Normalization.** Min-max over `tutorialRank.values()`, computed **once** at
cache-fill time and stashed on the cached object. Degenerate cases:

- Empty map (fresh DB, first-run gap) → returns 0 → multiplier collapses to
  1.0 → fail-open.
- `min === max` (all scores equal, degenerate graph) → returns 0 → fail-open.

**Cache invalidation.** 5-minute TTL is sufficient — nightly writes happen
once per day, and a ranker showing "yesterday's PageRank" for ≤5 min after
tonight's job is fine. No explicit bust needed.

## Error handling & rollback

### Procedure-level failures

- **GraphScript exception inside `Compute_Pagerank`** (e.g. workspace missing
  after schema drift): surfaces as SQL error from the `CALL` → the `db.tx`
  wrapper rolls back both TRUNCATEs → yesterday's scores stay live. Job
  returns `{error, durationMs}`; scheduler logs to `PipelineLog` with
  `status: 'FAILED'`. `kg_pagerank_failures` counter increments.
- **Zero-vertex workspace** (fresh DB, no concepts): `Compute_Pagerank`
  returns empty map → both INSERTs are no-ops → tables end empty → ranker
  fail-opens. Not an error. Logged as `{conceptsScored: 0, tutorialsScored: 0}`.
- **Job overrun:** `ttlMs = 600000` (10 min). Expected wall-clock at prod
  scale (~6k vertices, 8k edges post-#919) is < 5s. 10 min ceiling is loud
  headroom.

### Request-time failures

- **`loadRankMaps()` throws** (HANA hiccup, network): catch → increment
  `kg_pagerank_read_failures` → return empty maps → ranker fail-opens.
  Never propagates to the client.
- **Cache stampede:** single-flight guard on the LRU — concurrent callers on
  the same TTL window share the in-flight promise. Prevents N concurrent
  neighborhood requests from firing N parallel `SELECT * FROM ConceptRank`.
- **Sidecar tables missing** (deploy skew): `SELECT` throws → caught →
  fail-open. Same path as above.

### Rollback

- **Fastest revert:** `cf set-env tutorials-srv KG_PAGERANK_ENABLED false &&
  cf restart tutorials-srv`. Ranker stops loading rank maps immediately.
  Job keeps running nightly (wasted ~5s), tables keep filling — harmless.
- **Job stop:** if the compute itself is misbehaving (burning DB CPU), remove
  the `registerJob` entry in `scheduler.js` and redeploy. The env flag alone
  doesn't stop the writer.
- **Data revert:** truncate `ConceptRank` / `TutorialRank` from `hdbsql` —
  untethered from the code path once the flag is off. No migration needed.

**No data corruption path.** Worst case is stale scores (multi-day-old
PageRank), which still fail-opens gracefully. The multiplier is
`(1 + α × normalized)` where `normalized ∈ [0, 1]` and `α = 1` by default —
weights grow at most 2× — bounded.

## Testing

### Hybrid test — `test/hybrid/kg-pagerank.test.js`

Prefix `__TEST__kg-pagerank-<runId>-`, `runId` from `crypto.randomBytes(3)`.
Guarded by `ALLOW_HYBRID_WRITES=true` via `_guard.js`. 120s test timeout.

**Fixture — hub-and-spoke:**

```
         hub-concept
        /     |      \
    leaf-c1  leaf-c2  leaf-c3     (3 leaf concepts require the hub)
       ↑        ↑         ↑
   spoke-t1  spoke-t2  spoke-t3   (each spoke tutorial teaches one leaf)
                    ↑
             hub-tutorial          (one tutorial teaches only the hub)
```

Seed: 4 concepts (1 hub + 3 leaves), 4 tutorials (1 hub-teacher + 3 leaf-teachers),
3 ConceptEdges (leaf→hub `requires`), 4 TutorialConceptLinks (each tutorial→its
concept, predicate `teaches`). CoCompletions untouched — this test isolates
pure PageRank ordering. FK-safe setup order:
Concepts → Tutorials → ConceptEdges → TutorialConceptLinks.

**Test body:**

```js
await db.run('TRUNCATE TABLE "COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"');
await db.run('TRUNCATE TABLE "COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"');
await db.run('CALL "KG_PAGERANK"()');

const conceptRanks = await db.run(
  `SELECT SLUG, SCORE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"
     WHERE LOWER(SLUG) LIKE '__test__kg-pagerank-${runId}-%'`);
const tutorialRanks = await db.run(
  `SELECT SLUG, SCORE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"
     WHERE LOWER(SLUG) LIKE '__test__kg-pagerank-${runId}-%'`);
```

**Assertions:**

1. `conceptRanks.length === 4` and `tutorialRanks.length === 4`. (populated)
2. `hub-concept.score > every leaf.score`. (hub-and-spoke topology)
3. `hub-tutorial.score > every spoke-tutorial.score`. (hub-teaching lifts rank)
4. `abs(leaf-c1.score - leaf-c2.score) / avg < 0.05` for all leaf pairs. (symmetry)
5. All scores are finite doubles in `(0, 1]`.

**Teardown** (`afterAll`, FK-safe order): TutorialConceptLinks → ConceptEdges →
Tutorials → Concepts. Fixture rows in `ConceptRank`/`TutorialRank` deleted by
the same `LIKE '__test__…'` filter.

### QA-channel test

Add one assertion to `test/hybrid/kg-procedures-qa.test.js` (or the equivalent
QA-stub coverage file): `CALL "KG_PAGERANK"()` on QA raises
`KG_NOT_AVAILABLE_ON_QA`.

### Not tested in v1

- **Ranker blend math.** No unit test for `weight * (1 + α × pageRank)` —
  correctness ensured by inspection of a 4-line function.
- **Ranker end-to-end with flag on.** No test asserting neighborhood ordering
  changes vs flag-off. If regressions surface post-DEV rollout, add as
  follow-up.
- **Smoke test.** No new smoke test. Nightly job runs on DEV after deploy;
  broken procedure surfaces in `PipelineLog` overnight.

## Rollout

1. **Prereq gate.** Do NOT merge #916 work until #919 is merged and
   `KG_PG_EDGES_V` includes `coCompletedWith`. Verify by inspecting the
   deployed view definition. Hard block.
2. **Deploy dark.** Merge #916 with `KG_PAGERANK_ENABLED` unset. Job runs
   nightly on DEV starting the next 03:53 UTC. Ranker still uses old blend
   (fail-open path).
3. **Verify data.** Morning after first run:
   - `SELECT COUNT(*), MIN(SCORE), MAX(SCORE), AVG(SCORE) FROM ConceptRank`
     (and same for TutorialRank).
   - Sanity-spot-check: top 5 tutorials by score should be recognizable hub
     tutorials (Bookshop bootstrap, ABAP RAP intro, etc.).
   - If nothing populated → check `PipelineLog WHERE jobName = 'kg-pagerank'`.
4. **Flip flag on DEV.** `cf set-env tutorials-srv KG_PAGERANK_ENABLED true &&
   cf restart tutorials-srv`. Wait 5 min for LRU to warm.
5. **DEV soak.** 48h of neighborhood traffic under the flag. Monitor
   `kg_pagerank_read_failures` (must be 0) and `kg_pagerank_duration_ms` p95
   (should be sub-second). Manually eyeball the "What to learn next" sidebar
   on 3–5 randomly-picked tutorial pages.
6. **PROD.** Out of scope for #916. Spike is DEV-only per #913 non-goals;
   PROD rollout is a follow-on decision after #917 / #918 also land.

### Success criteria

Tracked in a follow-on review artifact modeled on the #913 gate review:

- Nightly job wall-clock < 60s at prod scale (~6k vertices, 8k edges post-#919).
- Zero `kg_pagerank_read_failures` in 48h DEV soak.
- Neighborhood p95 latency does NOT regress > 20% vs pre-flag baseline.
- Qualitative: top-5 tutorials by PageRank match team intuition on ≥ 4/5.

## Non-goals (from issue #916)

1. Not exposing scores on the OData surface for admin editing.
2. Not weighting v1's SPARQL PREREQ query (KG_QUERY literals stay).

## Follow-on issues (out of scope)

- **#917** community detection for auto-suggested missions/groups
- **#918** WCC as curation quality signal
- **#919** widen `KG_PG_WORKSPACE` to 9-predicate parity (this design's prereq)

## Environment variables

| Name | Type | Default | Effect |
|---|---|---|---|
| `KG_PAGERANK_ENABLED` | boolean string | unset (`'false'`) | When `'true'`, ranker loads and blends `ConceptRank`/`TutorialRank`. |
| `KG_PAGERANK_ALPHA` | number | `1.0` | Blend strength. `weight *= (1 + α × normPR)`. |

## Metrics

| Name | Kind | Description |
|---|---|---|
| `kg_pagerank_duration_ms` | observe (reservoir) | Wall-clock of nightly job. |
| `kg_pagerank_nodes_scored` | gauge | `conceptsScored + tutorialsScored` after each run. |
| `kg_pagerank_failures` | counter | Nightly job caught-exception increments. |
| `kg_pagerank_read_failures` | counter | Request-time `loadRankMaps()` exceptions. |

All surface to `MetricSnapshots` via `srv/jobs/metrics-rollup-job.js` and are
viewable at `/admin-ui/#metrics`.

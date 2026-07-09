# Move KG cosine similarity into HANA (issue #1113)

**Status:** Approved for planning
**Author:** Thomas Jung (with agent assistance)
**Date:** 2026-07-09
**Related:** PR #1112 (shared LRU cache — Tier-0 fix), issues #1114 (timeout cancellation), #1115 (Concepts row-growth audit)

## Problem

Joule search latency root cause per production metrics (2026-07-09, DEV):

```
search.kg.rerank.ms  p50=19640ms  p95=36763ms  max=36763ms  count=3
search.kg.cache.miss value=4       (zero cache hits in the window)
POST /chat/stream    response_time:39.972127
```

`srv/lib/kg/concept-embedding-query.js::topConceptsByCosine()` on HANA does JS-side
cosine over ~5,946 `Concepts.embedding` BLOBs:

1. Pull every ACTIVE, published, non-merged `Concepts` row.
2. Stream each 6 KB Float32-LE BLOB back in 200-row batches over HDBEXT.
3. Decode each BLOB and cosine-loop in Node.

At 5,946 rows this now takes 20 s cold. As #948 on-demand extraction grows the
table it will only get worse. PR #1112 collapsed the double-scan (expand +
search shared one signal), so a warm turn is ~ms — but the first hit in any
5-min window still costs the full scan.

## Solution

Push cosine into HANA's vector engine. `COSINE_SIMILARITY(REAL_VECTOR, TO_REAL_VECTOR(?))`
runs on the DB side in ~milliseconds; result is one small round-trip instead of
5,946 BLOB streams.

Discovery during design: **`TutorialEmbedding.EMBEDDING` is already
`REAL_VECTOR(1536)` in HANA** (CDS `Vector(1536)` compiles to native REAL_VECTOR).
Only `Concepts.EMBEDDING` predates that CDS feature and is a `BLOB`. The
"migration" is really "align Concepts with the shape TutorialEmbedding already
has."

## Decisions (locked during brainstorming)

| Decision | Choice | Reason |
|---|---|---|
| Scope | Concepts + TutorialEmbedding in one PR | Same wire-format shift; single HDI cycle |
| Column strategy | Add new `embeddingVec: Vector(1536)`; keep BLOB during transition | Zero-downtime, reversible |
| Rollout gate | Flip on merge (no env flag) | Fastest to demo win; rollback is git-revert |
| Backfill trigger | Extend existing `concept-embedding-backfill.js` job | Reuse lock, retry, telemetry |
| BLOB retention | Keep the `embedding` BLOB column post-merge; drop in a follow-up after 2 weeks stable | Preserves rollback escape hatch |

## Architecture

### Data flow (per query, post-#1113)

```
Joule turn OR OData $search
        ↓
computeKgSignal (unchanged public API from #1112)
        ↓
        embed query (existing AI Core call, ~200 ms)
        ↓
        ONE HANA round-trip:
            SELECT TOP N ID, SLUG, NAME,
                   COSINE_SIMILARITY(EMBEDDINGVEC, TO_REAL_VECTOR(?)) AS score
            FROM   COM_SAP_DEVELOPERS_IMS_CONCEPTS
            WHERE  STATUS='ACTIVE' AND PUBLISHEDAT IS NOT NULL
                   AND MERGEDINTO_ID IS NULL
                   AND EMBEDDINGVEC IS NOT NULL
            ORDER BY score DESC
        ↓
        seed set (5–200 ms expected)
        ↓
        existing 1-hop edge walk + link fetch (unchanged; small IN-lists)
        ↓
        signal cached in the 5-min LRU (#1112)
```

### Table treatment

| Table | Current column type | Change |
|---|---|---|
| `Concepts` (5,946 active rows) | `EMBEDDING BLOB` | Add `EMBEDDINGVEC REAL_VECTOR(1536)`; backfill; keep BLOB for rollback |
| `TutorialEmbedding` (step-level) | `EMBEDDING REAL_VECTOR(1536)` | **No schema change** — just rewrite the query |

### What stays the same

- 5-min LRU + single-flight promise map in `search-kg-signal.js` (#1112).
- 1-hop edge walk on `ConceptEdges` and metadata hydration in `_search-fetches.js`.
- `KgSignal` shape (`slugScores`, `slugRationale`, `slugTitle`, `topConcepts`).
- SQLite dev path — JS-side cosine over Float32-LE BLOB (small dataset, no perf concern).
- Joule tool contracts, LLM-facing envelopes, warning codes.

### What changes

- `db/knowledge-graph.cds` — one new field on `Concepts`.
- `srv/lib/kg/concept-embedding-query.js` — HANA branch becomes one SQL.
- `srv/lib/kg/on-demand-cosine-rank.js` — HANA branch becomes one SQL.
- `srv/lib/kg/_search-fetches.js` — additive `fetchTutorialsByIds` helper
  for the new on-demand-rank metadata hydration.
- `srv/jobs/concept-embedding-backfill.js` — writes both columns during transition.
- Two new test files (one unit, one hybrid).

## Schema migration

### CDS change

`db/knowledge-graph.cds` — one line added:

```cds
entity Concepts : cuid, managed {
  // ...existing fields...
  embedding       : LargeBinary;                    // legacy raw Float32-LE BLOB (retained for rollback)
  embeddingVec    : Vector(1536);                   // #1113: HANA-native REAL_VECTOR for server-side cosine
  // ...
}
```

`db/schema.cds` for `TutorialEmbedding`: **no change** (column already
`Vector(1536)`).

### Deploy sequence

1. Regenerate `db/last-dev/csn.json`:
   ```bash
   npx cds build --production
   ```
2. Merge PR. Standard full MTA deploy runs `tutorials-db-deployer` — HDI adds
   `EMBEDDINGVEC REAL_VECTOR(1536)` column with NULLs.
3. Manually trigger `concept-embedding-backfill` via `/admin-ui/#jobs` (or wait
   for its scheduled run). It sees `EMBEDDINGVEC IS NULL` on all 5,946 rows
   and fills them.
4. Backfill finishes; cosine query path lights up.

### Failure modes

- **HDI adds column but deploy fails elsewhere:** empty column, existing BLOB
  intact, pre-#1113 JS-cosine path unaffected.
- **Backfill job errors on a row:** `WHERE EMBEDDINGVEC IS NOT NULL` guard
  skips it; it returns to the pool for the next run. Only impact: that
  concept is not seed-eligible until backfilled.
- **HANA cosine misbehaves in prod:** git-revert code PR. BLOB still
  populated; cosine consumers revert to pre-#1113 JS path.
- **Full schema rollback:** requires a follow-up MTA deploy to remove the
  column. Not needed for the "code broke" case.

## Query rewrite

### `srv/lib/kg/concept-embedding-query.js`

HANA branch replaced with one statement:

```js
export async function topConceptsByCosine({ db, queryVector, limit = 5 }) {
  const gate = "STATUS='ACTIVE' AND PUBLISHEDAT IS NOT NULL AND MERGEDINTO_ID IS NULL"

  if (isHana(db)) {
    // Serialize Float32Array as HANA's REAL_VECTOR string literal.
    // 6-decimal precision is below Float32 precision but well above cosine
    // sensitivity: identical inputs still score 1.0 to ~5 decimal places.
    const vecStr = '[' + Array.from(queryVector, x => x.toFixed(6)).join(',') + ']'
    return await db.run(
      `SELECT TOP ? ID as id, SLUG as slug, NAME as name,
              COSINE_SIMILARITY(EMBEDDINGVEC, TO_REAL_VECTOR(?)) AS score
       FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS
       WHERE ${gate} AND EMBEDDINGVEC IS NOT NULL
       ORDER BY score DESC`,
      [limit, vecStr]
    ) || []
  }

  // SQLite path — unchanged JS-side cosine over Float32-LE BLOB.
  // ... existing code ...
}
```

**Design notes:**

- **Literal-string vector via `TO_REAL_VECTOR(?)`:** the driver's binary
  REAL_VECTOR wire format is undocumented and known to reject arbitrary
  BLOBs (we hit "dimension of 3172474880" during exploration). The
  string-cast is the supported entry point per HANA Cloud docs. One 14 KB
  parse per query is trivial next to 20 s of BLOB streaming.
- **`TOP ?` bound param:** parameterizes `limit` so plan cache works
  across callers (5 for KG signal, up to 10 for expand).
- **`EMBEDDINGVEC IS NOT NULL`:** covers the transient state during
  backfill. Rows not yet backfilled simply don't appear as seeds; on-demand
  extraction (#948) already handles the "no seeds" case.

### `srv/lib/kg/on-demand-cosine-rank.js`

Same shape but with MAX aggregate across a tutorial's step embeddings:

```sql
SELECT TOP ? TUTORIAL_ID as tutorial_id,
       MAX(COSINE_SIMILARITY(EMBEDDING, TO_REAL_VECTOR(?))) AS score
FROM COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING
WHERE EMBEDDING IS NOT NULL
GROUP BY TUTORIAL_ID
ORDER BY score DESC
```

Slug/title hydrate in a second small IN-list `SELECT ID, SLUG, TITLE FROM
COM_SAP_DEVELOPERS_IMS_TUTORIALS WHERE ID IN (?…)` query. This is the same
two-phase "IDs first, then hydrate metadata" pattern that
`_search-fetches.js::fetchConceptsByIds` uses for concepts; the plan will
add a sibling `fetchTutorialsByIds` helper to `_search-fetches.js` so both
tables use the same convention.

### `srv/lib/kg/search-kg-handler.js`

Calls `topConceptsByCosine` — no changes required; gets the new speed
for free.

### Not touched

- `srv/lib/search-kg-signal.js` (calls `topConceptsByCosine`; LRU
  unchanged).
- `srv/lib/kg/joule-tool-expand-concepts.js` (unchanged after #1112).
- `SearchService.before('READ')` hook.

### Touched additively (behavior-preserving)

- `srv/lib/kg/_search-fetches.js` gains a new `fetchTutorialsByIds`
  sibling helper (metadata hydration for `on-demand-cosine-rank.js`).
  Existing helpers (`fetchEdges`, `fetchConceptsByIds`, `fetchLinks`)
  unchanged; existing callers unaffected.

### Edge cases

- **Zero-vector inputs:** `COSINE_SIMILARITY` on two zero vectors is
  undefined. HANA returns NULL per docs; `ORDER BY score DESC` sends NULLs
  last. Backfill already skips empty text (`if (!text.trim()) continue`)
  so no zero-embeddings should exist.
- **Result range:** [-1, 1]. Existing consumers score-multiply and sum; no
  code assumes [0, 1]. Behavior-preserving vs. JS path.
- **Tie-breaking non-determinism:** identical scores may reorder. Existing
  JS path has the same property; not new behavior.

## Backfill

`srv/jobs/concept-embedding-backfill.js` gets two adjustments:

1. **Candidate query:** change `WHERE EMBEDDING IS NULL` to
   `WHERE EMBEDDING IS NULL OR EMBEDDINGVEC IS NULL` so rows with a BLOB
   but no vector column get filled.
2. **UPDATE:** write both columns:
   ```js
   const vecStr = '[' + Array.from(vec, x => x.toFixed(6)).join(',') + ']';
   await dbHandle.run(
     `UPDATE COM_SAP_DEVELOPERS_IMS_CONCEPTS
      SET EMBEDDING = ?, EMBEDDINGVEC = TO_REAL_VECTOR(?) WHERE ID = ?`,
     [blob, vecStr, id]
   );
   ```

Existing distributed lock, retry, and telemetry stay as-is. Job takes
~1 min for 5,946 rows (embed API is the bottleneck, batched 20/req).

## Testing

### Unit (in-memory SQLite)

Existing tests remain green — they exercise the SQLite JS-cosine branch,
untouched.

**New:** `test/unit/kg/concept-embedding-query-hana.test.js` — structural
probe with mocked `db.run`:

- SQL contains `COSINE_SIMILARITY(EMBEDDINGVEC, TO_REAL_VECTOR(?))`.
- Vector param is `[...]` string with exactly 1,536 comma-separated floats.
- `TOP ?` param carries the caller's `limit`.
- `WHERE ... EMBEDDINGVEC IS NOT NULL` present.

Sibling test for `on-demand-cosine-rank.js` covering the
`MAX(COSINE_SIMILARITY(...)) GROUP BY TUTORIAL_ID` shape.

### Hybrid (real HANA via `cds bind`)

**New:** `test/hybrid/kg-hana-cosine.test.js` — three tests:

1. **Backfill smoke:** run `runConceptEmbeddingBackfill`, then assert
   `SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE EMBEDDINGVEC
   IS NULL AND STATUS='ACTIVE'` is 0 (or converges to 0 across two runs).
2. **Latency SLO:** wall-clock a `topConceptsByCosine({limit:5})` call.
   Assert < 1,500 ms (10× safety margin over expected 100–200 ms).
3. **Behavior parity:** for a fixed seed vector, HANA top-5 slugs match
   the pre-#1113 JS-cosine top-5 on the same data. Tolerates score delta
   ≤ 1e-4 (float precision from `.toFixed(6)`).

Runs in existing `hybrid` vitest project via `npm run test:hybrid`; no
CI workflow changes.

### Not tested

- HANA cosine correctness itself (SAP's responsibility).
- 20 s cold-scan regression (old path is gone post-merge).
- Load test — #1115 owns row-growth concerns.

### Manual verification checklist (post-deploy)

1. `curl -sI https://tutorial-system-dev-tutorials-srv.../health` → 200.
2. hana-cli: `SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE
   EMBEDDINGVEC IS NULL AND STATUS='ACTIVE' AND PUBLISHEDAT IS NOT NULL
   AND MERGEDINTO_ID IS NULL` returns 0.
3. Navigator: cold `POST /chat/stream` < 5 s; warm < 1 s.
4. Metrics rollup: `search.kg.rerank.ms` p95 < 500 ms in first 5-min
   window post-deploy.

## Rollout

### PR sequence

Branch: `worktree-hana-cosine-1113`. Commits (single PR, but logical):

1. `feat(#1113): add Concepts.embeddingVec Vector(1536) column`
2. `feat(#1113): backfill Concepts.embeddingVec alongside existing BLOB`
3. `feat(#1113): topConceptsByCosine uses HANA COSINE_SIMILARITY on HANA`
4. `feat(#1113): rankTutorialsByCosine uses HANA COSINE_SIMILARITY on HANA`
5. `test(#1113): unit + hybrid coverage for HANA cosine path`

Open draft; run CI (unit + hybrid + docs); flip to ready.

### Deploy scope

**NOT srv-only.** Column addition requires `tutorials-db-deployer`, i.e.
full MTA:

```bash
cd .deploy
mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

~5 min on DEV. HDI `ALTER TABLE ADD COLUMN` is fast; `tutorials-srv`
restarts in ~30 s. 5-min LRU empties on restart; first Joule turn
post-deploy is cold-cache but the new SQL path is still fast.

### Backfill trigger

Immediately post-deploy: `/admin-ui/#jobs` → kick
`concept-embedding-backfill` manually. Distributed lock prevents double
runs. If missed, next scheduled run picks it up automatically. Cosine
consumers return empty seeds for un-backfilled rows in the meantime;
LLM/rank paths already tolerate this.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| HANA cosine SQL parse error on driver quirk | Low | High (all Joule turns 0-seed) | Hybrid test catches pre-merge; git-revert restores JS path |
| Backfill embed API rate-limit | Low | Med (partial coverage) | Existing job's per-batch throttling; auto-retries next cron |
| Behavior parity fails (top-5 differs from JS path) | Very low | Med (search results shift) | Cosine is deterministic; parity test asserts ≤1e-4 delta |
| Vector column added but `cds build` skipped | Low | High (deploy fails) | Global rule: `npx cds deploy --to sqlite::memory:` in pre-commit + CI |
| Concept row growth outpaces HANA cosine (100k+) | Very low near-term | Info | #1115 owns growth question |

## Rollback

- **Code broken, schema OK:** git-revert PR. BLOB column untouched. All
  pre-#1113 paths work. Redeploy `tutorials-srv` scenario #3. ~2 min RTO.
- **HDI failure during deploy:** MTA rolls back the module. Column not
  created. No app-level fallout.
- **HANA cosine misbehaves weeks later:** revert code, keep schema.
  Column is dead weight until dropped.

## Follow-ups

Filed at PR close:

- `chore(#1113 followup): drop Concepts.embedding BLOB column after
  2 weeks stable` — two commits: null column, then remove from CDS +
  `cds build`. Not blocking.

## Success criteria

- p95 `search.kg.rerank.ms` drops from 36 s → **< 500 ms** in metrics
  rollup within 15 min of backfill completion.
- No new errors matching `cosine|vector|REAL_VECTOR` in
  `cf logs tutorials-srv --recent`.
- Joule "Find tutorials about: abap cloud" cold query < 5 s
  end-to-end; warm repeat < 1 s.
- Hybrid CI green.
- Unit CI green.

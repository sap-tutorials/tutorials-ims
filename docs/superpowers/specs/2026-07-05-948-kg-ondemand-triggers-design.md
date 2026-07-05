# On-Demand KG Rebuild Triggers from `expandSearchConcepts`

**Issue:** [#948](https://github.com/sap-tutorials/tutorials-ims/issues/948) — kg: on-demand rebuild triggers from expandSearchConcepts
**Parked from:** [#943](https://github.com/sap-tutorials/tutorials-ims/issues/943) — Tutorial Navigator Search Improvements Part 3
**Related:** [#916](https://github.com/sap-tutorials/tutorials-ims/issues/916) (PageRank), [#917](https://github.com/sap-tutorials/tutorials-ims/issues/917) (Communities), [#918](https://github.com/sap-tutorials/tutorials-ims/issues/918) (WCC isolation) — recent KG jobs whose scaffolding this feature mirrors
**Date:** 2026-07-05
**Status:** Design — awaiting user review before plan

---

## Summary

The `expandSearchConcepts` Joule tool (shipped in #943) consumes the current state of `Concepts`, `TutorialConceptLinks`, and `ConceptEdges`. When a user's query embeds to a region of vector space with no seed concepts within cosine range, the tool returns `{ concepts: [], tutorials: [] }` — a cache miss the LLM can only recover from via `searchTutorials` keyword fallback.

Today the KG is rebuilt only from two sources:

- Admin action at `/admin-ui/#kg-display` (manual)
- Scheduled cron: `srv/jobs/extract-concepts-job.js` iterates ACTIVE tutorials whose body-hash or model-version differs from the last extraction

New tutorials published between cron ticks stay invisible to the search tool until the next tick — the `extractConcepts` cron runs **daily at 02:13 UTC** (`13 2 * * *` in `srv/jobs/scheduler.js`), so worst-case a newly-published tutorial is invisible to the KG for ~24h — and even then only if the corpus-wide `KG_EXTRACT_BUILD_CAP` budget lets the tick reach it.

This spec adds a **feature-flagged on-demand extraction path**: when a zero-seed query reaches the tool, and the new `KnowledgeGraphSettings.onDemandExtractionEnabled` flag is on, the handler fire-and-forgets an enqueue call. A new 2-minute cron (`srv/jobs/kg-ondemand-job.js`) drains the queue, cosine-ranks the corpus by query similarity, and runs `extractConceptsFromTutorial` on the top-K matches. All net-new code lives behind an off-by-default flag so production behavior is byte-identical until the flag flips.

## Goals

- Close the "new tutorials published, KG still stale" gap for user-observed queries.
- Ship the observability + coalescing scaffolding the #948 prerequisites list explicitly requests (cache-miss metrics, LLM cost model, job-lock coalescing).
- Keep production behavior identical until an admin toggles the flag; give admins a visible surface to watch the queue before flipping it.
- Fail-open on every fault path — the tool's ≤5s wall-clock budget and existing error contract are inviolable.

## Non-goals (deliberately parked)

- Low-similarity signal (top-1 seed below threshold). Zero-seed only in v1.
- Stale-`contentHash` re-link path. Requires per-tutorial content-hash reads mixed with link fetches; the "concepts loosely match the query, tutorials look stale" case doesn't have a clean signal without doing the extraction anyway.
- Embedding-similarity dedup at the enqueue layer. Normalized-string coalescing is the v1 mechanism; if metrics show large numbers of "different-string, same-meaning" duplicates in DEV, we can revisit.
- HANA-backed rate-limit counters. In-memory sliding windows suffice for the single-instance `tutorials-srv` DEV deployment; multi-instance rollout would revisit.
- Enqueue-time drain kick. The 2-minute cron cadence is predictable enough for v1; sub-minute latency is not a goal.

## Prerequisites addressed

The #948 issue text lists three prerequisites that must land alongside the trigger itself. This spec addresses all three:

1. **Cache-miss metrics from production** — new `kg_ondemand_{enqueued, dedup_coalesced, accepted, rate_limited, extracted, failures, latency_ms}` counters. Plus the existing `kg.joule.search_expansion_returned` telemetry already emits `resultCount: 0` on zero-seed at line 132 of `joule-tool-expand-concepts.js`, so pre-flag baseline data is already collectable.
2. **Cost model for LLM-backed on-demand extraction** — the drain job's ceiling is `DRAIN_BATCH × TUTORIALS_PER_REQ` LLM calls per tick (default 3 × 5 = 15 calls per 2 min → ≤450 calls/hr → ≤10.8k calls/day if the queue is *saturated* the whole time). The queue is *not* saturated in steady state: enqueues are gated by the per-user (3/hr) and global (20/hr) caps, so real-world upper bound is `min(saturated, 20 × TUTORIALS_PER_REQ = 100 calls/hr)`. For comparison, the daily corpus `extractConcepts` tick runs up to `KG_EXTRACT_BUILD_CAP=200` calls once per 24h. On-demand adds ~2.4k calls/day at the global cap ceiling — larger than daily corpus, but bounded and admin-tunable. Per-request LLM cost is captured in `KgOnDemandRequests.llmPromptTokens` / `.llmCompletionTokens` so admins can build a real cost curve before wider rollout.
3. **Job-lock coordination so multiple simultaneous triggers coalesce** — two-layer defense: (a) normalized-key coalescing at the enqueue INSERT, so bursts of near-duplicate queries produce one row; (b) `job-lock.js` `runWithLock('kg-ondemand', ...)` around the drain, so at most one instance ever runs the drain at a time.

---

## Section 1 — Architecture

### Hot path — inside `expandSearchConceptsHandler`

`srv/lib/kg/joule-tool-expand-concepts.js` gains one branch inside the existing zero-seed block:

```js
if (seeds.length === 0) {
  telemetry?.emit?.('kg.joule.search_expansion_returned', {
    resultCount: 0, latencyMs: Date.now() - t0,
  })

  // NEW: fire-and-forget. Never awaited on the tool's critical path.
  // Catches its own errors so a DB blip cannot mask the tool's success.
  enqueueOnDemandExtraction({ db, query: rawQuery, requester }).catch(err => {
    LOG.warn('enqueueOnDemandExtraction dispatch failed:', err.message)
  })

  return { queryEcho: rawQuery, concepts: [], tutorials: [] }
}
```

`requester` is a new opt threaded through from `srv/lib/chat-orchestrator.js:595`. Shape:

```js
{ id: req.user?.id, ipHash: req.userIpHash, kind: req.user?.id ? 'user' : 'anon' }
```

Backward-compat: if the caller doesn't pass `requester`, the enqueue path treats it as anonymous with `id = 'unknown'`, which burns against the global cap but never a user cap. This keeps the existing test suite green without threading `requester` into every fixture.

### Cold path — new module `srv/lib/kg/on-demand-enqueue.js`

Pure enqueue logic. No LLM calls, no cron dependencies. Reads flag settings, applies rate limits, writes a queue row.

```
enqueueOnDemandExtraction({ db, query, requester }):
  1. Load kgSettings via resolveKnowledgeGraphSettings().
     Bail if !onDemandExtractionEnabled OR !enabled.
  2. normalizedKey = normalize(query)
       lowercase, /\s+/g → single space, /[^\w\s]/g → drop, trim.
       Bail (silent) if empty after normalization.
  3. checkUserBudget(requester)
       In-memory sliding window keyed by requester.id (or 'anon' if kind='anon').
       On breach: emit kg_ondemand_rate_limited { reason: 'user' }; return.
  4. checkGlobalBudget()
       Shared in-memory sliding window.
       On breach: emit kg_ondemand_rate_limited { reason: 'global' }; return.
  5. INSERT-WHERE-NOT-EXISTS:
       INSERT INTO KgOnDemandRequests (ID, query, normalizedKey, requestedBy,
                                       requestedByKind, status)
       SELECT :ID, :query, :normalizedKey, :requestedBy, :requestedByKind, 'PENDING'
       WHERE NOT EXISTS (
         SELECT 1 FROM KgOnDemandRequests
         WHERE normalizedKey = :normalizedKey AND status IN ('PENDING', 'RUNNING')
       )
     If 0 rows inserted → coalesce collision:
       emit kg_ondemand_dedup_coalesced { normalizedKey }; return.
     If 1 row inserted:
       increment both budget counters.
       emit kg_ondemand_enqueued { normalizedKey, requesterKind: requester.kind }.
```

Rate limits reuse the sliding-window class in `srv/lib/per-user-rate-limit.js`. Two module-scoped instances (user + global). In-memory, per-process. Documented limitation: accurate under single-instance DEV; multi-instance rollout must migrate to a HANA counter table.

### Drain — new job `srv/jobs/kg-ondemand-job.js`

Registered in `srv/jobs/scheduler.js` next to the other KG jobs via `registerJob(...)`. Cron: `1-59/2 * * * *` — every 2 minutes on odd minutes (:01, :03, :05, …). The odd-minute cadence avoids stacking with `extractConcepts` (02:13 daily), `kg-pagerank` (:53), `kg-communities` (:57), `kg-wcc` (04:07), and the project's :00/:30 thundering-herd convention.

```
runOnDemandDrain({ db, callModel, embed, log } = deps):
  1. Load kgSettings.
     If !enabled: return { reason: 'kg-disabled', ...zeroSummary }.
     If !onDemandExtractionEnabled: return { reason: 'ondemand-disabled', ...zeroSummary }.
  2. runWithLock('kg-ondemand', instanceId, LOCK_MS = 5 * 60 * 1000, drainImpl)
     where drainImpl does:
       a. SELECT ID, query, attempts FROM KgOnDemandRequests
          WHERE status = 'PENDING'
          ORDER BY requestedAt ASC
          LIMIT :DRAIN_BATCH.
       b. For each row:
            UPDATE ...set status='RUNNING', startedAt=$now, attempts=attempts+1.
            queryVector = embed(query).
            top-K = cosineRankTutorials(db, queryVector, K).
            for each { tutorialId } in top-K:
              extraction = extractConceptsFromTutorial({ tutorial, callModel, ... })
              merge-on-write via kg-merge-on-write.js (SAME path as extract-concepts-job.js).
            UPDATE row: status='DONE', completedAt=$now, latencyMs,
                        tutorialsExtracted, conceptsCreated, conceptsMerged,
                        llmPromptTokens, llmCompletionTokens.
          On throw:
            if attempts < MAX_ATTEMPTS: UPDATE status='PENDING', lastError.
            else: UPDATE status='FAILED', lastError. Emit kg_ondemand_failures.
          Row-level failures never abort the batch — sibling rows still process.
       c. Emit summary metric kg_ondemand_drain_tick { processed, extracted, failed, durationMs }.
  3. Return structured summary for formatJobSummary.
```

`cosineRankTutorials(db, queryVector, K)` — mirrors the two-phase pattern already used in `srv/lib/kg/concept-embedding-query.js` (see the header comment: "HANA path uses raw db.run() to avoid LOB-locator expiry: fetch IDs+metadata first (never SELECT the BLOB alongside metadata), then hydrate embeddings by ID"):

- **HANA**: raw `db.run()` step 1 fetches `tutorial_ID, stepNumber` for ACTIVE-gated rows (no BLOB). Step 2 hydrates the `embedding` BLOB by ID in chunks. Cosine computed in Node.js over the decoded `Float32Array` (same `decodeEmbedding` + `cosine` helpers as `concept-embedding-query.js`). Aggregate per-tutorial as `MAX(cosine)` across steps of the same tutorial. Return top-K `tutorial_ID`s.
- **SQLite**: single SELECT with a JS-side cosine loop, same as `topConceptsByCosine`'s SQLite branch.
- Result set is filtered to ACTIVE tutorials via a join to the publish-gate view — non-ACTIVE (DRAFT / DELETED) slugs must never trigger extraction, both to avoid poisoning the KG with unpublished content and to match the corpus cron's behavior.

**Note**: `Vector(1536)` is a BLOB in HANA. The LOB-expiry rule applies. Do not use CDS QL for this fetch on HANA — raw `db.run()` with the two-phase pattern is mandatory. Unit tests can use CDS QL because SQLite doesn't have LOB locators.

### Admin surface — `/admin-ui/#kgOnDemand`

New FE List Report + Object Page at `app/kgOnDemand/`. Structure mirrors `app/kgCommunities/` from #917. Read-only projection over `KgOnDemandRequests`, gated on XSUAA scope `Tutorial.Author`.

**Session-start hint honored:** the `@readonly` annotation lives on the service-layer projection (`AdminService.KgOnDemandRequests as projection on KgOnDemandRequests @readonly`), not on the DB entity itself — schema stays flexible for the drain job's writes.

Columns visible in LR: query, normalizedKey, status, attempts, tutorialsExtracted, conceptsCreated, conceptsMerged, latencyMs, requestedAt, completedAt, lastError.
Filter bar: status, requestedByKind, requestedAt range.
Sort default: requestedAt DESC.

Object Page shows all of the above plus llmPromptTokens/llmCompletionTokens — the LLM cost accounting the #948 prerequisite list asks for.

### Flag surface

- **DB-level**: new field `KnowledgeGraphSettings.onDemandExtractionEnabled : Boolean default false;`. Admin-toggleable at `/admin-ui/#kg-settings`.
- **Env-level fallback**: `KG_ONDEMAND_ENABLED=true` env var wins if the DB row is absent (matches the resolver's DB > env > default chain).

---

## Section 2 — Data model

### New entity

```cds
// db/knowledge-graph-ondemand.cds (new file, avoids diff churn in db/knowledge-graph.cds)
namespace com.sap.developers.ims;

entity KgOnDemandRequests {
  key ID              : UUID;
  query               : String(200) @mandatory;   // Raw query, HARD_QUERY_LIMIT from the tool.
  normalizedKey       : String(200) @mandatory;   // Coalesce key: lowercase, whitespace-collapsed, punctuation-stripped.
  requestedBy         : String(64);               // XSUAA user ID hash or IP hash; nullable.
  requestedByKind     : String(16);               // 'user' | 'anon' — powers metrics separation.
  status              : String(16) @assert.range enum { PENDING; RUNNING; DONE; FAILED } default 'PENDING';
  attempts            : Integer default 0;
  requestedAt         : Timestamp @cds.on.insert: $now;
  startedAt           : Timestamp;
  completedAt         : Timestamp;
  latencyMs           : Integer;
  tutorialsExtracted  : Integer default 0;
  conceptsCreated     : Integer default 0;        // Net-new concepts inserted via merge-on-write.
  conceptsMerged      : Integer default 0;        // Merged into existing (>0.85 cosine).
  lastError           : String(500);
  llmPromptTokens     : Integer default 0;
  llmCompletionTokens : Integer default 0;
}
```

### Coalescing constraint

At most one row per `normalizedKey` may be in `('PENDING', 'RUNNING')` simultaneously. Enforcement is the `INSERT ... WHERE NOT EXISTS` above, plus a filtered unique index on HANA:

```sql
-- db/src/KG_ONDEMAND_PENDING_UNIQUE.hdbindex
CREATE UNIQUE INDEX "KG_ONDEMAND_PENDING_UNIQUE"
  ON "COM_SAP_DEVELOPERS_IMS_KGONDEMANDREQUESTS" ("NORMALIZEDKEY")
  WHERE "STATUS" IN ('PENDING', 'RUNNING');
```

SQLite unit tests can't express filtered unique indexes; the WHERE-NOT-EXISTS in the enqueue INSERT is the portable guard. HANA gets defense-in-depth via the filtered index.

### Setting

Added to the existing `KnowledgeGraphSettings` singleton entity in `db/knowledge-graph.cds`:

```cds
onDemandExtractionEnabled : Boolean default false;
```

`resolveKnowledgeGraphSettings()` layers DB > raw-SQL fallback > env > hardcoded default. **Implementation note**: the resolver in `srv/lib/runtime-config/kg-settings.js` currently hardcodes 4 knobs (`enabled`, `extractBuildCap`, `mergeSimThreshold`, `mergeSimThresholdExtract`). Adding `onDemandExtractionEnabled` requires appending to (a) the `DEFAULTS` map, (b) the CAP-path SELECT column list, (c) the raw-SQL `SELECT ... FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS` column list, and (d) the env-fallback branch — plus a new env var name mapping (`KG_ONDEMAND_ENABLED`). The 5s cache is unaffected. No new resolver signature.

### Reused, no schema change

- `TutorialEmbedding` (per-step `Vector(1536)`) — the corpus-rank source.
- `Concepts`, `TutorialConceptLinks`, `ConceptEdges` — populated by `extractConceptsFromTutorial` exactly as `extract-concepts-job.js` does today.
- `JobLocks` — used by the drain via `scheduler.runWithLock`.

### Env defaults

| Var | Default | Effect |
|---|---:|---|
| `KG_ONDEMAND_ENABLED` | `false` | Master switch (fallback if DB setting absent) |
| `KG_ONDEMAND_USER_MAX_PER_HOUR` | `3` | Per-user enqueue cap |
| `KG_ONDEMAND_GLOBAL_MAX_PER_HOUR` | `20` | Global enqueue cap |
| `KG_ONDEMAND_DRAIN_BATCH` | `3` | PENDING rows drained per cron tick |
| `KG_ONDEMAND_TUTORIALS_PER_REQ` | `5` | Top-K tutorials extracted per request |
| `KG_ONDEMAND_MAX_ATTEMPTS` | `3` | Attempts before FAILED |

All are read once per module load; changes require `cf restart tutorials-srv`. The two flag surfaces (env + DB) intentionally converge on the same value at settings-load time.

---

## Section 3 — Data flow

```
User in Joule → chat-orchestrator.js
                     │
                     ▼
   expandSearchConceptsHandler({ db, embedClient, args, requester, telemetry })
                     │
                     ├─ embed(query)   ── 1536-dim vector
                     ├─ topConceptsByCosine(db, vec, N)  ── seeds[]
                     │
                     ├─ [seeds.length > 0] → existing flow (unchanged)
                     │
                     └─ [seeds.length === 0]
                            │
                            ├─ emit kg.joule.search_expansion_returned { resultCount: 0 }
                            │
                            ├─ enqueueOnDemandExtraction({ db, query, requester })  ── fire-and-forget
                            │      │
                            │      ├─ flag off?                         → bail
                            │      ├─ normalize(query)                  → normalizedKey
                            │      ├─ user budget check                 → maybe bail (emit rate_limited)
                            │      ├─ global budget check               → maybe bail
                            │      └─ INSERT ... WHERE NOT EXISTS       → row or coalesce
                            │
                            └─ return { queryEcho, concepts: [], tutorials: [] }

Later, cron every 2 min:
  runOnDemandDrain
      │
      ├─ flag off? → skip
      ├─ runWithLock('kg-ondemand', ...)
      │       │
      │       ├─ SELECT PENDING rows LIMIT DRAIN_BATCH
      │       │
      │       └─ for each row:
      │             ├─ status=RUNNING, attempts++
      │             ├─ embed(query)
      │             ├─ cosine-rank TutorialEmbedding → top-K ACTIVE tutorials
      │             ├─ for each → extractConceptsFromTutorial → merge-on-write
      │             ├─ status=DONE + metrics on success
      │             └─ status=PENDING/FAILED + retry logic on throw
      │
      └─ emit summary metric
```

## Section 4 — Error handling

| Fault | Behavior |
|---|---|
| `onDemandExtractionEnabled = false` | Enqueue path not entered. Zero cost. Tool behavior identical to today. |
| `enabled = false` (parent KG flag) | Both enqueue and drain no-op. Enqueue exits before writing; drain returns `{ reason: 'kg-disabled' }`. |
| DB unavailable at enqueue time | `.catch(...)` in the tool handler consumes the error. LLM sees success. Metric NOT emitted (we can't tell if it landed). |
| Rate limit hit (user or global) | Silent skip. `kg_ondemand_rate_limited { reason }` emitted. LLM sees the empty response it was already going to see. |
| Coalesce collision | Silent skip. `kg_ondemand_dedup_coalesced` emitted. |
| Drain: instance already holds lock | `runWithLock` returns false. Next 2-minute tick tries. |
| Drain: embed fails | Row goes back to PENDING (or FAILED after max attempts). `lastError` captured. |
| Drain: `cosineRankTutorials` empty (fresh install, no `TutorialEmbedding` rows) | Row marked DONE with `tutorialsExtracted=0`. No LLM calls. Log at INFO. |
| Drain: `extractConceptsFromTutorial` throws | Row-level retry counter. Sibling rows in the same batch unaffected. |
| Drain: LLM quota exhausted mid-batch | The throw is caught per-row; batch continues with remaining rows. Subsequent tick retries. |
| Non-ACTIVE tutorial in top-K | Filtered out at hydration step. Never extracted. |

The invariant: **the tool's ≤5s wall-clock and its established error contract are inviolable.** The enqueue is purely additive; every failure mode in the enqueue path degrades to today's behavior.

---

## Section 5 — Testing

### Unit — `test/kg-ondemand-enqueue.test.js` (new)

In-memory SQLite. Injects `db`; stubs rate-limit windows for determinism.

- Flag off → no INSERT, no metric, returns undefined.
- Flag on, empty query after normalization → no INSERT, no metric.
- Flag on, valid query → INSERT with `status='PENDING'`, correct `normalizedKey`, `kg_ondemand_enqueued` emitted once.
- Coalescing: `"CAP tutorial"` and `"cap  tutorial!"` → one row, second call emits `kg_ondemand_dedup_coalesced`.
- Per-user cap: 4 enqueues same requester → 3 accepted, 4th emits `rate_limited { reason: 'user' }`.
- Global cap: 21 enqueues distinct requesters → 20 accepted, 21st `rate_limited { reason: 'global' }`.
- Anonymous requesters coalesced under `anon` bucket regardless of `ipHash`, still capped globally.

### Unit — `test/kg-ondemand-job.test.js` (new)

Mocks `callModel`, `embed`, injects fake db.

- `enabled=true, onDemandExtractionEnabled=false` → `{ reason: 'ondemand-disabled' }`, no side effects.
- `enabled=false` → `{ reason: 'kg-disabled' }` (parent-flag precedence).
- Happy path 2 PENDING rows → both PENDING → RUNNING → DONE, tutorials extracted match injected top-K, metrics emitted.
- Extraction throws once, succeeds on retry → row transitions `PENDING(attempts=1)` → `DONE(attempts=2)`.
- Extraction throws 3× → row lands `FAILED`, `lastError` set, `kg_ondemand_failures` emitted, sibling rows in batch unaffected.
- Empty `TutorialEmbedding` → row `DONE` with `tutorialsExtracted=0`, no LLM calls.
- Cosine-rank drops non-ACTIVE — inject a DRAFT slug at top score, confirm not extracted.
- Batch bound: 5 PENDING with `DRAIN_BATCH=3` → 3 processed, 2 remain PENDING.

### Unit — `test/kg-joule-tool-expand-concepts.test.js` (extend existing)

New cases added to the existing suite:

- Zero seeds + flag on → returns empty, `enqueueOnDemandExtraction` called once with `{ query, requester }`.
- Zero seeds + flag off → no enqueue call.
- Zero seeds + enqueue throws → tool still returns success (fire-and-forget contract).
- Non-zero seeds → enqueue never called regardless of flag.

### Hybrid — `test/hybrid/kg-ondemand.test.js` (new)

Real HANA via `cds bind --exec`. Toggles `onDemandExtractionEnabled=true` in `beforeAll`, resets in `afterAll`. Gated by `HYBRID_KG_ONDEMAND=true` in CI to control quota.

- Enqueue via HTTP: POST chat completion landing on `expandSearchConcepts` with a guaranteed zero-seed query (`"quantum tulip encabulator"`). Query the row within 1s.
- Cosine-rank correctness: seed known `TutorialEmbedding` rows, enqueue targeted query, invoke `runOnDemandDrain` directly, assert top-K matches expected slugs.
- Coalescing on HANA: 5 concurrent enqueues via `Promise.all`, assert exactly 1 row in PENDING/RUNNING.
- End-to-end: enqueue → drain → assert new `TutorialConceptLinks` rows exist, next `expandSearchConcepts` call for same query returns non-empty seeds.

### Smoke — `test/smoke/kg-ondemand.smoke.test.js` (new)

Post-deploy read-only sanity against deployed CAP srv. Assumes flag off in DEV.

- `GET /odata/v4/admin/KgOnDemandRequests` returns 200 with `Tutorial.Author` scope; 403 without.
- Admin UI `/admin-ui/#kgOnDemand` HTML shell loads (grep for LR title).
- `KnowledgeGraphSettings` row exposes `onDemandExtractionEnabled` as a boolean.

### Vitest project config

Add hybrid file to `hybrid` project entry and smoke file to `smoke` project in `vitest.config.js`. No new Vitest project needed.

### Metrics assertions

Metrics emission verified via existing `metrics.js` test harness — unit tests stub `emit` and assert call shape. Hybrid tests read `Metrics` rows if runtime is metric-persisting.

---

## Section 6 — Rollout

1. Land PR with flag OFF. Merge to `main`. No production behavior change.
2. Deploy to DEV via the canonical `npm run build:all` + `mbt build` + `cf deploy` sequence.
3. Verify smoke tests pass. Confirm `KgOnDemandRequests` table exists (`hana-cli inspectTable`), admin surface renders, `KnowledgeGraphSettings.onDemandExtractionEnabled` reads `false`.
4. Watch existing `kg.joule.search_expansion_returned` metric with `resultCount: 0` for a week. This is the pre-flag baseline data the #948 prerequisites list asked for.
5. When ready to test on-demand behavior in DEV: admin toggles `onDemandExtractionEnabled=true` at `/admin-ui/#kg-settings`. Watch `/admin-ui/#kgOnDemand` for PENDING → RUNNING → DONE transitions. Watch `kg_ondemand_*` metrics for anomalies.
6. If any of {`rate_limited > 10% of enqueued`, `failures > 5% of accepted`, `latency_ms.p95 > 60s`} — flip the flag off and revisit tuning.
7. Production rollout deferred behind DEV soak time (matches #917 KG communities pattern).

## Section 7 — Alternatives considered

**A. In-process ephemeral queue.** No HANA table; enqueue via a Map keyed by normalizedKey. Rejected: lost on restart, invisible to admin, and the #948 prerequisites explicitly ask for job-lock coalescing that survives instance boundaries. HANA-backed queue costs one small table for a big observability + durability win.

**B. Reuse `runExtractConcepts` with a slug filter.** Add a `KG_EXTRACT_TARGET_SLUGS` env-injected list; the on-demand path just sets it and calls the existing job. Rejected: ties on-demand behavior to a corpus-wide job not designed for slug-targeting, adds a branch to the extract-concepts job that widens its blast radius. Cleaner boundary = separate module.

**C. Enqueue-time drain kick (immediate execution).** Best user-facing latency (extract happens *during* the tool call's response). Rejected: the tool has a 5s budget; extraction is 5-30s per tutorial. Blocking the LLM turn on extraction is a non-starter. `setImmediate`-based background kick has all the complexity of a proper queue with none of the durability.

**D. Corpus-wide tick instead of query-targeted.** Trigger a full `runExtractConcepts` tick on any zero-seed query. Rejected: does not target the query at all — relies on the assumption that if the KG is behind, *any* backlog reduction helps the *next* query. Doesn't help *this* query, and burns budget on unrelated tutorials.

**E. Extract concepts from the query text alone (no tutorial-linking).** LLM synthesizes plausible concept names from the query, embeds them, merge-on-writes into `Concepts`. Rejected: creates orphan concepts unlinked to any tutorial. The whole point of the tool is `concept → tutorial` traversal; concepts without tutorial links produce empty `tutorials` in the very next call.

## References

- Issue #948 — the parked issue
- Issue #943 — parent design, shipped `expandSearchConcepts`
- `srv/lib/kg/joule-tool-expand-concepts.js` — the tool being extended
- `srv/jobs/extract-concepts-job.js` — the extractor being reused
- `srv/lib/kg-merge-on-write.js` — merge-on-write primitive
- `srv/jobs/job-lock.js` — distributed lock primitive
- `srv/lib/per-user-rate-limit.js` — sliding-window primitive
- `srv/lib/runtime-config/kg-settings.js` — settings resolver
- Recent KG feature-flagged patterns: #916 (PageRank), #917 (Communities), #918 (WCC)

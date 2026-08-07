# Async "Preview merges" — design (issue #1531)

**Date:** 2026-08-07
**Issue:** [#1531](https://github.com/sap-tutorials/tutorials-ims/issues/1531) — Admin UI Content > Concepts: pressing "Preview merges" produces `Preview failed: 504 Gateway Timeout`.
**Status:** design — awaiting review.

## Problem

The List-Report toolbar button "Preview merges" in the Concepts admin app
(`app/admin/concepts/`) calls the unbound `KnowledgeGraphService.previewMerges`
action synchronously and awaits the full result array. The handler
(`srv/knowledge-graph-service.js:1634`):

1. loads **every ACTIVE concept** with its 1536-dim Float32 embedding
   (`loadConceptsWithEmbeddings`, ~35 MB at current scale), then
2. runs `findNearDuplicates` — a synchronous **O(n²/2)** pairwise cosine scan
   (`srv/lib/kg-similarity.js:84`).

DEV currently has **5,710 ACTIVE concepts** (verified via
`GET /graph/Concepts/$count?$filter=status eq 'ACTIVE'`). That is
~16.3M pairs × 1536-dim dot products ≈ **25 billion multiply-adds**, run
**synchronously on the Node event loop**.

The approuter `srv-api` destination uses the **default 30 s timeout** (no
override in `.deploy/mta.yaml`). The scan exceeds 30 s → the gateway returns
**504** before the backend responds.

The identical algorithm never times out in the weekly
`consolidate-concepts-job` (`srv/jobs/consolidate-concepts-job.js:86`) because
that runs as a background cron with **no HTTP gateway in front of it**.

### Root cause (one line)

An unbounded, CPU-bound O(n²) scan was wired to a synchronous HTTP request that
cannot stay open past the gateway's 30 s budget — and even off-request it would
block the single-threaded event loop for other callers on that srv instance.

## Goals / non-goals

**Goals**
- "Preview merges" no longer 504s, at any concept count.
- Keep Tom's exact UX: **click → button shows "running…" → poll → pop the same
  candidate-list dialog** when done. (Confirmed: fire-and-poll, dialog.)
- Compute is **on-demand each click** (confirmed — no nightly caching).
- The interactive scan must **not starve the event loop** for other requests on
  the same instance.
- **Single-flight** (confirmed): repeat clicks / a second admin join the
  in-flight run rather than spawning parallel 25-billion-op scans.

**Non-goals**
- No change to the merge *algorithm* or thresholds; `findNearDuplicates` and the
  weekly consolidator are untouched.
- No caching / nightly precompute (explicitly declined).
- No change to `mergeConcepts`, `vetoConcept`, etc.
- Not attempting to "make O(n²) fit in 30 s" — the fix is transport, not speed.

## Approach (A — approved)

Model the run on the **`KgOnDemandRequests`** precedent
(`db/knowledge-graph-ondemand.cds:17`): a status-tracked run-record table whose
result lives on the row. Fire-and-return like **`AdminService.JobControls.runJob`**
(`srv/admin-service.js:2982`). Poll from the client like the admin-shell
**Board** dashboard (`Board.controller.js:310`).

### Data model — new entity

New file `db/knowledge-graph-merge-preview.cds` (kept out of the already-large
`knowledge-graph-ondemand.cds` — one entity, one purpose):

```cds
namespace com.sap.developers.ims;
using { cuid } from '@sap/cds/common';

entity ConceptMergePreviewRuns : cuid {
  status          : String enum { RUNNING; DONE; FAILED } default 'RUNNING';
  requestedBy     : String;
  requestedAt     : Timestamp  @cds.on.insert: $now;
  startedAt       : Timestamp;
  finishedAt      : Timestamp;
  durationMs      : Integer;
  threshold       : Decimal(4, 3);
  conceptsScanned : Integer;
  candidatePairs  : Integer;
  // Full MergePreview[] as JSON (the candidate list the dialog renders).
  // LargeString, not a child composition: the payload is read once, whole,
  // by one client — a JSON blob is simpler than N child rows and there is no
  // need to query individual pairs. Capped in the handler (see "Result size").
  resultJson      : LargeString;
  lastError       : String(500);
}
```

Rationale for `resultJson` over child rows: mirrors how `KgOnDemandRequests`
stores its outcome **on the row**; the dialog consumes the entire list in one
read; no per-pair querying is needed. `PipelineLog.summary` (2000 chars) is too
small, which is the other reason we don't just reuse PipelineLog.

### Service surface — `KnowledgeGraphService`

**Changed action** (`srv/knowledge-graph-service.cds`): `previewMerges` stops
returning `array of MergePreview` and instead returns a small ticket:

```cds
@requires : 'KnowledgeGraph.Admin'
action previewMerges() returns { runId : UUID; status : String; coalesced : Boolean; };
```

`MergePreview` type is retained (now the element shape inside `resultJson`).

**New read projection** for polling:

```cds
@readonly entity ConceptMergePreviewRuns as projection on ims.ConceptMergePreviewRuns;
```

Guarded by the same `@requires: 'KnowledgeGraph.Admin'` posture as the other
curation surface. It rides the existing service `before('*')` KG-enabled gate.

### Handler flow (`srv/knowledge-graph-service.js`)

`previewMerges`:
1. **Single-flight gate** (mirrors `on-demand-enqueue.js:112`): inside a `db.tx`,
   `SELECT` any `ConceptMergePreviewRuns` with `status='RUNNING'` and
   `startedAt` within the last **5 min** (stale-run cutoff). If found → return
   `{ runId: <existing>, status:'RUNNING', coalesced:true }`.
2. Else `INSERT` a new row `status='RUNNING'`, `requestedBy=req.user.id`,
   `startedAt=$now`, and return `{ runId, status:'RUNNING', coalesced:false }`
   **immediately**.
3. **After** returning, kick the scan via `setImmediate` (same fire-and-return
   shape as `JobControls.runJob`). The background function:
   - `loadConceptsWithEmbeddings(db, log)`,
   - runs a **chunked, yielding** near-duplicate scan (see below),
   - `UPDATE` the row → `DONE`, `finishedAt`, `durationMs`, `conceptsScanned`,
     `candidatePairs`, `resultJson` (capped), or on throw → `FAILED` + `lastError`.
   - emits the existing `KnowledgeGraphPreviewMerges` audit event with the same
     fields it does today.

**Event-loop-friendly scan** — new `findNearDuplicatesChunked(concepts, threshold, { onYield })`
in `srv/lib/kg-similarity.js`, alongside the existing sync `findNearDuplicates`
(left byte-for-byte unchanged so the weekly cron is unaffected). Same math, but
`await` a `setImmediate`-yield every K outer-loop rows (K≈50) so other HTTP
requests interleave. This is the piece that keeps a ~1-2 min scan from freezing
the instance.

**Stale-run self-healing:** no separate reconciler. The single-flight SELECT in
step 1 only coalesces onto runs newer than the 5-min cutoff; an older stuck
RUNNING row is ignored and a fresh run starts. (A crashed process leaving a
RUNNING row is thus self-correcting on the next click — same philosophy as the
on-demand drain's `finally` recovery, without needing a cron.)

### Result size

At 5,710 concepts a pathological threshold could in principle emit a very large
pair list. The UI only ever shows the first 50 (`ConceptActionsController` slices
to 50 today). The handler will **cap `resultJson` at the first N=500 pairs**
(sorted by similarity desc, matching `findNearDuplicates` output order) plus store
the true `candidatePairs` count, so the dialog's "… and X more" line stays
accurate while `resultJson` stays bounded. 500 × ~180 bytes ≈ 90 KB — comfortable
for LargeString and a single read.

### Client — `ConceptActionsController.controller.js`

`onPreviewMerges` becomes:
1. `POST /graph/previewMerges` → `{ runId, status, coalesced }` (returns in ms now).
2. Show a non-blocking `MessageToast` ("Computing merge candidates…").
3. **Poll** `GET /graph/ConceptMergePreviewRuns(<runId>)` every **2 s**, up to a
   **3 min** ceiling (mirrors Board's bounded `setInterval` at
   `Board.controller.js:310`, tuned tighter for interactivity).
   - `status==='DONE'` → parse `resultJson`, render the **same** `MessageBox`
     candidate dialog as today (the existing 50-line slice + "… and X more").
   - `status==='FAILED'` → `MessageBox.error("Preview failed: " + lastError)`.
   - ceiling hit → `MessageBox.warning` telling the admin it's still running and
     to retry shortly (the run continues server-side; a later click coalesces).
4. The poll uses the existing raw-`fetch` + CSRF helper style already in this
   controller — no new UI5 model plumbing.

No manifest/dataSource change: `ConceptMergePreviewRuns` is served under the same
`/graph/` OData service the app already binds.

## Data flow

```
[Admin clicks "Preview merges"]
   → POST /graph/previewMerges
       → single-flight SELECT (RUNNING & <5min?)
            ├─ yes → return {runId, coalesced:true}          (≈ms)
            └─ no  → INSERT RUNNING row; return {runId}       (≈ms)
                     setImmediate: load embeddings
                                   → findNearDuplicatesChunked (yields every ~50 rows)
                                   → UPDATE row DONE/FAILED + resultJson
   → client polls GET /graph/ConceptMergePreviewRuns(runId) every 2s (≤3min)
       → DONE  → MessageBox candidate dialog (unchanged rendering)
       → FAILED→ MessageBox.error(lastError)
```

## Error handling

- **Loader / scan throws** → row flips `FAILED` + `lastError` (≤500 chars);
  client shows `MessageBox.error`. Background function never rethrows (nothing to
  catch it — the response is already sent), matching `asyncRebuildAfterCuration`.
- **KG disabled** → existing `before('*')` gate returns 503 on the action before
  any row is written (unchanged).
- **Poll ceiling** → advisory warning; server run is unaffected. A fresh click
  after the run finishes starts a NEW run (correct for "on-demand each click");
  a click while still running coalesces onto it.
- **Concurrent clicks** → coalesced onto one run (single-flight); no parallel scans.

## Testing

- **Unit (`srv/lib/kg-similarity`)**: new `findNearDuplicatesChunked` returns
  **identical pairs, identical order** to `findNearDuplicates` for the same
  input+threshold (parametrized over a shared fixture); verify the `onYield`
  callback fires. Guards that the interactive path can't drift from the cron path.
- **Unit (service, in-memory SQLite)**: `previewMerges` returns a `runId` fast and
  writes a RUNNING row; after the background tick the row is DONE with a parseable
  `resultJson`; a second immediate call **coalesces** (same runId); a forced
  handler throw flips the row to FAILED with `lastError`.
- **Hybrid (real HANA, `cds bind --exec`)**: end-to-end against the real ACTIVE
  concept set — action returns <1 s, row reaches DONE, `candidatePairs` matches a
  direct `findNearDuplicates` count. This is the test that actually proves the
  504 is gone.
- **e2e (post-deploy Playwright, `test/e2e/`)**: click "Preview merges" in the
  Concepts LR, assert the toast then the candidate dialog appears (per the
  committed-e2e-spec convention for admin-UI seams; issue #1371/#1378). This is
  the "test the actual thing through the real entry point" gate.

## Files touched

- **new** `db/knowledge-graph-merge-preview.cds` — `ConceptMergePreviewRuns` entity.
- `srv/knowledge-graph-service.cds` — change `previewMerges` return type; add
  `ConceptMergePreviewRuns` read projection.
- `srv/knowledge-graph-service.js` — rewrite `previewMerges` handler (single-flight
  + insert + `setImmediate` background scan + row finalize + audit).
- `srv/lib/kg-similarity.js` — add `findNearDuplicatesChunked` (sync
  `findNearDuplicates` unchanged).
- `app/admin/concepts/webapp/ext/ConceptActionsController.controller.js` —
  `onPreviewMerges` becomes kick-off + bounded poll + same dialog.
- `app/admin/concepts/webapp/i18n/i18n.properties` — "Computing…" toast + timeout msg.
- `app/admin/concepts/webapp/manifest.json` — bump `sap.app.applicationVersion`.
- tests: `test/unit/kg-similarity*.test.js` (or nearest existing), a service unit
  test, a hybrid test, a `test/e2e/` spec.

## Deploy notes

- New CDS entity → schema change. Per project rules: `cds build --production`
  (not `cds compile`) so `db/last-dev/` + `.hdbmigrationtable` bump correctly;
  never hand-edit the migration table. Run
  `npx cds deploy --to sqlite::memory:` before commit to validate.
- Admin-UI change (controller + i18n + manifest) → **full `mbt build` deploy**, no
  `--skip-build`, no `-m` scoping; Step 3.5 admin-bundle gate applies. Bump
  `sap.app.applicationVersion` in the concepts manifest so the UI5 IndexedDB
  cache doesn't serve the stale controller.
- MTA version bump: **patch** (bug fix) in `.deploy/mta.yaml`.
- No env var, no scheduler registration (interactive-only; not a cron job).

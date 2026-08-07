# Async "Preview merges" Implementation Plan (issue #1531)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Concepts admin "Preview merges" action from a synchronous O(n²) scan (which 504s behind the approuter's 30 s gateway) into a fire-and-poll background run so it returns instantly and never times out.

**Architecture:** A new `ConceptMergePreviewRuns` run-record table (modeled on the existing `KgOnDemandRequests` queue) tracks each preview run's status + result. The `previewMerges` action inserts a RUNNING row (single-flight: coalesces onto any RUNNING run <5 min old), returns `{runId}` in ms, and kicks the scan via `setImmediate`. The scan uses a new event-loop-yielding variant of the near-duplicate finder, then writes the capped result JSON onto the row. The Fiori Elements controller polls a read-only projection of the row and pops the same candidate dialog on DONE.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), CDS models, Fiori Elements (UI5, raw `fetch` controller extension), Vitest (unit + hybrid), Playwright (post-deploy e2e).

**Design ref:** `docs/superpowers/specs/2026-08-07-1531-async-preview-merges-design.md`

## Global Constraints

- Namespace for all `db/` entities: `com.sap.developers.ims` (alias `ims` in service files).
- KG service is feature-gated: unit tests MUST `process.env.KNOWLEDGE_GRAPH_ENABLED = 'true'` BEFORE `cds.test()` boots, or every request returns 503.
- Service unit-test boot pattern: `const project = cds.test('serve', '--project', '.', '--in-memory');` — do NOT use the broken `cds.deploy(cds.model)` bootstrap.
- Admin auth in tests: `{ auth: { username: 'admin', password: 'admin' } }`.
- The existing sync `findNearDuplicates` in `srv/lib/kg-similarity.js` MUST stay byte-for-byte unchanged — the weekly `consolidate-concepts-job` depends on it.
- Raw-SQL BLOB retrieval only via the shared `loadConceptsWithEmbeddings` loader; never SELECT a HANA BLOB alongside scalars in CDS QL.
- After any `db/**/*.cds` change: run `npx cds deploy --to sqlite::memory:` before commit (runtime-only `@assert`/enum validation).
- After schema change for deploy: `cds build --production` (not `cds compile`); never hand-edit `.hdbmigrationtable`.
- Admin-UI change → bump `sap.app.applicationVersion` in `app/admin/concepts/webapp/manifest.json`; full `mbt build` deploy (no `--skip-build`, no `-m` scoping).
- MTA version bump: **patch** in `.deploy/mta.yaml` (bug fix).
- Windows/CRLF: keep new files LF-terminated.
- Run all file-mutating Bash from the worktree path (never `cd` out of it).

## File Structure

- **Create** `db/knowledge-graph-merge-preview.cds` — the `ConceptMergePreviewRuns` entity (one entity, one purpose; kept out of the already-large ondemand file).
- **Modify** `srv/lib/kg-similarity.js` — add `findNearDuplicatesChunked` (async, yielding). Sync `findNearDuplicates` untouched.
- **Modify** `srv/knowledge-graph-service.cds` — change `previewMerges` return type; add `ConceptMergePreviewRuns` read projection.
- **Modify** `srv/knowledge-graph-service.js` — rewrite the `previewMerges` handler (single-flight + insert + `setImmediate` background scan + row finalize + audit).
- **Modify** `app/admin/concepts/webapp/ext/ConceptActionsController.controller.js` — `onPreviewMerges` becomes kick-off + bounded poll + same dialog.
- **Modify** `app/admin/concepts/webapp/i18n/i18n.properties` — new toast/timeout strings.
- **Modify** `app/admin/concepts/webapp/manifest.json` — bump `applicationVersion`.
- **Modify** `.deploy/mta.yaml` — patch version bump.
- **Create** `test/unit/kg-similarity-chunked.test.js` — parity + yield test.
- **Create** `test/unit/kg-preview-merges-async.test.js` — service-level async/coalesce/failure test.
- **Create** `test/hybrid/kg-preview-merges.test.js` — real-HANA end-to-end.
- **Create** `test/e2e/concepts-preview-merges.spec.js` — post-deploy Playwright.

---

### Task 1: Event-loop-yielding near-duplicate finder

**Files:**
- Modify: `srv/lib/kg-similarity.js` (append new export; do NOT touch `findNearDuplicates`)
- Test: `test/unit/kg-similarity-chunked.test.js` (create)

**Interfaces:**
- Consumes: `cosineSim`, `pickCanonical` (already in the module).
- Produces: `async function findNearDuplicatesChunked(concepts, threshold = 0.92, opts = {}) → Promise<Array<{canonical, loser, sim}>>`. `opts.chunkSize` (default 50), `opts.onYield` (optional `() => void`, called once per yield). Output is identical (same pairs, same descending-sim sort) to `findNearDuplicates` for the same inputs.

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg-similarity-chunked.test.js`:

```javascript
// test/unit/kg-similarity-chunked.test.js
// findNearDuplicatesChunked must produce identical output to the sync
// findNearDuplicates (the weekly consolidator's finder) while yielding to
// the event loop, so the interactive preview path can never drift from cron.

import { describe, it, expect, vi } from 'vitest';
import {
  findNearDuplicates,
  findNearDuplicatesChunked,
} from '../../srv/lib/kg-similarity.js';

function makeConcept(id, vec, extractionCount = 1, firstSeenAt = '2026-01-01') {
  return { ID: id, slug: id, name: id, extractionCount, firstSeenAt, embeddingVec: new Float32Array(vec) };
}

// A deterministic fixture with a couple of near-duplicate clusters.
const fixture = [
  makeConcept('a', [1, 0, 0]),
  makeConcept('b', [0.99, 0.01, 0], 5),      // ~dup of a; higher extractionCount
  makeConcept('c', [0, 1, 0]),
  makeConcept('d', [0, 0.98, 0.02], 2),      // ~dup of c
  makeConcept('e', [0.5, 0.5, 0.7071]),      // unrelated
];

describe('findNearDuplicatesChunked', () => {
  it('returns identical pairs and order to the sync finder', async () => {
    const threshold = 0.9;
    const sync = findNearDuplicates(fixture, threshold);
    const chunked = await findNearDuplicatesChunked(fixture, threshold, { chunkSize: 2 });
    const norm = (arr) => arr.map((p) => ({ c: p.canonical.ID, l: p.loser.ID, s: Number(p.sim.toFixed(6)) }));
    expect(norm(chunked)).toEqual(norm(sync));
  });

  it('invokes onYield at least once when concepts exceed chunkSize', async () => {
    const onYield = vi.fn();
    await findNearDuplicatesChunked(fixture, 0.9, { chunkSize: 2, onYield });
    expect(onYield).toHaveBeenCalled();
  });

  it('returns [] for fewer than 2 concepts', async () => {
    expect(await findNearDuplicatesChunked([], 0.9)).toEqual([]);
    expect(await findNearDuplicatesChunked([fixture[0]], 0.9)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg-similarity-chunked.test.js`
Expected: FAIL — `findNearDuplicatesChunked is not a function` / not exported.

- [ ] **Step 3: Implement the chunked finder**

Append to `srv/lib/kg-similarity.js` (after `findNearDuplicates`), reusing `cosineSim` + `pickCanonical`:

```javascript
/**
 * Event-loop-yielding variant of {@link findNearDuplicates}.
 *
 * Same math and same output (identical pairs, identical descending-sim sort),
 * but `await`s a macrotask yield every `chunkSize` outer-loop rows so other
 * HTTP requests on the single-threaded Node event loop can interleave. Used by
 * the interactive admin "Preview merges" action (issue #1531); the weekly
 * consolidator keeps using the synchronous finder.
 *
 * @param {Array<{ID: string, embeddingVec: Float32Array, extractionCount: number, firstSeenAt: string|Date}>} concepts
 * @param {number} [threshold=0.92]
 * @param {{ chunkSize?: number, onYield?: () => void }} [opts]
 * @returns {Promise<Array<{ canonical: object, loser: object, sim: number }>>}
 */
export async function findNearDuplicatesChunked(concepts, threshold = 0.92, opts = {}) {
  if (!Array.isArray(concepts) || concepts.length < 2) return [];
  const chunkSize = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : 50;
  const onYield = typeof opts.onYield === 'function' ? opts.onYield : null;
  const out = [];
  for (let i = 0; i < concepts.length; i++) {
    const a = concepts[i];
    if (a && a.embeddingVec) {
      for (let j = i + 1; j < concepts.length; j++) {
        const b = concepts[j];
        if (!b || !b.embeddingVec) continue;
        const sim = cosineSim(a.embeddingVec, b.embeddingVec);
        if (sim > threshold) {
          const canonical = pickCanonical(a, b);
          const loser = canonical === a ? b : a;
          out.push({ canonical, loser, sim });
        }
      }
    }
    // Yield to the event loop between outer-loop chunks.
    if ((i + 1) % chunkSize === 0) {
      if (onYield) onYield();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  out.sort((x, y) => y.sim - x.sim);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg-similarity-chunked.test.js`
Expected: PASS (3 tests). Also run the pre-existing suite to confirm no regression: `npx vitest run test/unit/kg-similarity.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-similarity.js test/unit/kg-similarity-chunked.test.js
git commit -m "feat(#1531): event-loop-yielding findNearDuplicatesChunked"
```

---

### Task 2: `ConceptMergePreviewRuns` entity + CDS surface

**Files:**
- Create: `db/knowledge-graph-merge-preview.cds`
- Modify: `srv/knowledge-graph-service.cds` (change `previewMerges` return type ~line 330; add read projection near the other `@readonly` projections ~line 72-109)

**Interfaces:**
- Produces (DB): entity `com.sap.developers.ims.ConceptMergePreviewRuns` with elements: `ID:UUID` (key, via `cuid`), `status` enum `{RUNNING;DONE;FAILED}` default `'RUNNING'`, `requestedBy:String`, `requestedAt:Timestamp @cds.on.insert:$now`, `startedAt:Timestamp`, `finishedAt:Timestamp`, `durationMs:Integer`, `threshold:Decimal(4,3)`, `conceptsScanned:Integer`, `candidatePairs:Integer`, `resultJson:LargeString`, `lastError:String(500)`.
- Produces (service): `action previewMerges() returns { runId:UUID; status:String; coalesced:Boolean; }`; `@readonly entity ConceptMergePreviewRuns as projection on ims.ConceptMergePreviewRuns` (KnowledgeGraph.Admin-gated).

- [ ] **Step 1: Create the entity file**

Create `db/knowledge-graph-merge-preview.cds`:

```cds
namespace com.sap.developers.ims;

using { cuid } from '@sap/cds/common';

// Async "Preview merges" run record (#1531).
//
// The admin "Preview merges" action previously ran a synchronous O(n^2)
// cosine scan over every ACTIVE concept embedding inline in the HTTP handler
// and 504'd behind the approuter's 30s gateway. It now inserts a RUNNING row
// here, returns {runId} immediately, and finishes the scan in the background
// (see srv/knowledge-graph-service.js previewMerges). The Fiori Elements
// controller polls this row and renders resultJson when status flips to DONE.
//
// Single-flight: at most one RUNNING run <5 min old is honored; a newer click
// coalesces onto it. A stuck RUNNING row older than the cutoff is ignored
// (self-healing — no reconciler cron). See design doc
// docs/superpowers/specs/2026-08-07-1531-async-preview-merges-design.md.
entity ConceptMergePreviewRuns : cuid {
  status          : String(16) @assert.range enum { RUNNING; DONE; FAILED } default 'RUNNING';
  requestedBy     : String(255);
  requestedAt     : Timestamp @cds.on.insert: $now;
  startedAt       : Timestamp;
  finishedAt      : Timestamp;
  durationMs      : Integer;
  threshold       : Decimal(4, 3);
  conceptsScanned : Integer;
  candidatePairs  : Integer;
  // Capped MergePreview[] as a JSON string (first 500 pairs, sim desc). The
  // dialog reads the whole blob once; no per-pair querying is needed, so a
  // single LargeString beats N child rows. candidatePairs holds the true
  // (uncapped) count so the dialog's "... and X more" line stays accurate.
  resultJson      : LargeString;
  lastError       : String(500);
}
```

- [ ] **Step 2: Change the `previewMerges` return type**

In `srv/knowledge-graph-service.cds`, replace (~line 329-330):

```cds
  @requires : 'KnowledgeGraph.Admin'
  action previewMerges() returns array of MergePreview;
```

with:

```cds
  // #1531 — previewMerges is now async. It inserts a RUNNING
  // ConceptMergePreviewRuns row and returns a ticket immediately; the O(n^2)
  // scan finishes in the background and writes resultJson onto the row, which
  // the admin UI polls. The MergePreview type below is retained as the element
  // shape encoded inside resultJson.
  @requires : 'KnowledgeGraph.Admin'
  action previewMerges() returns {
    runId     : UUID;
    status    : String;
    coalesced : Boolean;
  };
```

(Leave the `type MergePreview { ... }` block at ~line 254 intact.)

- [ ] **Step 3: Add the read projection**

In `srv/knowledge-graph-service.cds`, add near the other admin-gated read projections (inside the `service KnowledgeGraphService { ... }` block — e.g. just after the `ConceptEdges`/`TutorialConceptLinks` projections around line 76):

```cds
  // #1531 — polled by the Concepts admin UI to watch an async previewMerges
  // run to completion. Admin-gated; rides the service before('*') KG gate.
  @readonly
  @requires : 'KnowledgeGraph.Admin'
  entity ConceptMergePreviewRuns as projection on ims.ConceptMergePreviewRuns;
```

(Confirm the file's alias for the DB namespace is `ims`; if it is `using ... as ims`, this matches. If the file references the namespace differently, mirror the existing projections' left-hand source.)

- [ ] **Step 4: Validate the model compiles + deploys to in-memory sqlite**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -20`
Expected: no compile error; deploy succeeds (the new table + projection are accepted). If it prints an alias error on the projection, fix the `ims.` prefix to match the file's actual `using` alias, then re-run.

- [ ] **Step 5: Commit**

```bash
git add db/knowledge-graph-merge-preview.cds srv/knowledge-graph-service.cds
git commit -m "feat(#1531): ConceptMergePreviewRuns entity + async previewMerges CDS surface"
```

---

### Task 3: Rewrite the `previewMerges` handler (single-flight + background scan)

**Files:**
- Modify: `srv/knowledge-graph-service.js` — add import (line ~541); rewrite `this.on('previewMerges', ...)` (lines 1634-1665)
- Test: `test/unit/kg-preview-merges-async.test.js` (create)

**Interfaces:**
- Consumes: `loadConceptsWithEmbeddings(db, log)` (already imported line 542); `findNearDuplicatesChunked` (Task 1); `resolveKnowledgeGraphSettings()` → `{ mergeSimThreshold }` (already imported line 543); `audit(action, data)` (in-file helper, line 758); `cds.entities(NAMESPACE)` → `ConceptMergePreviewRuns`.
- Produces: `POST /graph/previewMerges` → `{ runId, status:'RUNNING', coalesced:Boolean }`. Background finalize writes `status`, `finishedAt`, `durationMs`, `conceptsScanned`, `candidatePairs`, `resultJson` (capped 500), or `status:'FAILED'` + `lastError` onto the row.

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg-preview-merges-async.test.js`:

```javascript
// test/unit/kg-preview-merges-async.test.js
// Async previewMerges (#1531): the action returns a runId immediately and a
// RUNNING row; the background scan finalizes the row to DONE with a parseable
// resultJson; a second immediate call coalesces onto the same run.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const NS = 'com.sap.developers.ims';

// Two near-duplicate ACTIVE concepts with real embedding BLOBs so the sqlite
// loader path (CDS QL) returns decodable vectors.
function f32blob(arr) {
  const v = new Float32Array(arr);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

const IDS = {
  a: 'D0000001-0000-0000-0000-000000000001',
  b: 'D0000001-0000-0000-0000-000000000002',
};

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Concepts, ConceptMergePreviewRuns } = cds.entities(NS);
  await db.run(DELETE.from(ConceptMergePreviewRuns));
  await db.run(DELETE.from(Concepts).where({ ID: { in: [IDS.a, IDS.b] } }));
  await db.run(INSERT.into(Concepts).entries([
    { ID: IDS.a, slug: 'pm-async-a', name: 'A', status: 'ACTIVE', extractionCount: 5,
      firstSeenAt: '2026-01-01T00:00:00Z', embedding: f32blob([1, 0, 0, 0]) },
    { ID: IDS.b, slug: 'pm-async-b', name: 'B', status: 'ACTIVE', extractionCount: 1,
      firstSeenAt: '2026-02-01T00:00:00Z', embedding: f32blob([0.999, 0.001, 0, 0]) },
  ]));
});

async function poll(runId, ms = 5000) {
  const db = await cds.connect.to('db');
  const { ConceptMergePreviewRuns } = cds.entities(NS);
  const deadline = Date.now() + ms;
  // Date.now allowed in test files (only workflow scripts forbid it).
  for (;;) {
    const [row] = await db.run(SELECT.from(ConceptMergePreviewRuns).where({ ID: runId }));
    if (row && row.status !== 'RUNNING') return row;
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('previewMerges (async, #1531)', () => {
  it('returns a runId immediately and finalizes the row to DONE', async () => {
    const res = await POST('/graph/previewMerges', {}, adminAuth);
    expect(res.status).toBe(200);
    expect(res.data.runId).toBeTruthy();
    expect(res.data.status).toBe('RUNNING');
    expect(res.data.coalesced).toBe(false);

    const row = await poll(res.data.runId);
    expect(row.status).toBe('DONE');
    expect(row.candidatePairs).toBeGreaterThanOrEqual(1);
    const pairs = JSON.parse(row.resultJson);
    expect(Array.isArray(pairs)).toBe(true);
    // A wins canonical (higher extractionCount); B is the loser.
    expect(pairs[0].canonicalSlug).toBe('pm-async-a');
    expect(pairs[0].loserSlug).toBe('pm-async-b');
    expect(pairs[0].similarity).toBeGreaterThan(0.9);
  });

  it('coalesces a second call onto an in-flight RUNNING run', async () => {
    // Fire two back-to-back; the second must see the first still RUNNING.
    const first = await POST('/graph/previewMerges', {}, adminAuth);
    const second = await POST('/graph/previewMerges', {}, adminAuth);
    if (second.data.coalesced) {
      expect(second.data.runId).toBe(first.data.runId);
    } else {
      // Race where first already finished: acceptable, but then it's a new run.
      expect(second.data.runId).not.toBe(first.data.runId);
    }
    await poll(first.data.runId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg-preview-merges-async.test.js`
Expected: FAIL — current handler returns an array (no `runId`), so `res.data.runId` is undefined.

- [ ] **Step 3: Add the import**

In `srv/knowledge-graph-service.js`, line 541, extend the kg-similarity import:

```javascript
import { findNearDuplicates, findNearDuplicatesChunked } from './lib/kg-similarity.js';
```

(`findNearDuplicates` may no longer be used directly by this file after the rewrite — if lint flags it unused, drop it from this import. It stays exported for the consolidator.)

- [ ] **Step 4: Rewrite the handler**

Replace the whole `this.on('previewMerges', async (req) => { ... });` block (lines 1634-1665) with:

```javascript
  // ─── previewMerges — ASYNC dry-run dedupe over ACTIVE concepts (#1531) ──
  // Was synchronous and 504'd behind the 30s gateway on large concept sets.
  // Now: single-flight INSERT of a RUNNING ConceptMergePreviewRuns row +
  // immediate {runId} return; the O(n^2) scan finishes in the background via
  // setImmediate (yielding to the event loop) and writes resultJson onto the
  // row, which the admin UI polls. Mirrors the fire-and-return shape of
  // AdminService.JobControls.runJob + the coalescing SELECT-then-INSERT of
  // srv/lib/kg/on-demand-enqueue.js.
  const PREVIEW_STALE_MS = 5 * 60 * 1000; // coalesce onto runs newer than this
  const PREVIEW_RESULT_CAP = 500;         // max pairs stored in resultJson

  this.on('previewMerges', async (req) => {
    const { ConceptMergePreviewRuns } = cds.entities(NAMESPACE);
    const user = req.user?.id ?? 'unknown';

    // (1) Single-flight: coalesce onto a RUNNING run started < 5 min ago.
    const cutoffIso = new Date(Date.now() - PREVIEW_STALE_MS).toISOString();
    let runId;
    try {
      runId = await db.tx(async (tx) => {
        const [existing] = await tx.run(
          SELECT.from(ConceptMergePreviewRuns)
            .columns('ID')
            .where({ status: 'RUNNING', startedAt: { '>': cutoffIso } })
            .limit(1),
        );
        if (existing) return existing.ID;
        const id = cds.utils.uuid();
        await tx.run(
          INSERT.into(ConceptMergePreviewRuns).entries({
            ID: id,
            status: 'RUNNING',
            requestedBy: user,
            startedAt: new Date().toISOString(),
          }),
        );
        return { id, fresh: true };
      });
    } catch (err) {
      log.error(`kg-service: previewMerges enqueue failed: ${err.message ?? err}`);
      return req.error(500, `Preview failed: ${err.message ?? 'unknown error'}`);
    }

    // db.tx returned either an existing ID (string) or {id, fresh:true}.
    if (typeof runId === 'string') {
      return { runId, status: 'RUNNING', coalesced: true };
    }
    const freshId = runId.id;

    // (2) Kick the scan AFTER responding. Never rethrows (response already sent).
    setImmediate(() => {
      runPreviewScan(freshId, user).catch((err) => {
        log.error(`kg-service: previewMerges background scan crashed: ${err?.message ?? err}`);
      });
    });

    return { runId: freshId, status: 'RUNNING', coalesced: false };
  });

  // Background worker for a single preview run. Loads embeddings, runs the
  // yielding scan, finalizes the row DONE/FAILED. Self-contained error handling.
  async function runPreviewScan(runId, user) {
    const { ConceptMergePreviewRuns } = cds.entities(NAMESPACE);
    const startedMs = Date.now();
    try {
      const concepts = await loadConceptsWithEmbeddings(db, log);
      const { mergeSimThreshold: threshold } = await resolveKnowledgeGraphSettings();
      const pairs = await findNearDuplicatesChunked(concepts, threshold, { chunkSize: 50 });

      const capped = pairs.slice(0, PREVIEW_RESULT_CAP).map((p) => ({
        loserId: p.loser.ID,
        loserSlug: p.loser.slug,
        loserName: p.loser.name,
        canonicalId: p.canonical.ID,
        canonicalSlug: p.canonical.slug,
        canonicalName: p.canonical.name,
        similarity: Number(p.sim.toFixed(3)),
      }));

      await db.run(
        UPDATE(ConceptMergePreviewRuns).set({
          status: 'DONE',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
          threshold,
          conceptsScanned: concepts.length,
          candidatePairs: pairs.length,
          resultJson: JSON.stringify(capped),
        }).where({ ID: runId }),
      );

      log.info(
        `kg-service: previewMerges run ${runId} scanned ${concepts.length} ACTIVE concepts at threshold=${threshold}, found ${pairs.length} candidate pair(s)`,
      );
      await audit('KnowledgeGraphPreviewMerges', {
        user,
        threshold,
        conceptsScanned: concepts.length,
        candidatePairs: pairs.length,
      });
    } catch (err) {
      const msg = (err?.message ?? String(err)).slice(0, 500);
      log.error(`kg-service: previewMerges run ${runId} failed: ${msg}`);
      try {
        await db.run(
          UPDATE(ConceptMergePreviewRuns).set({
            status: 'FAILED',
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedMs,
            lastError: msg,
          }).where({ ID: runId }),
        );
      } catch (uerr) {
        log.error(`kg-service: previewMerges run ${runId} FAILED-flag write also failed: ${uerr?.message ?? uerr}`);
      }
    }
  }
```

Note on `cds.utils.uuid()`: confirm it's the uuid helper used elsewhere in this service; if the file already imports `randomUUID` from `node:crypto` (grep first), reuse that instead for consistency.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/kg-preview-merges-async.test.js`
Expected: PASS (2 tests). If `cds.utils.uuid` is undefined, switch to the file's existing uuid source and re-run.

- [ ] **Step 6: Commit**

```bash
git add srv/knowledge-graph-service.js test/unit/kg-preview-merges-async.test.js
git commit -m "feat(#1531): async previewMerges handler with single-flight + background scan"
```

---

### Task 4: Admin UI — kick-off + poll + same dialog

**Files:**
- Modify: `app/admin/concepts/webapp/ext/ConceptActionsController.controller.js` (rewrite `onPreviewMerges`, lines 52-71; keep `postAction` and everything else)
- Modify: `app/admin/concepts/webapp/i18n/i18n.properties` (add strings)
- Modify: `app/admin/concepts/webapp/manifest.json` (bump `applicationVersion`)

**Interfaces:**
- Consumes: `POST /graph/previewMerges` → `{ runId, status, coalesced }`; `GET /graph/ConceptMergePreviewRuns(<runId>)` → `{ status, resultJson, candidatePairs, lastError }`.
- Produces: same `MessageBox.information` candidate dialog as before (50-line slice + "… and X more").

- [ ] **Step 1: Add i18n strings**

Append to `app/admin/concepts/webapp/i18n/i18n.properties`:

```properties

# Preview merges (async, #1531)
previewComputingToast=Computing merge candidates… this can take a moment.
previewTimeoutMessage=Merge preview is still running. Please try again in a minute.
previewNoCandidates=No merge candidates at the current threshold.
```

- [ ] **Step 2: Rewrite `onPreviewMerges`**

In `ConceptActionsController.controller.js`, replace the `onPreviewMerges` method (lines 52-71) with a kick-off + bounded poll. `postAction` already returns parsed JSON for a 200 with `application/json`, so it yields `{ runId, status, coalesced }`. Add a small `getRun` helper using the same CSRF-free GET.

```javascript
    onPreviewMerges: async function () {
      const oBundle = this.getView().getModel("i18n") &&
        this.getView().getModel("i18n").getResourceBundle();
      const t = (key, fallback) => (oBundle && oBundle.getText(key)) || fallback;

      try {
        const ticket = await postAction("previewMerges", {});
        const runId = ticket && ticket.runId;
        if (!runId) {
          MessageBox.error("Preview failed: no run id returned.");
          return;
        }
        MessageToast.show(t("previewComputingToast", "Computing merge candidates…"));

        const row = await this._pollPreviewRun(runId, 2000, 180000);
        if (!row) {
          MessageBox.warning(t("previewTimeoutMessage",
            "Merge preview is still running. Please try again in a minute."));
          return;
        }
        if (row.status === "FAILED") {
          MessageBox.error("Preview failed: " + (row.lastError || "unknown error"));
          return;
        }
        // DONE
        const pairs = row.resultJson ? JSON.parse(row.resultJson) : [];
        const total = (typeof row.candidatePairs === "number") ? row.candidatePairs : pairs.length;
        if (pairs.length === 0) {
          MessageToast.show(t("previewNoCandidates", "No merge candidates at the current threshold."));
          return;
        }
        const lines = pairs.slice(0, 50).map(function (p) {
          const sim = (Number(p.similarity) * 100).toFixed(1);
          return p.loserSlug + " → " + p.canonicalSlug + " (" + sim + "%)";
        });
        const moreSuffix = total > 50 ? "\n... and " + (total - 50) + " more" : "";
        MessageBox.information(lines.join("\n") + moreSuffix, {
          title: total + " merge candidate(s)"
        });
      } catch (err) {
        MessageBox.error("Preview failed: " + (err && err.message ? err.message : String(err)));
      }
    },

    /**
     * Poll GET /graph/ConceptMergePreviewRuns(<runId>) every `intervalMs` until
     * status leaves RUNNING or `ceilingMs` elapses. Returns the row (DONE/FAILED)
     * or null on ceiling. Mirrors the bounded setInterval poll in the admin-shell
     * Board dashboard (job-controls refresh).
     */
    _pollPreviewRun: function (runId, intervalMs, ceilingMs) {
      const deadline = Date.now() + ceilingMs;
      const url = "/graph/ConceptMergePreviewRuns(" + runId + ")";
      return new Promise(function (resolve) {
        (function tick() {
          fetch(url, { headers: { "Accept": "application/json" } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (row) {
              if (row && row.status && row.status !== "RUNNING") {
                resolve(row);
                return;
              }
              if (Date.now() >= deadline) {
                resolve(null);
                return;
              }
              setTimeout(tick, intervalMs);
            })
            .catch(function () {
              if (Date.now() >= deadline) { resolve(null); return; }
              setTimeout(tick, intervalMs);
            });
        })();
      });
    },
```

- [ ] **Step 3: Bump the manifest application version**

In `app/admin/concepts/webapp/manifest.json`, change `"applicationVersion": { "version": "0.0.1" }` to `"0.0.2"` (forces the UI5 IndexedDB cache to reload the changed controller post-deploy).

- [ ] **Step 4: Lint the controller**

Run: `npx ui5lint app/admin/concepts/ 2>&1 | tail -30` (or the repo's configured admin-lint command — check `jq '.scripts' package.json` for a `lint:admin`/`ui5-lint` script; if none, skip). Expected: no new errors on the edited controller. Manually re-read the diff to confirm `postAction`/`_readContext`/other methods are untouched.

- [ ] **Step 5: Commit**

```bash
git add app/admin/concepts/webapp/ext/ConceptActionsController.controller.js \
        app/admin/concepts/webapp/i18n/i18n.properties \
        app/admin/concepts/webapp/manifest.json
git commit -m "feat(#1531): Concepts admin UI polls async previewMerges run"
```

---

### Task 5: Hybrid end-to-end test (real HANA)

**Files:**
- Create: `test/hybrid/kg-preview-merges.test.js`

**Interfaces:**
- Consumes: the deployed `/graph/previewMerges` + `/graph/ConceptMergePreviewRuns` against a real HANA bind. Proves the 504 is gone (action returns fast; row reaches DONE over the real ACTIVE concept set).

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/kg-preview-merges.test.js`. Match the repo's hybrid boot convention (grep an existing `test/hybrid/*.test.js` for the exact `cds.test`/bind setup and `--project hybrid` requirement before finalizing):

```javascript
// test/hybrid/kg-preview-merges.test.js
// Real-HANA proof that async previewMerges (#1531) no longer 504s: the action
// returns a runId in well under the 30s gateway budget, and the background scan
// finalizes the run to DONE over the real ACTIVE concept set.
//
// Run: npx vitest run --project hybrid test/hybrid/kg-preview-merges.test.js
// (requires cf login + cds bind; self-configured by the hybrid vitest project)

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

const project = cds.test('serve', '--project', '.');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const NS = 'com.sap.developers.ims';

describe('previewMerges async against real HANA (#1531)', () => {
  it('returns fast and reaches DONE', async () => {
    const t0 = Date.now();
    const res = await POST('/graph/previewMerges', {}, adminAuth);
    const kickMs = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(res.data.runId).toBeTruthy();
    // Kick-off must be far under the 30s gateway timeout — that's the whole fix.
    expect(kickMs).toBeLessThan(5000);

    const db = await cds.connect.to('db');
    const { ConceptMergePreviewRuns } = cds.entities(NS);
    const deadline = Date.now() + 120000;
    let row;
    for (;;) {
      [row] = await db.run(SELECT.from(ConceptMergePreviewRuns).where({ ID: res.data.runId }));
      if (row && row.status !== 'RUNNING') break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(row.status).toBe('DONE');
    expect(row.conceptsScanned).toBeGreaterThan(0);
    expect(typeof row.candidatePairs).toBe('number');
    // resultJson is valid JSON and capped at 500 entries.
    const pairs = JSON.parse(row.resultJson || '[]');
    expect(pairs.length).toBeLessThanOrEqual(500);
  }, 130000);
});
```

- [ ] **Step 2: Run the hybrid test (requires `cf login`)**

Run: `npx vitest run --project hybrid test/hybrid/kg-preview-merges.test.js`
Expected: PASS. Kick-off < 5 s (vs. the old 30 s+ timeout); row reaches DONE. If `cf login` / bind is unavailable in this session, note that this step must be run where a HANA bind exists and leave it for the verification phase.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-preview-merges.test.js
git commit -m "test(#1531): hybrid end-to-end for async previewMerges"
```

---

### Task 6: Post-deploy e2e spec + docs + version bumps

**Files:**
- Create: `test/e2e/concepts-preview-merges.spec.js`
- Modify: `.deploy/mta.yaml` (patch version bump)

**Interfaces:**
- Consumes: deployed admin UI at `${SMOKE_BASE_URL}/admin-ui/#concepts` (Basic auth via `SMOKE_TECH_USER`/`SMOKE_TECH_PASSWORD`). Self-skips when env absent (per the `test:e2e` convention).

- [ ] **Step 1: Write the e2e spec**

Create `test/e2e/concepts-preview-merges.spec.js`. Match the existing specs in `test/e2e/` (grep one for the exact auth/baseURL/skip harness before finalizing — reuse its helpers rather than re-inventing):

```javascript
// test/e2e/concepts-preview-merges.spec.js
// Post-deploy smoke: "Preview merges" in the Concepts LR kicks off, shows the
// computing toast, and pops the candidate dialog (or a no-candidates toast) —
// i.e. it no longer 504s. Self-skips when SMOKE_BASE_URL is absent.
//
// Auth + baseURL harness mirrors the other test/e2e specs (see test/e2e/README.md).

import { test, expect } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL || process.env.PLAYWRIGHT_BASE_URL;

test.describe('Concepts — Preview merges (#1531)', () => {
  test.skip(!BASE, 'SMOKE_BASE_URL not set');

  test('preview merges returns a result without a 504', async ({ page }) => {
    await page.goto(`${BASE}/admin-ui/#concepts`);
    // Button text from i18n: previewMergesButton=Preview merges
    const btn = page.getByRole('button', { name: 'Preview merges' });
    await expect(btn).toBeVisible({ timeout: 30000 });
    await btn.click();

    // Either the candidate dialog (MessageBox) or the no-candidates toast
    // appears within the poll ceiling. A 504 would instead surface
    // "Preview failed: 504" in a MessageBox.error.
    const dialog = page.locator('.sapMMessageBox, .sapMDialog').first();
    await expect(dialog).toBeVisible({ timeout: 190000 });
    await expect(page.getByText(/Preview failed: 504/)).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Bump the MTA version**

In `.deploy/mta.yaml`, bump the top-level `version:` by a patch increment (e.g. `x.y.z` → `x.y.(z+1)`). Read the current value first: `grep -n '^version:' .deploy/mta.yaml`.

- [ ] **Step 3: Verify the model still deploys clean end-to-end**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5` → success.
Run the full new unit set: `npx vitest run test/unit/kg-similarity-chunked.test.js test/unit/kg-preview-merges-async.test.js` → PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/concepts-preview-merges.spec.js .deploy/mta.yaml
git commit -m "test(#1531): e2e preview-merges spec + patch MTA version"
```

---

## Self-Review

**Spec coverage:**
- New entity `ConceptMergePreviewRuns` → Task 2. ✓
- Changed `previewMerges` return + read projection → Task 2. ✓
- Single-flight + `setImmediate` background scan + row finalize + audit → Task 3. ✓
- `findNearDuplicatesChunked` (yielding), sync finder untouched → Task 1. ✓
- Result cap (500) + true count for "… and X more" → Task 3 (handler) + Task 4 (dialog). ✓
- Client kick-off + 2 s / 3 min bounded poll + same dialog + FAILED/timeout handling → Task 4. ✓
- i18n + manifest version bump → Task 4. ✓
- Unit (parity + service async/coalesce/failure), hybrid, e2e → Tasks 1, 3, 5, 6. ✓
- Deploy notes (cds build, full mbt, MTA patch bump) → Global Constraints + Task 6. ✓
- Stale-run self-healing via 5-min cutoff (no reconciler) → Task 3 handler. ✓

**Placeholder scan:** No TBD/TODO left as work; the two "grep the existing convention first" notes (hybrid boot in Task 5, e2e harness in Task 6) are explicit verification steps against real files, not deferred design. All code steps carry full code.

**Type consistency:** `runId`/`status`/`coalesced` returned by the action match what Task 4's client reads; `resultJson`/`candidatePairs`/`lastError`/`status` written in Task 3 match the entity in Task 2 and the reads in Tasks 3-6; `findNearDuplicatesChunked(concepts, threshold, {chunkSize,onYield})` signature is identical in Task 1's definition and Task 3's call.

**Open verification flags for the implementer (not blockers):**
- Confirm the uuid helper in `srv/knowledge-graph-service.js` (`cds.utils.uuid()` vs an imported `randomUUID`) — Task 3 Step 4 note.
- Confirm the `ims` alias in `srv/knowledge-graph-service.cds` for the projection left-hand source — Task 2 Step 3/4.
- Confirm hybrid + e2e boot/auth harness against an existing sibling test — Tasks 5/6.

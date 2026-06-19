# Set-Based SQL Recompute for TUTORIAL TaskRecords Progress — Design Spec

**Status:** Draft for review
**Tracking issue:** to be filed (#382 phase E followup)
**Date:** 2026-06-19
**Author:** Tom Jung (with Claude)

## Summary

Replace the per-tutorial, N+1-query JavaScript recompute pattern in `recomputeTutorialProgress` with a single set-based HANA SQL `UPDATE` that recomputes every affected `TUTORIAL` `TaskRecord`'s `progress` and `status` in one statement. Keep the existing JS implementation as the SQLite fallback (for unit tests and local dev). Wire the new bulk function into the publish path at end-of-batch (and at commit time as a safety net), eliminating the per-slug call in `appendToSession` that's currently making `/content/publish/append` requests take 286+ seconds and timing out the publish workflow.

## Goals

1. **Bring publish back to working order on DEV.** A full 1400-slug publish should complete in 60-90 seconds wall clock, including progress recompute. Currently each /append batch takes 286+ seconds and the workflow fails.
2. **Keep the cached `progress` / `status` columns on TUTORIAL TaskRecords.** Aggregate analytics (admin avg-completion %, scanner counts, co-completion) rely on `WHERE status = 'COMPLETED'` and would themselves become slow if we dropped the columns. Denormalization stays; only the recompute strategy changes.
3. **Use HANA's column-store strengths properly.** A single set-based UPDATE with subquery aggregation is HANA's native pattern; N+1 SELECT + UPDATE round-trips are precisely what HANA is *not* optimized for. The fix lets HANA do what HANA is good at.
4. **Preserve correctness contracts** from issue #89 (stale 100% rows on stepCount change). The new path produces the same end-state as today, just via one SQL operation instead of thousands.
5. **Localized blast radius.** The change touches one new file + two existing files in `srv/lib/`. No schema migration. No new feature flag. No data migration. Read paths unchanged. Write paths (user step-completion) unchanged.

## Non-Goals

- **Dropping the cached columns entirely (option C1).** Breaks aggregate analytics that today rely on `WHERE status = 'COMPLETED'`. Would require rewriting 4-6 read sites with JOIN-based queries. Net loss.
- **Background-job-based async recompute (option B).** Trades publish-time work for an eventual-consistency window where users see stale progress. Acceptable but C4 makes it unnecessary.
- **Lazy-on-read repair (option C3).** Adds per-row read overhead and a new "computed-at" column. Architecturally fine but more invasive than C4.
- **Restructuring the TaskRecords schema** (e.g. splitting TUTORIAL records into a separate table). Out of scope.
- **Adding HANA indexes on TaskRecords.** The diagnosis identified that TaskRecords has only the PK index, contributing to the slow path. Set-based SQL UPDATE benefits from indexes too, but HANA column-store handles this query class well even without secondary indexes. We may revisit indexes as a follow-up if the bulk SQL is still slower than expected, but they're not required for this fix.

## Background — what's slow today and why

Today's publish path calls `recomputeTutorialProgress` (in `srv/lib/content-store.js`) twice:

1. **Per-slug** inside `appendToSession`'s metadata loop ([srv/lib/content-publish-session.js:346](../../../srv/lib/content-publish-session.js#L346))
2. **Per-changed-slug at commit** inside `recomputeProgressForChangedTutorials` ([srv/lib/content-publish-session.js:577-592](../../../srv/lib/content-publish-session.js#L577-L592))

`recomputeTutorialProgress` itself ([srv/lib/content-store.js:85-121](../../../srv/lib/content-store.js#L85-L121)) does:

1. SELECT one Tutorials row by ID
2. SELECT all Steps for the tutorial
3. SELECT all TUTORIAL TaskRecords for the tutorial (returns N rows, one per user with progress)
4. **For each of those N rows**: SELECT completed STEP TaskRecords for that user
5. Conditional UPDATE the TUTORIAL row if progress/status changed

For each tutorial, that's `3 + 2N` HANA round-trips (where N = number of users with progress). At publish-scale: 1400 tutorials × ~50 users avg ≈ **140,000 HANA round-trips per publish**. With ~50ms of HANA latency per round-trip, that's ~2 hours of wall-clock work — plus the duplication between append-time and commit-time. The undici 30-second headers timeout fires on the very first /append batch.

The TaskRecords table currently has 10.8M rows; even when each query is fast individually, the sheer count of round-trips defeats us.

## Approach — set-based MERGE INTO

Replace the N+1 pattern with one HANA SQL `MERGE INTO` statement that does all the math in a single set-based operation. HANA's canonical pattern for "update many rows based on a computed source" is `MERGE INTO ... USING ... WHEN MATCHED THEN UPDATE` — `UPDATE...FROM` (the PostgreSQL/SQL-Server form) is **not supported on HANA** and the spec is committing to MERGE here so the implementer doesn't have to choose at code time.

**Identifier convention:** all HANA identifiers are wrapped in **quoted-uppercase** (e.g. `"COM_SAP_DEVELOPERS_IMS_TASKRECORDS"`, `"PROGRESS"`), matching the existing pattern in [`srv/lib/embedding-query.js`](../../../srv/lib/embedding-query.js) and the constraint from [feedback_hana_raw_sql_uppercase] (HDI deploys UPPERCASE; quoted-lowercase fails). Per [feedback_hana_boolean_case_when], CASE comparisons against booleans need `= true` / `= false` — but this query has no booleans, so that doesn't apply.

```sql
MERGE INTO "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" AS "T"
USING (
  SELECT
    "OUTER"."ID"        AS "TR_ID",
    "OUTER"."PROGRESS"  AS "OLD_PROGRESS",
    "OUTER"."STATUS"    AS "OLD_STATUS",
    "OUTER"."COMPLETIONDATE" AS "OLD_COMPLETIONDATE",
    CASE
      WHEN "TU"."STEPCOUNT" IS NULL OR "TU"."STEPCOUNT" <= 0
        THEN "OUTER"."PROGRESS"
      ELSE CAST(ROUND( (1.0 * COALESCE("C"."COMPLETED_COUNT", 0) / "TU"."STEPCOUNT") * 100 ) AS INTEGER)
    END AS "NEW_PROGRESS",
    CASE
      WHEN "TU"."STEPCOUNT" IS NULL OR "TU"."STEPCOUNT" <= 0
        THEN "OUTER"."STATUS"
      WHEN COALESCE("C"."COMPLETED_COUNT", 0) >= "TU"."STEPCOUNT"
        THEN 'COMPLETED'
      ELSE 'IN_PROGRESS'
    END AS "NEW_STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" "OUTER"
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS"  "TU" ON "TU"."LEGACYID" = "OUTER"."TASKLEGACYID"
  LEFT JOIN (
    SELECT "SR"."USER_ID" AS "USER_ID",
           "ST"."TUTORIAL_ID" AS "TUTORIAL_ID",
           COUNT(DISTINCT "ST"."LEGACYID") AS "COMPLETED_COUNT"
    FROM "COM_SAP_DEVELOPERS_IMS_STEPS" "ST"
    JOIN "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" "SR"
      ON "SR"."TASKLEGACYID" = "ST"."LEGACYID"
     AND "SR"."TASKTYPE"     = 'STEP'
     AND "SR"."STATUS"       = 'COMPLETED'
    WHERE "ST"."TUTORIAL_ID" IN ( /* :tutorialIds */ )
    GROUP BY "SR"."USER_ID", "ST"."TUTORIAL_ID"
  ) "C" ON "C"."USER_ID" = "OUTER"."USER_ID" AND "C"."TUTORIAL_ID" = "TU"."ID"
  WHERE "OUTER"."TASKTYPE" = 'TUTORIAL'
    AND "TU"."ID" IN ( /* :tutorialIds */ )
) AS "S"
ON "T"."ID" = "S"."TR_ID"
WHEN MATCHED AND (
  -- NULL-safe inequality: rows with NULL old/new on either side trigger update if values actually differ.
  -- HANA 2.0 SP05+ supports IS DISTINCT FROM; we hand-write the equivalent for portability.
  ("S"."OLD_PROGRESS" IS NULL AND "S"."NEW_PROGRESS" IS NOT NULL)
  OR ("S"."OLD_PROGRESS" IS NOT NULL AND "S"."NEW_PROGRESS" IS NULL)
  OR ("S"."OLD_PROGRESS" != "S"."NEW_PROGRESS")
  OR ("S"."OLD_STATUS" IS NULL AND "S"."NEW_STATUS" IS NOT NULL)
  OR ("S"."OLD_STATUS" IS NOT NULL AND "S"."NEW_STATUS" IS NULL)
  OR ("S"."OLD_STATUS" != "S"."NEW_STATUS")
) THEN UPDATE SET
  "PROGRESS"       = "S"."NEW_PROGRESS",
  "STATUS"         = "S"."NEW_STATUS",
  "COMPLETIONDATE" = CASE
    WHEN "S"."NEW_STATUS" = 'COMPLETED' THEN COALESCE("S"."OLD_COMPLETIONDATE", CURRENT_UTCTIMESTAMP)
    ELSE NULL
  END,
  "MODIFIEDAT"     = CURRENT_UTCTIMESTAMP;
```

**How HANA executes this:**

- The inner `LEFT JOIN` (counting STEP completions per user-tutorial pair) is a column-store group-by — HANA's strongest pattern. With ~2.5M relevant STEP rows and an output of ~50 user-tutorial pairs, this is sub-second.
- The outer `JOIN "TUTORIALS"` is a small lookup join on `"LEGACYID"` (1400 rows max).
- The `WHEN MATCHED AND (NULL-safe inequality)` predicate filters out no-op rows; HANA's MERGE engine only writes the changed rows. Idempotent on repeated runs.
- The whole MERGE runs in 1-3 seconds for ~50 tutorials per /append batch.

**Why two `:tutorialIds` placeholders.** The same list appears twice in the query (once in the inner aggregate's `WHERE "ST"."TUTORIAL_ID" IN (...)`, once in the outer scope's `WHERE "TU"."ID" IN (...)`). The inner placeholder ensures the aggregate only computes counts for in-scope tutorials (avoids scanning all 1400). The outer placeholder ensures the MERGE only touches rows for in-scope tutorials. The implementer should bind the same array to both via parameter or by string-interpolating a sanitized comma-separated list of UUIDs (UUIDs are safe to interpolate; they don't accept SQL injection). Param binding is preferred where the driver supports it.

### Alternative considered and rejected: UPDATE...FROM

The PostgreSQL-style `UPDATE t SET col = computed.col FROM (subquery) AS computed WHERE t.ID = computed.ID` is **not supported on HANA**. An earlier draft of this spec used that form; it would fail at runtime with an SQL syntax error. MERGE INTO is the canonical HANA equivalent.

### SQLite fallback

CDS unit tests run against in-memory SQLite. SQLite does not support `MERGE INTO`, and its `UPDATE...FROM` dialect (SQLite 3.33+) differs in subtle ways. Test fixtures are tiny (typically <100 records), so we keep the existing per-tutorial JS implementation as the fallback path:

```js
// In recompute-tutorial-progress-bulk-sql.js:
export async function recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds) {
  if (!Array.isArray(tutorialIds) || tutorialIds.length === 0) {
    return { rechecked: 0, updated: 0 };
  }
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    // SQLite test path: fall through to the existing JS implementation per-tutorial.
    const { Tutorials } = cds.entities(namespace);
    let totalRechecked = 0, totalUpdated = 0;
    for (const tutorialId of tutorialIds) {
      const tutorial = await SELECT.one.from(Tutorials).where({ ID: tutorialId }).columns('ID', 'stepCount');
      if (!tutorial?.stepCount) continue;
      const result = await recomputeTutorialProgress(db, namespace, tutorialId, tutorial.stepCount);
      totalRechecked += result.rechecked;
      totalUpdated += result.updated;
    }
    return { rechecked: totalRechecked, updated: totalUpdated };
  }
  // HANA fast path: single set-based MERGE.
  const result = await db.run(BULK_RECOMPUTE_MERGE_SQL, [tutorialIds, tutorialIds]);
  return { rechecked: tutorialIds.length, updated: result?.affectedRows ?? null };
}
```

The branch is by db kind, mirroring the proven pattern from [`srv/lib/embedding-query.js`](../../../srv/lib/embedding-query.js).

## Architecture

```text
publish-content.ts (CI client)
  ↓ POST /content/publish/append (50 slugs)
srv/lib/content-store.js → appendHandler
  ↓
srv/lib/content-publish-session.js → appendToSession
  ↓
  ├─ DELETE+INSERT ContentFiles (unchanged)
  ├─ upsertTutorialMetadata (unchanged — sets stepCount, doesn't recompute progress)
  ├─ upsertBodyTexts (unchanged)
  ├─ upsertBranchSpecs (unchanged)
  └─ NEW: recomputeTutorialProgressBulkSQL(db, namespace, tutorialIdsTouchedByThisBatch) ← single SQL UPDATE
  ↓
  UPDATE ContentManifest.lastAppendAt
  ↓
  return 202

then later:
  ↓ POST /content/publish/commit
srv/lib/content-publish-session.js → commitSession
  ↓
  ├─ carryForwardUnchanged (unchanged)
  ├─ NEW: recomputeProgressForChangedTutorials → calls recomputeTutorialProgressBulkSQL(...allTutorialIdsInThisVersion)
  │  (still scoped to tutorials touched in this version; the bulk SQL's WHERE predicates filter no-op rows)
  └─ Mark previous ACTIVE as SUPERSEDED, flip new to ACTIVE
```

### New module

| File | Responsibility |
|------|---------------|
| `srv/lib/recompute-tutorial-progress-bulk-sql.js` | Exports `recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds)`. Branches by db kind: HANA → single MERGE INTO statement; SQLite → loop over `recomputeTutorialProgress`. ~80-100 lines. Filename matches the new test file (`recompute-tutorial-progress-bulk-sql.test.js`) for grep-friendliness. |

### Modified modules

| File | Change |
|------|--------|
| `srv/lib/content-publish-session.js:346` | Replace per-slug `recomputeTutorialProgress` call with collection of `tutorialId` into a `Set` for batch-level recompute. After the metadata loop completes (around line 348), call `recomputeTutorialProgressBulkSQL(db, namespace, [...batchTutorialIds])`. **Scope clarification:** the per-batch bulk call covers tutorials whose metadata was supplied in this `/append` (i.e. slugs in this batch). Body-only chunks (where `metadata` is empty) collect zero tutorialIds → no-op. The commit-time safety-net call (below) covers everyone in this version. Same contract as today, just batched. |
| `srv/lib/content-publish-session.js:564-592` (`recomputeProgressForChangedTutorials`) | Replace per-slug loop with: (1) one slug→tutorialId resolution batch, (2) one `recomputeTutorialProgressBulkSQL(db, namespace, allTutorialIdsInVersion)` call. Function shrinks from ~30 lines to ~15. |
| `srv/lib/content-store.js:510` (legacy `publishHandler`) | Same per-slug call exists in the pre-chunked one-shot publish endpoint. Replace with bulk call. The legacy `publishHandler` is exercised by SQLite unit tests and chunked path's hybrid tests (parity matters); via the SQLite branch of `recomputeTutorialProgressBulkSQL`, it'll loop the existing JS implementation as before — semantically identical, just routed through the new function so call-site contracts stay uniform. |

### Preserved (NO change)

| File | Why preserved |
|------|---------------|
| `srv/lib/content-store.js:85-121` (`recomputeTutorialProgress`) | Still useful for SQLite path. Still useful as a per-tutorial idempotent helper for any future caller that needs single-tutorial recompute (issue #89 test exercises it directly). |
| `srv/developer-service.js:673-694` (user step-complete write path) | Unchanged. Still computes progress per-step-completion via `calculateTutorialProgress`. The cached columns are still written here. |
| All read sites (`user-progress.js`, `co-completion.js`, `scanner-service.js`, `admin-service.js`, etc.) | Unchanged. They still read the cached columns. |

## Test strategy

### Unit (SQLite, vitest)

- Existing `test/issue-89-progress-denominator.test.js` continues to pass against the JS fallback. No new unit tests required for the JS path.
- New unit test `test/recompute-tutorial-progress-bulk-sql.test.js`:
  - Asserts the bulk function on SQLite produces the same results as the existing `recomputeTutorialProgress` per-tutorial calls (i.e. the SQLite fallback is correct)
  - Covers the no-op case (no changed rows → zero UPDATEs)
  - Covers the cross-tutorial case (multiple tutorialIds in one call)
  - **Legacy `publishHandler` parity:** asserts that the legacy SQLite path (which used to call `recomputeTutorialProgress` directly) still produces identical end-state when routed through the bulk function. Protects against contract drift if someone later removes the SQLite fallback or changes its semantics.

### Hybrid (HANA, vitest test/hybrid/)

New test `test/hybrid/recompute-tutorial-progress-bulk-sql.test.js`:

- Seeds a fixture with 5 tutorials × 10 users × {STEP completed, STEP not completed} variants
- Runs the bulk SQL recompute
- Asserts `progress` and `status` are correct on each TUTORIAL TaskRecord
- Asserts no-op rows aren't unnecessarily updated (modifiedAt should not advance for unchanged rows; assert via SELECTing modifiedAt before/after)
- Asserts cross-tutorial isolation (recompute for tutorial A doesn't touch tutorial B's TaskRecords)
- Soft performance assertion: bulk recompute against the test fixture completes in <1 second

### Integration (smoke against DEV)

After the fix lands and a publish completes successfully:

- Hit `/build/catalog` and confirm tutorials' TUTORIAL TaskRecords for known users have plausible `progress`/`status`
- Hit `/me` for a known test user and confirm their progress card shows correct numbers post-publish
- Hit admin avg-completion-% tile and confirm it returns numerically reasonable values

## Validation gates

1. **Unit tests pass** — `npm test -- --run scripts/ srv/ test/` shows the new tests green and no regressions
2. **Hybrid test passes** — `npm run test:hybrid -- recompute-tutorial-progress-bulk-sql` green against DEV HANA
3. **Live publish succeeds** — `gh workflow run rebuild-content.yml` against DEV completes without `HeadersTimeoutError` and full publish < 90s wall clock
4. **DEV smoke checks** — the 4 phase-E acceptance checks (HTTP 200 on the 4 meta-tutorials slugs; admin tile sane; /me sane)

## Risks and open questions

1. **HANA MERGE INTO dialect (resolved at spec time).** HANA does not support PostgreSQL/SQL-Server-style `UPDATE...FROM`. The spec commits to `MERGE INTO ... USING ... WHEN MATCHED THEN UPDATE`, which is the canonical HANA equivalent and is well-supported. The exact statement form has been pre-validated against HANA SQL reference; one final pre-flight test in a dev REPL during implementation confirms the parameter binding for the `IN (:tutorialIds)` placeholders.
2. **Aggregate `MODIFIEDAT` writes.** The bulk SQL sets `MODIFIEDAT = CURRENT_UTCTIMESTAMP` on changed rows. CDS-managed `modifiedAt` is normally written by CAP's managed-aspect interceptor; bypassing CDS QL means we set it manually. Confirm shape matches what the read-side code expects (it reads from the same column so this should be transparent).
3. **NULL semantics in the no-op filter (resolved in the SQL above).** A naive `tr.PROGRESS != computed.PROGRESS` returns NULL (falsy) when either side is NULL — so a row transitioning from `PROGRESS=NULL` to `PROGRESS=42` would not be picked up for update. The `WHEN MATCHED AND (...)` predicate above hand-writes the NULL-safe inequality (`IS NULL AND IS NOT NULL` plus `IS NOT NULL AND IS NULL` plus `!=`) for portability across HANA versions. HANA 2.0 SP05+ supports `IS DISTINCT FROM` which would simplify the syntax — but the hand-written form works across older HANA too and matches CDS-emitted columns.
4. **Rollback path.** If the bulk SQL is slow or wrong on some unforeseen data shape, fall back to the per-tutorial JS path. Since `recomputeTutorialProgress` (the old function) is preserved, the rollback is a one-line revert of the call sites. Not a dead-code argument; the fallback is genuinely useful.
5. **Concurrency.** The publish path holds the `content-publish` job lock; only one publish runs at a time. So no two `recomputeTutorialProgressBulkSQL` calls overlap on the same data. User step-completions can still write to TUTORIAL TaskRecords during a publish, but they target different rows (one user at a time, one tutorial at a time) — no conflict with the bulk MERGE.

   **Isolation expectation:** HANA executes MERGE atomically per-row under READ COMMITTED — a concurrent step-complete write to a TUTORIAL row that is also a MERGE target either lands before the MERGE's snapshot (and the MERGE's `WHEN MATCHED AND (inequality)` filter sees the new value, possibly skipping) or after (the MERGE's UPDATE wins, then the user's UPDATE wins on top). Either ordering produces a consistent end state because both paths compute progress from the same underlying STEP records. Verified at implementation time with a hybrid test that exercises a step-complete UPDATE racing the bulk MERGE.

6. **`MODIFIEDAT` consumers.** The bulk MERGE bumps `MODIFIEDAT` on every changed row. If any read site filters TUTORIAL TaskRecords by recent `MODIFIEDAT` to mean "user activity", a bulk publish would visually backdate-bump those rows. Implementation pre-flight: grep the read sites (`srv/lib/user-progress.js`, `srv/lib/co-completion.js`, `srv/scanner-service.js`, `srv/admin-service.js`, `srv/exports/`) for `modifiedAt` filters on TUTORIAL records. If any are found, add a separate column (e.g. `progressComputedAt`) or skip the `MODIFIEDAT` write in the MERGE.

## References

- Failing publish runs: [27790881959](https://github.com/sap-tutorials/tutorials-ims/actions/runs/27790881959), [27823662006](https://github.com/sap-tutorials/tutorials-ims/actions/runs/27823662006)
- Issue #420 (Circle 2 — worker_threads pool): superseded by this spec; if C4 lands successfully, #420 may not be needed at all (the publish event loop is no longer saturated)
- Issue #421 (Circle 3 — split publish-worker app): orthogonal; still worth doing for read-path isolation, but no longer urgent
- Issue #382 (the originating mission rollout that surfaced this): blocked on this fix
- Issue #89 (the original recompute requirement): preserved by this spec; same correctness contract
- HANA SQL UPDATE with subquery: <https://help.sap.com/docs/SAP_HANA_PLATFORM/4fe29514fd584807ac9f2a04f6754767/c801ccb9bb571014a09abda7c3d8e3a6.html>
- CLAUDE.md "HANA LOB locator expiry" section — pattern for HANA-vs-SQLite raw SQL branching

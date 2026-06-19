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

## Approach — set-based UPDATE

Replace the N+1 pattern with one HANA SQL statement that does all the math in a single set-based operation. Conceptually:

```sql
UPDATE COM_SAP_DEVELOPERS_IMS_TASKRECORDS AS tr SET
  PROGRESS = computed.PROGRESS,
  STATUS   = computed.STATUS,
  COMPLETIONDATE = CASE
    WHEN computed.STATUS = 'COMPLETED'
      THEN COALESCE(tr.COMPLETIONDATE, CURRENT_UTCTIMESTAMP)
    ELSE NULL
  END,
  MODIFIEDAT = CURRENT_UTCTIMESTAMP
FROM (
  SELECT
    tr.ID,
    tr.USER_ID,
    tu.ID AS TUTORIAL_ID,
    tu.STEPCOUNT,
    COALESCE(c.COMPLETED_COUNT, 0) AS COMPLETED_COUNT,
    CASE
      WHEN tu.STEPCOUNT IS NULL OR tu.STEPCOUNT <= 0 THEN tr.PROGRESS
      ELSE ROUND( (1.0 * COALESCE(c.COMPLETED_COUNT, 0) / tu.STEPCOUNT) * 100 )
    END AS PROGRESS,
    CASE
      WHEN tu.STEPCOUNT IS NULL OR tu.STEPCOUNT <= 0 THEN tr.STATUS
      WHEN COALESCE(c.COMPLETED_COUNT, 0) >= tu.STEPCOUNT THEN 'COMPLETED'
      ELSE 'IN_PROGRESS'
    END AS STATUS
  FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS tr
  JOIN COM_SAP_DEVELOPERS_IMS_TUTORIALS  tu ON tu.LEGACYID = tr.TASKLEGACYID
  LEFT JOIN (
    SELECT sr.USER_ID, st.TUTORIAL_ID, COUNT(DISTINCT st.LEGACYID) AS COMPLETED_COUNT
    FROM COM_SAP_DEVELOPERS_IMS_STEPS st
    JOIN COM_SAP_DEVELOPERS_IMS_TASKRECORDS sr
      ON sr.TASKLEGACYID = st.LEGACYID
     AND sr.TASKTYPE     = 'STEP'
     AND sr.STATUS       = 'COMPLETED'
    WHERE st.TUTORIAL_ID IN ( /* selected tutorialIds */ )
    GROUP BY sr.USER_ID, st.TUTORIAL_ID
  ) c ON c.USER_ID = tr.USER_ID AND c.TUTORIAL_ID = tu.ID
  WHERE tr.TASKTYPE = 'TUTORIAL'
    AND tr.TASKLEGACYID IN (
      SELECT LEGACYID FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS
       WHERE ID IN ( /* selected tutorialIds */ )
    )
) AS computed
WHERE tr.ID = computed.ID
  AND ( tr.PROGRESS != computed.PROGRESS OR tr.STATUS != computed.STATUS );
```

This is one SQL statement. HANA's column-store-native query engine handles it as:

- Inner `LEFT JOIN` (counting STEP completions per user-tutorial pair) is a column-store group-by — HANA's strongest pattern
- Outer `JOIN Tutorials` is a standard inner join on `LEGACYID`
- Final `WHERE tr.PROGRESS != computed.PROGRESS OR tr.STATUS != computed.STATUS` predicate filters out no-op rows; HANA's UPDATE engine only writes the changed rows
- Set-update over millions of input rows runs in seconds, not hours

**Expected runtime**: 1-3 seconds for ~50 tutorials per /append batch (50 in-flight × ~50 users avg ≈ 2,500 rows materialized in the inner aggregate; sub-second updates). Per publish: ~5-10 seconds total cumulative across all batches + the commit-time safety net.

### SQLite fallback

CDS unit tests run against in-memory SQLite. SQLite's UPDATE...FROM dialect differs from HANA's, and the parser/planner doesn't optimize this kind of query the same way. Test fixtures are tiny (typically <100 records), so we keep the existing per-tutorial JS implementation as the fallback path:

```js
// In recompute-tutorial-progress-sql.js:
export async function recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds) {
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    // SQLite test path: fall through to the existing JS implementation
    for (const tutorialId of tutorialIds) {
      const tutorial = await SELECT.one.from(...).where({ ID: tutorialId }).columns('ID', 'stepCount');
      if (!tutorial) continue;
      await recomputeTutorialProgress(db, namespace, tutorialId, tutorial.stepCount);
    }
    return;
  }
  // HANA fast path: single set-based UPDATE.
  await db.run(BULK_RECOMPUTE_SQL, [tutorialIds, tutorialIds]);
}
```

The branch is by db kind, mirroring the proven pattern from `srv/lib/embedding-query.js` (per CLAUDE.md "HANA LOB locator expiry" and the embedding hybrid path).

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
| `srv/lib/recompute-tutorial-progress-sql.js` | Exports `recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds)`. Branches by db kind: HANA → single SQL UPDATE; SQLite → loop over `recomputeTutorialProgress`. ~80-100 lines. |

### Modified modules

| File | Change |
|------|--------|
| `srv/lib/content-publish-session.js:346` | Replace per-slug `recomputeTutorialProgress` call with collection of `tutorialId` into a `Set` for batch-level recompute. After the metadata loop, call `recomputeTutorialProgressBulkSQL(db, namespace, [...batchTutorialIds])`. |
| `srv/lib/content-publish-session.js:564-592` | Replace per-slug loop in `recomputeProgressForChangedTutorials` with a single resolution of slugs → tutorialIds, then one `recomputeTutorialProgressBulkSQL` call. |
| `srv/lib/content-store.js:510` | Same per-slug call exists in legacy `publishHandler`; replace with bulk call (same shape as content-publish-session.js fix). Legacy handler still used by SQLite tests; matters for behavior parity. |

### Preserved (NO change)

| File | Why preserved |
|------|---------------|
| `srv/lib/content-store.js:85-121` (`recomputeTutorialProgress`) | Still useful for SQLite path. Still useful as a per-tutorial idempotent helper for any future caller that needs single-tutorial recompute (issue #89 test exercises it directly). |
| `srv/developer-service.js:673-694` (user step-complete write path) | Unchanged. Still computes progress per-step-completion via `calculateTutorialProgress`. The cached columns are still written here. |
| All read sites (`user-progress.js`, `co-completion.js`, `scanner-service.js`, `admin-service.js`, etc.) | Unchanged. They still read the cached columns. |

## Test strategy

### Unit (SQLite, vitest)

- Existing `test/issue-89-progress-denominator.test.js` continues to pass against the JS fallback. No new unit tests required for the JS path.
- New unit test `test/recompute-tutorial-progress-sql.test.js`:
  - Asserts the bulk function on SQLite produces the same results as the existing `recomputeTutorialProgress` per-tutorial calls (i.e. the SQLite fallback is correct)
  - Covers the no-op case (no changed rows → zero UPDATEs)
  - Covers the cross-tutorial case (multiple tutorialIds in one call)

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

1. **HANA UPDATE...FROM dialect.** HANA does support UPDATE with subquery (verified via [SAP HANA SQL Reference](https://help.sap.com/docs/SAP_HANA_PLATFORM/4fe29514fd584807ac9f2a04f6754767/c801ccb9bb571014a09abda7c3d8e3a6.html) and our existing raw-SQL usage in `srv/lib/embedding-query.js`). The exact statement form needs validation in a dev REPL before commit. Spec uses canonical `MERGE` semantics; if HANA prefers `MERGE INTO` over `UPDATE...FROM`, we adapt the query at implementation time.
2. **Aggregate `MODIFIEDAT` writes.** The bulk SQL sets `MODIFIEDAT = CURRENT_UTCTIMESTAMP` on changed rows. CDS-managed `modifiedAt` is normally written by CAP's managed-aspect interceptor; bypassing CDS QL means we set it manually. Confirm shape matches what the read-side code expects (it reads from the same column so this should be transparent).
3. **The `WHERE tr.PROGRESS != computed.PROGRESS OR tr.STATUS != computed.STATUS` predicate.** In CDS-emitted rows where `PROGRESS` is NULL, the `!=` comparison returns NULL (not TRUE), which evaluates falsy. Need to handle NULL-vs-value comparisons explicitly with `IS DISTINCT FROM` or an `OR ... IS NULL` clause. Implementation will verify with a small pre-flight test.
4. **Rollback path.** If the bulk SQL is slow or wrong on some unforeseen data shape, fall back to the per-tutorial JS path. Since `recomputeTutorialProgress` (the old function) is preserved, the rollback is a one-line revert of the call sites. Not a dead-code argument; the fallback is genuinely useful.
5. **Concurrency.** The publish path holds the `content-publish` job lock; only one publish runs at a time. So no two `recomputeTutorialProgressBulkSQL` calls overlap on the same data. User step-completions can still write to TUTORIAL TaskRecords during a publish, but they target different rows (one user at a time, one tutorial at a time) — no conflict with the bulk UPDATE.

## References

- Failing publish runs: [27790881959](https://github.com/sap-tutorials/tutorials-ims/actions/runs/27790881959), [27823662006](https://github.com/sap-tutorials/tutorials-ims/actions/runs/27823662006)
- Issue #420 (Circle 2 — worker_threads pool): superseded by this spec; if C4 lands successfully, #420 may not be needed at all (the publish event loop is no longer saturated)
- Issue #421 (Circle 3 — split publish-worker app): orthogonal; still worth doing for read-path isolation, but no longer urgent
- Issue #382 (the originating mission rollout that surfaced this): blocked on this fix
- Issue #89 (the original recompute requirement): preserved by this spec; same correctness contract
- HANA SQL UPDATE with subquery: <https://help.sap.com/docs/SAP_HANA_PLATFORM/4fe29514fd584807ac9f2a04f6754767/c801ccb9bb571014a09abda7c3d8e3a6.html>
- CLAUDE.md "HANA LOB locator expiry" section — pattern for HANA-vs-SQLite raw SQL branching

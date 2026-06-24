// Bulk set-based recompute of TUTORIAL TaskRecords (#382 phase E).
//
// Replaces the per-tutorial N+1 query pattern in
// srv/lib/content-store.js#recomputeTutorialProgress with a single set-based
// HANA MERGE INTO statement. SQLite (test path) loops the existing JS
// implementation as a fallback so unit tests don't need a real HANA.
//
// Spec: docs/superpowers/specs/2026-06-19-publish-progress-recompute-set-based-sql-design.md
//
// ----------------------------------------------------------------------------
// Validated MERGE statement
// ----------------------------------------------------------------------------
// The SQL below was validated against DEV HANA on 2026-06-19 (Phase A) using
// fixture tutorial 7997cb59-747e-43f5-b5ac-2d02e68e9da3 (slug
// 'hxe-ua-predictive-sql', stepCount=7, 5 user TaskRecords). Verified:
//
//   1. Compiles cleanly on HANA — no syntax errors first try.
//   2. Correctly updates rows whose computed progress/status differs from
//      cached values (deliberately staled 1 row → MERGE updated exactly 1).
//   3. WHEN MATCHED predicate skips no-op rows (4 already-correct rows had
//      MODIFIEDAT unchanged after MERGE).
//   4. Idempotent: re-running on converged state returns "Rows affected: 0".
//      Note (Task 14, #600): idempotency only holds because the BASE selector
//      explicitly excludes STATUS='SUPERSEDED'. Without that exclusion, every
//      run would recompute prior-attempt rows and overwrite their preserved
//      completionDate.
//
// Two alias renames vs the spec's example were applied for readability:
//   - "OUTER" → "BASE" (avoids potential reserved-keyword collision)
//   - "T" → "TGT", "S" → "SRC" (clearer intent)
//
// The two `:tutorialIds` placeholders are filled at runtime; the same array
// is passed twice (inner aggregate scope + outer scope filter).

import cds from '@sap/cds';
import { recomputeTutorialProgress } from './content-store.js';

const LOG = cds.log('content-publish');

const BULK_RECOMPUTE_MERGE_SQL = `
MERGE INTO "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" AS "TGT"
USING (
  SELECT
    "BASE"."ID"             AS "TR_ID",
    "BASE"."PROGRESS"       AS "OLD_PROGRESS",
    "BASE"."STATUS"         AS "OLD_STATUS",
    "BASE"."COMPLETIONDATE" AS "OLD_COMPLETIONDATE",
    CASE
      WHEN "TU"."STEPCOUNT" IS NULL OR "TU"."STEPCOUNT" <= 0
        THEN "BASE"."PROGRESS"
      ELSE CAST(ROUND( (1.0 * COALESCE("C"."COMPLETED_COUNT", 0) / "TU"."STEPCOUNT") * 100 ) AS INTEGER)
    END AS "NEW_PROGRESS",
    CASE
      WHEN "TU"."STEPCOUNT" IS NULL OR "TU"."STEPCOUNT" <= 0
        THEN "BASE"."STATUS"
      WHEN COALESCE("C"."COMPLETED_COUNT", 0) >= "TU"."STEPCOUNT"
        THEN 'COMPLETED'
      ELSE 'IN_PROGRESS'
    END AS "NEW_STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" "BASE"
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS"  "TU" ON "TU"."LEGACYID" = "BASE"."TASKLEGACYID"
  LEFT JOIN (
    SELECT "SR"."USER_ID" AS "USER_ID",
           "ST"."TUTORIAL_ID" AS "TUTORIAL_ID",
           COUNT(DISTINCT "ST"."LEGACYID") AS "COMPLETED_COUNT"
    FROM "COM_SAP_DEVELOPERS_IMS_STEPS" "ST"
    JOIN "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" "SR"
      ON "SR"."TASKLEGACYID" = "ST"."LEGACYID"
     AND "SR"."TASKTYPE"     = 'STEP'
     AND "SR"."STATUS"       = 'COMPLETED'
    WHERE "ST"."TUTORIAL_ID" IN ( :tutorialIds )
    GROUP BY "SR"."USER_ID", "ST"."TUTORIAL_ID"
  ) "C" ON "C"."USER_ID" = "BASE"."USER_ID" AND "C"."TUTORIAL_ID" = "TU"."ID"
  WHERE "BASE"."TASKTYPE" = 'TUTORIAL'
    -- Task 14 (#600): SUPERSEDED rows preserve historical completion timestamps
    -- from prior attempts. They must NEVER be recomputed — doing so would
    -- overwrite their completionDate every time the publish pipeline runs
    -- (the WHEN MATCHED branch sets completionDate=NULL when computed status
    -- is anything other than COMPLETED). Excluding SUPERSEDED here is the
    -- canonical correctness fix for the /me/ page's "preserve past completions"
    -- guarantee. Idempotency now depends on this exclusion.
    AND "BASE"."STATUS" != 'SUPERSEDED'
    AND "TU"."ID" IN ( :tutorialIds )
) AS "SRC"
ON "TGT"."ID" = "SRC"."TR_ID"
WHEN MATCHED AND (
  ("SRC"."OLD_PROGRESS" IS NULL AND "SRC"."NEW_PROGRESS" IS NOT NULL)
  OR ("SRC"."OLD_PROGRESS" IS NOT NULL AND "SRC"."NEW_PROGRESS" IS NULL)
  OR ("SRC"."OLD_PROGRESS" != "SRC"."NEW_PROGRESS")
  OR ("SRC"."OLD_STATUS" IS NULL AND "SRC"."NEW_STATUS" IS NOT NULL)
  OR ("SRC"."OLD_STATUS" IS NOT NULL AND "SRC"."NEW_STATUS" IS NULL)
  OR ("SRC"."OLD_STATUS" != "SRC"."NEW_STATUS")
) THEN UPDATE SET
  "PROGRESS"       = "SRC"."NEW_PROGRESS",
  "STATUS"         = "SRC"."NEW_STATUS",
  "COMPLETIONDATE" = CASE
    WHEN "SRC"."NEW_STATUS" = 'COMPLETED' THEN COALESCE("SRC"."OLD_COMPLETIONDATE", CURRENT_UTCTIMESTAMP)
    ELSE NULL
  END,
  "MODIFIEDAT"     = CURRENT_UTCTIMESTAMP
`;

/**
 * Bulk-recompute progress and status on TUTORIAL TaskRecords for a set of
 * tutorials. On HANA, executes a single MERGE INTO statement that does the
 * math set-based; on SQLite (test path), loops the per-tutorial JS
 * implementation in content-store.js#recomputeTutorialProgress.
 *
 * @param {object} db          - cds db service (from cds.connect.to('db'))
 * @param {string} namespace   - CDS namespace, e.g. "com.sap.developers.ims"
 * @param {string[]} tutorialIds - UUIDs (Tutorials.ID) of tutorials whose
 *                                 progress should be recomputed. Non-string
 *                                 elements and empty strings are filtered out.
 * @returns {Promise<{rechecked: number, updated: number|null}>}
 *   Note on `rechecked` semantics: HANA path returns `tutorialIds.length`
 *   (count of TUTORIALS the MERGE was scoped to). SQLite path returns the
 *   sum of per-tutorial `rechecked` from `recomputeTutorialProgress`, which
 *   counts ROWS examined. The two units differ but neither is load-bearing
 *   for callers — `updated` is the meaningful signal (HANA: null because
 *   MERGE doesn't return affectedRows; SQLite: rows actually mutated).
 *   Tests assert `updated` exact values on SQLite and rely on per-row state
 *   reads on HANA (see test/hybrid/recompute-tutorial-progress-bulk-sql.test.js).
 */
export async function recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds) {
  // Defensive guard: filter to actual non-empty strings before the DB call.
  // Callers pass tutorialIds harvested from publish metadata; a stray null
  // or non-string would break parameter binding and the fallback's quote
  // escape relies on string semantics.
  const cleaned = Array.isArray(tutorialIds)
    ? tutorialIds.filter(id => typeof id === 'string' && id.length > 0)
    : [];
  if (cleaned.length === 0) {
    return { rechecked: 0, updated: 0 };
  }

  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  if (!isHana) {
    // SQLite test path: loop the existing per-tutorial JS implementation.
    // Test fixtures are tiny so the JS overhead is negligible.
    const { Tutorials } = cds.entities(namespace);
    let totalRechecked = 0;
    let totalUpdated = 0;
    for (const tutorialId of cleaned) {
      const tutorial = await SELECT.one.from(Tutorials)
        .where({ ID: tutorialId })
        .columns('ID', 'stepCount');
      if (!tutorial?.stepCount) continue;
      const result = await recomputeTutorialProgress(db, namespace, tutorialId, tutorial.stepCount);
      totalRechecked += result.rechecked || 0;
      totalUpdated += result.updated || 0;
    }
    return { rechecked: totalRechecked, updated: totalUpdated };
  }

  // HANA fast path: single set-based MERGE. The same tutorialIds list is bound
  // twice (inner aggregate scope + outer MERGE scope).
  //
  // [#382 phase C finding] @cap-js/hana does NOT support array binding for
  // `IN (:tutorialIds)` parameter placeholders — every attempt errored with
  // "cannot use parameter variable: TUTORIALIDS". We interpolate a sanitized
  // comma-separated list of single-quoted UUIDs instead. UUIDs are alphanumeric
  // + '-' so not SQL-injection vectors, but the single-quote escape is
  // belt-and-suspenders for malformed input. The defensive filter at the top
  // of this function further guards against non-string elements.
  //
  // [#382 phase C finding] HANA MERGE does not return `affectedRows` to the
  // driver, so `updated` is `null` from this path. Per-row state changes are
  // verified by `WHEN MATCHED AND (NULL-safe-inequality)` in the SQL itself
  // and by the hybrid test's row-by-row assertions. Logging shows '(unknown)'.
  const start = Date.now();
  const idsLit = cleaned.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
  const sql = BULK_RECOMPUTE_MERGE_SQL.split(':tutorialIds').join(idsLit);
  const result = await db.run(sql);
  const durationMs = Date.now() - start;
  const updated = result?.affectedRows ?? null;
  LOG.info(`recomputeTutorialProgressBulkSQL: tutorialIds=${cleaned.length} updated=${updated ?? '(unknown)'} durationMs=${durationMs}`);
  return { rechecked: cleaned.length, updated };
}

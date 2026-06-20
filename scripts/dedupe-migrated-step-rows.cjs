/* eslint-disable no-console */
/**
 * One-shot repair: dedupe migrated 0-indexed Step rows from the Java IMS cutover.
 *
 * Background:
 *   ~98% of tutorials in the CAP DB carry duplicate Step rows. The Java IMS
 *   migration (`scripts/migrate-from-hana.js`) inserted Step rows with
 *   STATUS=NULL and 0-based stepOrder. After cutover, the CAP publish path
 *   (`srv/lib/content-publish-session.js`) re-creates the Step rows with
 *   STATUS='ACTIVE' and 1-based stepOrder, never touching the migrated rows.
 *   Both populations now coexist (~9000 + ~9000 rows).
 *
 *   `getProgress` (srv/developer-service.js) maps each user's STEP TaskRecord
 *   onto Step.stepOrder. Because the duplicates exist, completedSteps[] gets
 *   spurious 0-based indices that don't match the rendered DOM
 *   (`data-step="1..N"`). Result: per-step completion UI silently misses,
 *   even when the user's Tutorial-level row says COMPLETED 100%.
 *
 *   Concrete case: tutorial `abap-create-project` has 6 Step rows for a
 *   declared stepCount=5 — one extra migrated row at stepOrder=0.
 *
 * Strategy:
 *   For each tutorial:
 *     1. Pair migrated (NULL status, stepOrder=N) with native (ACTIVE,
 *        stepOrder=N+1) via title match (exact, or "Step N: <title>" prefix).
 *     2. For each pair, redirect TaskRecord.taskLegacyId from migrated → native.
 *        Per memory feedback_composite_pk_collision_on_fk_redirect: when a
 *        user already has a TaskRecord on the native legacyId, DELETE the
 *        duplicate migrated TaskRecord rather than UPDATE-colliding.
 *     3. DELETE the migrated Step row.
 *     4. Sweep orphan migrated rows (stepOrder >= stepCount, STATUS=NULL,
 *        no title match) — DELETE TaskRecords pointing at them, then DELETE.
 *
 * Modes:
 *   --dry-run     (default) — print plan, no writes
 *   --commit               — execute, transaction-per-tutorial
 *   --slug <slug>          — only one tutorial
 *   --limit <N>            — at most N tutorials (staged rollout)
 *   --verbose              — log every redirect/delete
 *
 * Run via:  npx cds bind --exec -- node scripts/dedupe-migrated-step-rows.cjs [...]
 */

const cds = require('@sap/cds');
const { pairMigratedSteps, planTaskRecordOps } = require('./lib/pair-migrated-steps.cjs');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const DRY_RUN = argv.includes('--dry-run') || !COMMIT;
const VERBOSE = argv.includes('--verbose');

function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1];
}
const SLUG = flagValue('--slug');
const LIMIT_RAW = flagValue('--limit');
const LIMIT = LIMIT_RAW ? Number(LIMIT_RAW) : null;
if (LIMIT !== null && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
  console.error(`--limit must be a positive integer (got: ${LIMIT_RAW})`);
  process.exit(1);
}

const TUTORIALS = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
const STEPS = '"COM_SAP_DEVELOPERS_IMS_STEPS"';
const TASK_RECORDS = '"COM_SAP_DEVELOPERS_IMS_TASKRECORDS"';

async function main() {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }

  const mode = COMMIT ? 'COMMIT' : 'DRY-RUN';
  console.log(`Mode: ${mode}`);
  if (SLUG) console.log(`Filter: --slug ${SLUG}`);
  if (LIMIT) console.log(`Filter: --limit ${LIMIT}`);

  // 1. Pull tutorials list.
  const tutorialsSql = SLUG
    ? `SELECT "ID", "SLUG", "STEPCOUNT" FROM ${TUTORIALS} WHERE LOWER("SLUG") = ?`
    : `SELECT "ID", "SLUG", "STEPCOUNT" FROM ${TUTORIALS} WHERE "SLUG" IS NOT NULL ORDER BY "SLUG"`;
  const tutorials = SLUG
    ? await db.run(tutorialsSql, [SLUG.toLowerCase()])
    : await db.run(tutorialsSql);

  if (tutorials.length === 0) {
    console.log('No tutorials matched filter.');
    process.exit(0);
  }
  // One-shot key-casing sanity check (memory: feedback_hana_raw_sql_uppercase).
  const keys = Object.keys(tutorials[0]);
  if (!keys.includes('ID') || !keys.includes('SLUG')) {
    throw new Error(
      `Row keys are not uppercase as expected. Got: ${keys.join(', ')}\n` +
      `Are you connected to HANA? Run with: cds bind --exec -- node ...`
    );
  }

  const subset = LIMIT ? tutorials.slice(0, LIMIT) : tutorials;

  const summary = {
    mode,
    tutorialsScanned: subset.length,
    tutorialsTouched: 0,
    tutorialsClean: 0,
    tutorialsFailed: 0,
    pairsFound: 0,
    orphansFound: 0,
    taskRecordRedirects: 0,
    taskRecordCollisionDeletes: 0,
    taskRecordOrphanDeletes: 0,
    stepsDeleted: 0,
  };

  for (const tut of subset) {
    try {
      const result = await processOne(db, tut);
      if (result.touched) summary.tutorialsTouched++;
      else summary.tutorialsClean++;
      summary.pairsFound += result.pairs;
      summary.orphansFound += result.orphans;
      summary.taskRecordRedirects += result.redirects;
      summary.taskRecordCollisionDeletes += result.collisions;
      summary.taskRecordOrphanDeletes += result.orphanDeletes;
      summary.stepsDeleted += result.stepsDeleted;
    } catch (e) {
      summary.tutorialsFailed++;
      console.error(`  ERROR on slug=${tut.SLUG}: ${e.message}`);
      if (VERBOSE) console.error(e.stack);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (DRY_RUN) console.log('\nDry-run complete. Re-run with --commit to apply.');
}

async function processOne(db, tut) {
  const stats = {
    touched: false,
    pairs: 0,
    orphans: 0,
    redirects: 0,
    collisions: 0,
    orphanDeletes: 0,
    stepsDeleted: 0,
  };

  const stepRows = await db.run(
    `SELECT "ID", "LEGACYID", "STEPORDER", "STATUS", "TITLE"
       FROM ${STEPS} WHERE "TUTORIAL_ID" = ? ORDER BY "STEPORDER"`,
    [tut.ID]
  );
  if (stepRows.length === 0) return stats;

  const { pairs, orphans } = pairMigratedSteps(stepRows, tut.STEPCOUNT);
  if (pairs.length === 0 && orphans.length === 0) return stats;

  stats.touched = true;
  stats.pairs = pairs.length;
  stats.orphans = orphans.length;

  if (VERBOSE || DRY_RUN) {
    console.log(`\nslug=${tut.SLUG} stepCount=${tut.STEPCOUNT} pairs=${pairs.length} orphans=${orphans.length}`);
  }

  // Plan the TaskRecord ops for each pair (redirect vs collision-delete).
  // We do this in dry-run too, so the printed plan reflects the real shape.
  const pairPlans = [];
  for (const p of pairs) {
    const trRows = await db.run(
      `SELECT "ID", "USER_ID", "TASKLEGACYID" FROM ${TASK_RECORDS}
        WHERE "TASKLEGACYID" IN (?, ?) AND "TASKTYPE" = 'STEP'`,
      [p.migrated.LEGACYID, p.native.LEGACYID]
    );
    const ops = planTaskRecordOps(trRows, p.migrated.LEGACYID, p.native.LEGACYID);
    const redirects = ops.filter(o => o.op === 'redirect').length;
    const collisions = ops.filter(o => o.op === 'collision-delete').length;
    stats.redirects += redirects;
    stats.collisions += collisions;
    pairPlans.push({ pair: p, ops, redirects, collisions });
    if (VERBOSE) {
      console.log(
        `  pair migrated=${p.migrated.LEGACYID} (stepOrder=${p.migrated.STEPORDER}) → ` +
        `native=${p.native.LEGACYID} (stepOrder=${p.native.STEPORDER}): ` +
        `redirects=${redirects} collisions=${collisions}`
      );
    }
  }

  // Plan orphan TaskRecord deletes.
  const orphanPlans = [];
  for (const o of orphans) {
    const trRows = await db.run(
      `SELECT "ID" FROM ${TASK_RECORDS}
        WHERE "TASKLEGACYID" = ? AND "TASKTYPE" = 'STEP'`,
      [o.LEGACYID]
    );
    stats.orphanDeletes += trRows.length;
    orphanPlans.push({ step: o, taskRecordIds: trRows.map(r => r.ID) });
    if (VERBOSE) {
      console.log(
        `  orphan migrated=${o.LEGACYID} (stepOrder=${o.STEPORDER} title=${JSON.stringify(o.TITLE)}): ` +
        `deletes ${trRows.length} TaskRecord(s)`
      );
    }
  }

  if (DRY_RUN) return stats;

  // Apply within a per-tutorial transaction. Failure rolls back THIS tutorial
  // only; the outer loop continues to the next.
  await db.tx(async tx => {
    for (const plan of pairPlans) {
      const { pair, ops } = plan;
      // Apply TaskRecord ops first.
      for (const op of ops) {
        if (op.op === 'redirect') {
          await tx.run(
            `UPDATE ${TASK_RECORDS} SET "TASKLEGACYID" = ? WHERE "ID" = ?`,
            [pair.native.LEGACYID, op.recordId]
          );
        } else {
          await tx.run(
            `DELETE FROM ${TASK_RECORDS} WHERE "ID" = ?`,
            [op.recordId]
          );
        }
      }
      // Now delete the migrated Step row.
      await tx.run(`DELETE FROM ${STEPS} WHERE "ID" = ?`, [pair.migrated.ID]);
      stats.stepsDeleted++;
    }
    for (const plan of orphanPlans) {
      for (const trId of plan.taskRecordIds) {
        await tx.run(`DELETE FROM ${TASK_RECORDS} WHERE "ID" = ?`, [trId]);
      }
      await tx.run(`DELETE FROM ${STEPS} WHERE "ID" = ?`, [plan.step.ID]);
      stats.stepsDeleted++;
    }
  });

  return stats;
}

main().catch(e => { console.error(e); process.exit(1); });

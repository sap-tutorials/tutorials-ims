// One-shot cleanup: delete orphan Step rows (tutorial_ID IS NULL) that
// block the @assert.unique.tutorialStep HDI constraint.
//
// Background:
//   scripts/migrate-from-hana.js (pre-2026-06-21) inserted Step rows with
//   TUTORIAL_ID=NULL when the source IMS_TASK_TO_TASK had no parent link
//   for a Step task. The schema column was nullable; the migrator just
//   passed null through. HANA's @assert.unique.tutorialStep treats
//   NULL=NULL for constraint purposes, so 2+ such orphans violate.
//
//   The migrator change in this same PR makes future migrations skip
//   orphan inserts. The schema change makes Steps.tutorial NOT NULL so
//   the case becomes impossible at the DB level. This script cleans up
//   the existing 5 rows in DEV's HANA so the unique-constraint HDI deploy
//   succeeds. After this runs once, it should be a permanent no-op.
//
// Run: npx cds bind --exec -- node scripts/cleanup-orphan-steps.cjs --dry-run
// Or:  npx cds bind --exec -- node scripts/cleanup-orphan-steps.cjs --commit
//
// Idempotent: if no orphans exist, exit 0 with a "nothing to do" message.

const cds = require('@sap/cds');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const DRY_RUN = !COMMIT;

const STEPS = '"COM_SAP_DEVELOPERS_IMS_STEPS"';
const TASK_RECORDS = '"COM_SAP_DEVELOPERS_IMS_TASKRECORDS"';

(async () => {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }

  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}`);

  // Find orphan Step rows. STEPORDER doesn't actually matter — the join
  // by TUTORIAL_ID IS NULL is what matters; we just inspect all attributes
  // for the audit log.
  const orphans = await db.run(`
    SELECT "ID", "LEGACYID", "STEPORDER", "STATUS", "TITLE", "CREATEDAT"
      FROM ${STEPS}
     WHERE "TUTORIAL_ID" IS NULL
     ORDER BY "CREATEDAT"
  `);

  if (orphans.length === 0) {
    console.log('No orphan Step rows found. Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${orphans.length} orphan Step row(s):`);
  console.table(orphans);

  // Look up dependent TaskRecord rows. Step legacyIds can be referenced by
  // TaskRecords (TASKLEGACYID matching, TASKTYPE='STEP'). User progress
  // against orphan Steps is meaningless (no rendering target) — delete the
  // TaskRecord rows alongside the Steps.
  const legacyIds = orphans.map(o => o.LEGACYID).filter(Boolean);
  let trDependents = [];
  if (legacyIds.length > 0) {
    const placeholders = legacyIds.map(() => '?').join(',');
    trDependents = await db.run(
      `SELECT "ID", "USER_ID", "TASKLEGACYID"
         FROM ${TASK_RECORDS}
        WHERE "TASKTYPE" = 'STEP'
          AND "TASKLEGACYID" IN (${placeholders})`,
      legacyIds
    );
  }
  console.log(`Dependent TaskRecord rows: ${trDependents.length}`);
  if (trDependents.length > 0) console.table(trDependents);

  if (DRY_RUN) {
    console.log('\nDry-run complete. Re-run with --commit to delete.');
    process.exit(0);
  }

  // Apply within one transaction — atomic. Either all orphans + their
  // dependents are gone, or nothing changes.
  await db.tx(async tx => {
    if (trDependents.length > 0) {
      const placeholders = legacyIds.map(() => '?').join(',');
      await tx.run(
        `DELETE FROM ${TASK_RECORDS}
          WHERE "TASKTYPE" = 'STEP'
            AND "TASKLEGACYID" IN (${placeholders})`,
        legacyIds
      );
    }
    await tx.run(`DELETE FROM ${STEPS} WHERE "TUTORIAL_ID" IS NULL`);
  });

  console.log(`\nDeleted ${orphans.length} orphan Step row(s) and ${trDependents.length} dependent TaskRecord(s).`);
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});

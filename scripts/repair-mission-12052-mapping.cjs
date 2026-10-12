/* eslint-disable no-console */
/**
 * One-shot repair for issue #2719 — Mission 12052 ("Use Machine Learning to
 * Process Business Documents") stuck at 1/2 because its first completion-path
 * slot points at a retired tutorial with NO in-mission successor.
 *
 * Verified on PROD (not taken from the issue — the issue's proposed replacement
 * `cp-aibus-dox-ui-sub` is WRONG: that tutorial is in zero paths and has 5
 * completers; it is not this mission's tutorial):
 *   Mission 12052 slots:
 *     itemOrder 0 → taskLegacyId 13488 = cp-aibus-dox-booster-app (INACTIVE/404),
 *                   3834 completers, present in 3 missions, no redirect, no
 *                   single de-facto successor in the completion data.
 *     itemOrder 1 → taskLegacyId 13297 = cp-aibus-dox-ui (ACTIVE), 575 completers.
 *   The live /build/navigator lists exactly [booster-app, ui]. booster-app was a
 *   retired "booster" (account/app provisioning) step with no replacement, so the
 *   mission collapses to a single tutorial: cp-aibus-dox-ui.
 *
 * Fix (maintainer decision — remove the dead slot + grandfather existing users):
 *   A. REMOVE slot 0 (the booster-app CompletionPathItems row). Mission 12052
 *      then requires only cp-aibus-dox-ui (13297).
 *   B. Grandfather: 1380 users are currently MISSION-COMPLETED but lack a ui
 *      (13297) record. The CAP rollup DOWNGRADES on recompute (unlike legacy),
 *      so leaving them untouched would demote them on their next completion
 *      event. Insert a COMPLETED ui record (completionDate copied from their
 *      existing MISSION record) so the ui-only mission stays genuinely satisfied.
 *   C. Re-run the rollup (send:false) for the grandfather set AND the 91
 *      IN_PROGRESS-with-ui users (the real bug victims) → all land COMPLETED.
 *
 * NOTE: booster-app (13488) is in 2 OTHER missions too; this script fixes ONLY
 * 12052. The others are tracked separately and the real cure is the completion
 * cascade/self-heal rework (see docs follow-up). Snapshot-first; dry-run default.
 *
 * Run via:  npx cds bind --exec -- node scripts/repair-mission-12052-mapping.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

const MISSION_LEGACY_ID = 12052;
const DEAD_SLOT_ITEM_ID = '72e17a52-29f0-5ac0-83fa-cca494ee4be6'; // itemOrder 0, booster-app
const DEAD_TUT_LEGACY = 13488;    // cp-aibus-dox-booster-app (INACTIVE)
const KEEP_TUT_LEGACY = 13297;    // cp-aibus-dox-ui (ACTIVE) — the surviving slot
const KEEP_TUT_UUID = '7f75bc5b-23aa-52f7-85c7-41ed5a4b5561';

const ITEMS_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
const TR_TBL = '"COM_SAP_DEVELOPERS_IMS_TASKRECORDS"';

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR,
  `mission-12052-repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
let snapshotInited = false;
function appendSnapshot(record) {
  if (!snapshotInited) { fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); snapshotInited = true; }
  fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(record) + '\n');
}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const VERIFY_ONLY = argv.includes('--verify-only');
const DRY_RUN = argv.includes('--dry-run');
if (COMMIT && VERIFY_ONLY) { console.error('--commit and --verify-only are mutually exclusive'); process.exit(1); }
if (COMMIT && DRY_RUN) { console.error('--commit and --dry-run are mutually exclusive'); process.exit(1); }

async function main() {
  const { getNextLegacyId } = await import('../srv/lib/legacy-id.js');
  const { stampSubmissionId } = await import('../srv/lib/task-record-submission-id.js');
  const { rollUpParentsForCompletion } = await import('../srv/lib/completion-rollup.js');

  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name?.includes('Hana');
  if (!isHana) { console.error('FATAL: run on HANA via `cds bind --exec`.'); process.exit(1); }
  if (COMMIT) console.log(`Snapshot: ${SNAPSHOT_PATH}\n`);

  const C = `"STATUS"='COMPLETED'`;

  const [slot] = await db.run(`SELECT "ID","TASKLEGACYID" FROM ${ITEMS_TBL} WHERE "ID" = ?`, [DEAD_SLOT_ITEM_ID]);
  const slotPresent = !!slot && slot.TASKLEGACYID === DEAD_TUT_LEGACY;
  console.log(`── Dead slot ──  ${slotPresent ? 'present (booster-app, will remove)' : 'already removed'}`);

  // Grandfather set: MISSION-COMPLETED users lacking a ui(13297) COMPLETED record.
  const grandfather = await db.run(
    `SELECT m."USER_ID" AS "USER_ID", m."COMPLETIONDATE" AS "COMPLETIONDATE"
       FROM ${TR_TBL} m
      WHERE m."TASKLEGACYID" = ${MISSION_LEGACY_ID} AND m."TASKTYPE" = 'MISSION' AND m.${C}
        AND m."USER_ID" NOT IN (SELECT "USER_ID" FROM ${TR_TBL} WHERE "TASKLEGACYID" = ${KEEP_TUT_LEGACY} AND ${C})
        AND m."USER_ID" NOT IN (SELECT "USER_ID" FROM ${TR_TBL} WHERE "TASKLEGACYID" = ${KEEP_TUT_LEGACY} AND ${C} AND "PROGRESSNOTE" LIKE 'migration:#2719%')`
  );
  // Bug victims: IN_PROGRESS mission users who already have ui → flip to COMPLETED on re-rollup.
  const victims = await db.run(
    `SELECT DISTINCT u."USER_ID" AS "USER_ID" FROM (
        SELECT "USER_ID" FROM ${TR_TBL} WHERE "TASKLEGACYID" = ${MISSION_LEGACY_ID} AND "TASKTYPE" = 'MISSION' AND "STATUS" = 'IN_PROGRESS'
        INTERSECT SELECT "USER_ID" FROM ${TR_TBL} WHERE "TASKLEGACYID" = ${KEEP_TUT_LEGACY} AND ${C}) u`
  );
  console.log(`── Grandfather set (MISSION-COMPLETED lacking ui): ${grandfather.length}`);
  console.log(`── Bug victims (IN_PROGRESS with ui, will flip COMPLETED): ${victims.length}`);

  const [uiTut] = await db.run(`SELECT "TITLE" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "LEGACYID" = ${KEEP_TUT_LEGACY}`);
  const uiTitle = uiTut?.TITLE || 'cp-aibus-dox-ui';

  if (VERIFY_ONLY) {
    const clean = !slotPresent && grandfather.length === 0;
    console.log(`\nVERIFY: ${clean ? 'CLEAN' : 'WORK REMAINS'}`);
    process.exit(clean ? 0 : 2);
  }
  if (!COMMIT) {
    console.log('\n── DRY RUN ── plan:');
    console.log(`  A. DELETE dead slot ${DEAD_SLOT_ITEM_ID}` + (slotPresent ? '' : ' [SKIP: gone]'));
    console.log(`  B. INSERT ${grandfather.length} COMPLETED ui(${KEEP_TUT_LEGACY}) records (grandfather)`);
    console.log(`  C. Re-run rollup (send:false) for ${grandfather.length + victims.length} users`);
    console.log('\nRe-run with --commit to apply.');
    process.exit(0);
  }

  // A. Remove the dead slot.
  if (slotPresent) {
    appendSnapshot({ kind: 'slot-delete', table: 'CompletionPathItems', row: slot });
    await db.run(`DELETE FROM ${ITEMS_TBL} WHERE "ID" = ?`, [DEAD_SLOT_ITEM_ID]);
    console.log(`A. Removed dead slot ${DEAD_SLOT_ITEM_ID}`);
  } else { console.log('A. Dead slot already gone — skipped.'); }

  // B. Grandfather inserts (idempotent — query already excludes migration-tagged).
  let inserted = 0;
  for (const u of grandfather) {
    const legacyId = await getNextLegacyId('TaskRecords', db);
    const entry = stampSubmissionId({
      user_ID: u.USER_ID, taskLegacyId: KEEP_TUT_LEGACY, taskType: 'TUTORIAL',
      status: 'COMPLETED', progress: 100, completionDate: u.COMPLETIONDATE,
      titleSnapshot: uiTitle,
      progressNote: 'migration:#2719 grandfather credit for cp-aibus-dox-ui after removing retired cp-aibus-dox-booster-app slot from mission 12052',
      legacyId, attemptNumber: 1,
    }, null);
    appendSnapshot({ kind: 'taskrecord-insert', table: 'TaskRecords', legacyId, user_ID: u.USER_ID, taskLegacyId: KEEP_TUT_LEGACY });
    await db.run(INSERT.into('com.sap.developers.ims.TaskRecords').entries(entry));
    inserted++;
  }
  console.log(`B. Inserted ${inserted} grandfather ui records.`);

  // C. Re-run rollup for grandfather + victims (send:false — historical/corrective, no NGDS).
  const allUsers = [...new Set([...grandfather.map(u => u.USER_ID), ...victims.map(u => u.USER_ID)])];
  let rolled = 0;
  for (const uid of allUsers) {
    await rollUpParentsForCompletion({
      dbUser: { ID: uid },
      task: { taskType: 'TUTORIAL', taskLegacyId: KEEP_TUT_LEGACY, tutorialId: KEEP_TUT_UUID },
      db, send: false,
    });
    rolled++;
  }
  console.log(`C. Re-ran rollup for ${rolled} users (send:false).`);
  console.log(`\nDONE. Snapshot: ${SNAPSHOT_PATH}`);
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });

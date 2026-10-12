/* eslint-disable no-console */
/**
 * One-shot repair for issue #2718 — Mission 12479 ("Use Machine Learning to
 * Extract Information from Business Documents and Enrich Data") cannot be
 * completed because its first completion-path slot points at a dead tutorial.
 *
 * Root cause (verified on PROD):
 *   CompletionPathItems row 3c263b79-824e-5de2-ac89-bb92e4b40408 (path 114,
 *   itemOrder 0) has TASKLEGACYID = 13474 = tutorial `cp-aibus-dox-booster-key`,
 *   which is INACTIVE (404). Its live replacement is `cp-aibus-dox-service-instance`
 *   = legacyId 11954 (UUID 05c0e762-098b-593a-aae7-2d4e848b6acc — already the
 *   row's TUTORIAL_ID FK, so only TASKLEGACYID drifted). The completion rollup
 *   and NavigatorCatalog view both key off taskLegacyId, so the mission requires
 *   a tutorial that no longer exists → users who do the replacement get 4/5.
 *
 * Fix (two coordinated changes, chosen with the maintainer):
 *   A. Repoint the slot: UPDATE the item's TASKLEGACYID 13474 -> 11954. This
 *      makes the slot require the live tutorial; the navigator feed then resolves
 *      11954 -> cp-aibus-dox-service-instance cleanly (no dead/404 step).
 *   B. Preserve existing users: 761 users COMPLETED the OLD tutorial (13474) but
 *      NOT the new one (11954). After change A their slot token flips to 11954,
 *      which they lack → they would be stranded. So we INSERT a COMPLETED
 *      TaskRecord on 11954 for each, copying completionDate from their 13474 row.
 *   C. Re-run the real completion rollup for those 761 users (send:false, so no
 *      historical NGDS auto-send fires) to recompute MISSION 12479 status.
 *
 * Safety (verified read-only before writing this script, all on PROD):
 *   - 761 OLD-not-NEW users; 0 already hold an 11954 record (pure INSERT);
 *     0 have NULL completionDate on 13474; 0 have duplicate COMPLETED 13474 rows.
 *   - Of the 761: 310 have the other 4 tutorials done -> mission completes on
 *     re-rollup; 344 already show MISSION COMPLETED (stays, now justified by
 *     11954 not the dead token); the rest correctly stay IN_PROGRESS.
 *
 * Modes:
 *   --dry-run      (default) — print the plan + counts, no writes
 *   --commit                 — execute, snapshot every mutated/created row first
 *   --verify-only            — exit 0 if already fixed, 2 if work remains
 *
 * Run via:  npx cds bind --exec -- node scripts/repair-mission-12479-mapping.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

// --- Constants (verified against PROD) -------------------------------------
const MISSION_LEGACY_ID = 12479;
const OLD_TUT_LEGACY = 13474; // cp-aibus-dox-booster-key (INACTIVE)
const NEW_TUT_LEGACY = 11954; // cp-aibus-dox-service-instance (ACTIVE)
const SLOT_ITEM_ID = '3c263b79-824e-5de2-ac89-bb92e4b40408'; // CompletionPathItems row, itemOrder 0
const OTHER_SLOT_LEGACY = [12194, 11946, 12470, 12461]; // the mission's other 4 tutorial slots

const ITEMS_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
const TR_TBL = '"COM_SAP_DEVELOPERS_IMS_TASKRECORDS"';

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(
  SNAPSHOT_DIR,
  `mission-12479-repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
);
let snapshotInited = false;
function appendSnapshot(record) {
  if (!snapshotInited) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    snapshotInited = true;
  }
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
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }
  if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);

  // ── Inspect current slot state ─────────────────────────────────────────
  const [slot] = await db.run(
    `SELECT "ID","TASKLEGACYID","TUTORIAL_ID","ITEMORDER" FROM ${ITEMS_TBL} WHERE "ID" = ?`, [SLOT_ITEM_ID]
  );
  if (!slot) { console.error(`FATAL: slot row ${SLOT_ITEM_ID} not found`); process.exit(1); }
  const slotNeedsRepoint = slot.TASKLEGACYID === OLD_TUT_LEGACY;
  console.log('── Slot (CompletionPathItems itemOrder 0) ──');
  console.log(`  current TASKLEGACYID = ${slot.TASKLEGACYID} ${slotNeedsRepoint ? '(= OLD, needs repoint)' : '(already repointed)'}`);
  console.log(`  TUTORIAL_ID = ${slot.TUTORIAL_ID}\n`);

  // ── Compute the 761 (OLD completed, NEW not completed) ──────────────────
  const C = `"STATUS"='COMPLETED'`;
  const toCredit = await db.run(
    `SELECT o."USER_ID" AS "USER_ID", MAX(o."COMPLETIONDATE") AS "COMPLETIONDATE",
            MAX(o."CONTENTLANGUAGE") AS "CONTENTLANGUAGE", MAX(o."SITELANGUAGE") AS "SITELANGUAGE",
            MAX(o."TITLESNAPSHOT") AS "TITLESNAPSHOT"
       FROM ${TR_TBL} o
      WHERE o."TASKLEGACYID" = ${OLD_TUT_LEGACY} AND o.${C}
        AND o."USER_ID" NOT IN (SELECT "USER_ID" FROM ${TR_TBL} WHERE "TASKLEGACYID" = ${NEW_TUT_LEGACY} AND ${C})
      GROUP BY o."USER_ID"`
  );
  console.log('── Backfill set ──');
  console.log(`  users completed OLD(${OLD_TUT_LEGACY}) but not NEW(${NEW_TUT_LEGACY}): ${toCredit.length}`);

  // Resolve the NEW tutorial's title for a sensible titleSnapshot.
  const [newTut] = await db.run(
    `SELECT "ID","TITLE" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "LEGACYID" = ${NEW_TUT_LEGACY}`
  );
  const newTitle = newTut?.TITLE || 'Use Trial to Create a Service Instance for SAP Document AI';

  if (VERIFY_ONLY) {
    const clean = !slotNeedsRepoint && toCredit.length === 0;
    console.log(`\nVERIFY: ${clean ? 'CLEAN — nothing to do' : 'WORK REMAINS'}`);
    process.exit(clean ? 0 : 2);
  }

  if (!COMMIT) {
    console.log('\n── DRY RUN (no writes) ── plan:');
    console.log(`  A. UPDATE slot ${SLOT_ITEM_ID}: TASKLEGACYID ${OLD_TUT_LEGACY} -> ${NEW_TUT_LEGACY}` +
      (slotNeedsRepoint ? '' : ' [SKIP: already done]'));
    console.log(`  B. INSERT ${toCredit.length} COMPLETED TaskRecords on taskLegacyId=${NEW_TUT_LEGACY} (copying each user's OLD completionDate)`);
    console.log(`  C. Re-run rollUpParentsForCompletion (send:false) for ${toCredit.length} users to recompute MISSION ${MISSION_LEGACY_ID}`);
    console.log('\nRe-run with --commit to apply.');
    process.exit(0);
  }

  // ── COMMIT ──────────────────────────────────────────────────────────────
  // A. Repoint the slot.
  if (slotNeedsRepoint) {
    appendSnapshot({ kind: 'slot-before', table: 'CompletionPathItems', row: slot });
    await db.run(`UPDATE ${ITEMS_TBL} SET "TASKLEGACYID" = ? WHERE "ID" = ?`, [NEW_TUT_LEGACY, SLOT_ITEM_ID]);
    console.log(`A. Repointed slot ${SLOT_ITEM_ID} -> TASKLEGACYID ${NEW_TUT_LEGACY}`);
  } else {
    console.log('A. Slot already repointed — skipped.');
  }

  // B. Insert the backfill records.
  let inserted = 0;
  for (const u of toCredit) {
    const legacyId = await getNextLegacyId('TaskRecords', db);
    const entry = stampSubmissionId({
      user_ID: u.USER_ID,
      taskLegacyId: NEW_TUT_LEGACY,
      taskType: 'TUTORIAL',
      status: 'COMPLETED',
      progress: 100,
      completionDate: u.COMPLETIONDATE,
      completionTime: u.COMPLETIONDATE,
      contentLanguage: u.CONTENTLANGUAGE || null,
      siteLanguage: u.SITELANGUAGE || null,
      titleSnapshot: newTitle,
      progressNote: 'migration:#2718 credit for cp-aibus-dox-booster-key (13474) completion after slot repoint to cp-aibus-dox-service-instance (11954)',
      legacyId,
      attemptNumber: 1,
    }, null);
    appendSnapshot({ kind: 'taskrecord-insert', table: 'TaskRecords', legacyId, user_ID: u.USER_ID, taskLegacyId: NEW_TUT_LEGACY });
    await db.run(INSERT.into('com.sap.developers.ims.TaskRecords').entries(entry));
    inserted++;
  }
  console.log(`B. Inserted ${inserted} COMPLETED TaskRecords on taskLegacyId=${NEW_TUT_LEGACY}`);

  // C. Re-run the real rollup per user (send:false — historical, no NGDS).
  let rolled = 0;
  for (const u of toCredit) {
    await rollUpParentsForCompletion({
      dbUser: { ID: u.USER_ID },
      task: { taskType: 'TUTORIAL', taskLegacyId: NEW_TUT_LEGACY, tutorialId: slot.TUTORIAL_ID },
      db,
      send: false,
    });
    rolled++;
  }
  console.log(`C. Re-ran rollup for ${rolled} users (send:false).`);

  console.log(`\nDONE. Snapshot: ${SNAPSHOT_PATH}`);
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });

/* eslint-disable no-console */
/**
 * One-shot repair: dedupe TutorialMeta rows so each tutorial has at most one.
 *
 * Background: PR #386's slug-merge redirected loser TutorialMeta rows onto the
 * winner tutorial via simple FK UPDATE (TutorialMeta is cuid, so no PK
 * collision). But TutorialMeta is logically a singleton — a tutorial should
 * have ONE review-state record, not two. After the slug merge, 123 tutorials
 * have 2 TutorialMeta rows each. This script picks the canonical row using
 * pickCanonicalMeta() and DELETEs the rest.
 *
 * The chosen row is then guaranteed to be the one returned by future
 * SELECT.one queries (after Task 4 adds @assert.unique.tutorial).
 *
 * Modes:
 *   --dry-run     (default) — print plan, no writes
 *   --commit               — execute, snapshot first
 *   --verify-only          — count remaining duplicate groups, exit 0/2
 *
 * Run via:  npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');
const { pickCanonicalMeta } = require('./lib/pick-canonical-meta.cjs');

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(
  SNAPSHOT_DIR,
  `tutorialmeta-dedupe-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
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
if (COMMIT && VERIFY_ONLY) {
  console.error('--commit and --verify-only are mutually exclusive');
  process.exit(1);
}
if (COMMIT && DRY_RUN) {
  console.error('--commit and --dry-run are mutually exclusive');
  process.exit(1);
}

const TBL = '"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"';

async function main() {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }
  if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);

  const dupGroups = await db.run(`
    SELECT "TUTORIAL_ID", COUNT(*) AS C
      FROM ${TBL}
     WHERE "TUTORIAL_ID" IS NOT NULL
     GROUP BY "TUTORIAL_ID"
    HAVING COUNT(*) > 1
     ORDER BY "TUTORIAL_ID"
  `);

  if (VERIFY_ONLY) {
    console.log(`tutorials with > 1 TutorialMeta row: ${dupGroups.length}`);
    process.exit(dupGroups.length === 0 ? 0 : 2);
  }

  console.log(`\n--- TutorialMeta duplicates: ${dupGroups.length} tutorial(s) ---`);
  let deleted = 0;
  let casingChecked = false;

  for (const g of dupGroups) {
    const rows = await db.run(`SELECT * FROM ${TBL} WHERE "TUTORIAL_ID" = ?`, [g.TUTORIAL_ID]);

    if (!casingChecked && rows.length > 0) {
      casingChecked = true;
      const keys = Object.keys(rows[0]);
      if (!keys.includes('ID') || !keys.includes('TUTORIAL_ID')) {
        throw new Error(
          `Row keys are not uppercase as expected. Got: ${keys.join(', ')}\n` +
          `Are you connected to HANA? Run with: cds bind --exec -- node ...`
        );
      }
    }

    const { winner, losers } = pickCanonicalMeta(rows);
    console.log(
      `  tutorial=${g.TUTORIAL_ID.slice(0,8)}: keep=${winner.ID.slice(0,8)} ` +
      `(owner=${winner.OWNER ?? 'null'}, notif=${winner.NOTIFICATIONNUMBER ?? 0})  ` +
      `delete=[${losers.map(l => l.ID.slice(0,8)).join(',')}]`
    );

    if (!COMMIT) continue;

    await db.tx(async tx => {
      // Snapshot every loser row before delete.
      for (const loser of losers) {
        appendSnapshot({ kind: 'row', table: TBL, data: loser });
      }
      // Delete losers.
      for (const loser of losers) {
        await tx.run(`DELETE FROM ${TBL} WHERE "ID" = ?`, [loser.ID]);
        deleted++;
      }
    });
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ tutorialsAffected: dupGroups.length, rowsDeleted: deleted }, null, 2));
  if (!COMMIT) console.log('\nDry-run complete. Re-run with --commit to apply.');
}

main().catch(e => { console.error(e); process.exit(1); });

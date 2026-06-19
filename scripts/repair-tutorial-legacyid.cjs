/* eslint-disable no-console */
/**
 * One-shot repair: backfill Tutorials.legacyId for rows where it is NULL and
 * propagate the new legacyId to dependent CompletionPathItems rows (linked
 * via the tutorial : Association to Tutorials FK on CompletionPathItems).
 *
 * Background: upsertTutorialMetadata historically inserted Tutorials rows
 * without assigning legacyId. The forward fix in PR #?? closes the leak;
 * this script heals existing NULL rows.
 *
 * Out of scope: TaskRecords. The schema has no FK from TaskRecords to
 * Tutorials and no taskSlug column, so orphan TaskRecords (where
 * taskLegacyId was written NULL during the bug window) cannot be matched
 * back to a tutorial. Documented as accepted data-loss boundary in the
 * spec at docs/superpowers/specs/2026-06-19-tutorial-legacyid-publish-design.md.
 *
 * Modes:
 *   --dry-run     (default) — print plan, no writes
 *   --commit               — execute, snapshot first
 *   --verify-only          — count remaining NULL rows, exit 0/2
 *
 * Run via:  npx cds bind --exec -- node scripts/repair-tutorial-legacyid.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(
  SNAPSHOT_DIR,
  `tutorial-legacyid-repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
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

const TUT_TBL = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
const CPI_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
const TUT_SEQ = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS_SEQ"';

async function main() {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }
  if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);

  // Find every Tutorials row where legacyId IS NULL.
  const nullRows = await db.run(`
    SELECT "ID", "SLUG", "TITLE"
      FROM ${TUT_TBL}
     WHERE "LEGACYID" IS NULL
     ORDER BY "SLUG"
  `);

  if (VERIFY_ONLY) {
    console.log(`Tutorials rows with NULL legacyId: ${nullRows.length}`);
    process.exit(nullRows.length === 0 ? 0 : 2);
  }

  console.log(`\n--- Tutorials with NULL legacyId: ${nullRows.length} row(s) ---`);

  let tutorialsRepaired = 0;
  let cpiRepaired = 0;
  let tutorialsFailed = 0;

  for (const row of nullRows) {
    const slug = row.SLUG;
    const tutorialId = row.ID;

    // Look up dependent CompletionPathItems via the tutorial FK (NOT slug match —
    // the schema has no taskSlug column on CPI).
    const cpiRows = await db.run(`
      SELECT "ID", "TASKLEGACYID", "TASKTYPE"
        FROM ${CPI_TBL}
       WHERE "TUTORIAL_ID" = ?
         AND "TASKLEGACYID" IS NULL
         AND "TASKTYPE" = 'TUTORIAL'
    `, [tutorialId]);

    console.log(
      `  ${slug.padEnd(50)}  tutorialID=${tutorialId.slice(0,8)}  ` +
      `cpi_to_repair=${cpiRows.length}`
    );

    if (!COMMIT) continue;

    try {
      await db.tx(async tx => {
        // Acquire a row-level lock and re-check NULL — defends against a concurrent
        // publish that may have already filled in the legacyId.
        const recheck = await tx.run(`
          SELECT "LEGACYID" FROM ${TUT_TBL} WHERE "ID" = ? FOR UPDATE
        `, [tutorialId]);
        if (recheck[0]?.LEGACYID != null) {
          console.log(`    skipped — concurrent publish already set legacyId=${recheck[0].LEGACYID}`);
          return;
        }

        // Pull a new sequence value.
        const [seqRow] = await tx.run(`SELECT ${TUT_SEQ}.NEXTVAL AS "nextval" FROM DUMMY`);
        const newId = seqRow.nextval;

        // Snapshot before-state.
        appendSnapshot({ kind: 'tutorial-before', table: TUT_TBL, id: tutorialId, slug, newId });
        for (const cpi of cpiRows) {
          appendSnapshot({ kind: 'cpi-before', table: CPI_TBL, id: cpi.ID, tutorialId, newId });
        }

        // Apply the Tutorials UPDATE first.
        await tx.run(
          `UPDATE ${TUT_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
          [newId, tutorialId]
        );
        // Apply the CPI UPDATE.
        const cpiResult = await tx.run(`
          UPDATE ${CPI_TBL}
             SET "TASKLEGACYID" = ?
           WHERE "TUTORIAL_ID" = ?
             AND "TASKLEGACYID" IS NULL
             AND "TASKTYPE" = 'TUTORIAL'
        `, [newId, tutorialId]);

        tutorialsRepaired++;
        // tx.run for an UPDATE returns the affected row count on HANA via
        // the underlying driver; if not, we fall back to the pre-count.
        const cpiCount = (typeof cpiResult === 'number') ? cpiResult : cpiRows.length;
        cpiRepaired += cpiCount;

        console.log(`    ✓ legacyId=${newId}  cpi_updated=${cpiCount}`);
      });
    } catch (err) {
      tutorialsFailed++;
      console.error(`    ✗ failed for ${slug}: ${err.message}`);
      // Continue with the next tutorial — fail-soft per spec.
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    tutorialsScanned: nullRows.length,
    tutorialsRepaired,
    tutorialsFailed,
    cpiRowsRepaired: cpiRepaired,
  }, null, 2));
  if (!COMMIT) console.log('\nDry-run complete. Re-run with --commit to apply.');
}

main().catch(e => { console.error(e); process.exit(1); });

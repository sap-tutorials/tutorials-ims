// One-shot / repeatable cleanup: delete ORPHANED draft rows left behind by the
// CAP 10.2 `draft_admin_integrity` outage (#2909 / #2993).
//
// Background:
//   `cds.fiori.draft_admin_integrity: true` was enabled (#2909) WITHOUT the
//   required ON DELETE CASCADE .hdbconstraint artifacts on HANA. With the flag
//   on and no cascade, discarding/activating a draft deleted only the
//   DRAFT_DRAFTADMINISTRATIVEDATA parent row — the child draft rows in the
//   ADMINSERVICE_*_DRAFTS tables were NOT cascaded, leaving orphans. Orphans
//   make the active entity un-editable (draftEdit -> DRAFT_ALREADY_EXISTS /
//   "Not Found", no discard affordance).
//
//   #2992 disabled the flag so NO NEW orphans form. This script clears orphans
//   created while the flag was still on (e.g. in the window between the outage
//   and the fixed build reaching an environment).
//
// An "orphan" = a draft row whose DRAFTADMINISTRATIVEDATA_DRAFTUUID has NO
// matching row in DRAFT_DRAFTADMINISTRATIVEDATA. Rows belonging to LIVE drafts
// (a real admin-data parent exists) are never touched.
//
// Run (inspect):  npx cds bind --exec -- node scripts/cleanup-draft-orphans.cjs --dry-run
// Run (delete):   npx cds bind --exec -- node scripts/cleanup-draft-orphans.cjs --commit
//
// Idempotent: a second run after a clean sweep is a no-op (exit 0).
// HANA-only: refuses to run on SQLite (draft table layout differs; unit tests
// use a different physical schema).

const cds = require('@sap/cds');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const DRY_RUN = !COMMIT;

const ADMIN = '"DRAFT_DRAFTADMINISTRATIVEDATA"';

(async () => {
  const db = await cds.connect.to('db');
  const isHana =
    db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }

  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}`);

  // Discover every real draft shadow table (carries the DraftAdministrativeData FK).
  const draftTables = (
    await db.run(
      `SELECT c."TABLE_NAME" AS T FROM "SYS"."TABLE_COLUMNS" c
         JOIN "SYS"."TABLES" t
           ON t."SCHEMA_NAME" = c."SCHEMA_NAME" AND t."TABLE_NAME" = c."TABLE_NAME"
        WHERE c."SCHEMA_NAME" = CURRENT_SCHEMA
          AND c."TABLE_NAME" LIKE '%\\_DRAFTS' ESCAPE '\\'
          AND c."COLUMN_NAME" = 'DRAFTADMINISTRATIVEDATA_DRAFTUUID'
        ORDER BY c."TABLE_NAME"`
    )
  ).map((r) => r.T);

  if (!draftTables.length) {
    console.log('No draft shadow tables found — nothing to do.');
    process.exit(0);
  }

  const liveAdmin = (await db.run(`SELECT COUNT(*) AS N FROM ${ADMIN}`))[0].N;
  console.log(`Live DRAFT_DRAFTADMINISTRATIVEDATA rows (preserved): ${liveAdmin}`);

  let totalOrphans = 0;
  let totalDeleted = 0;
  const perTable = [];

  for (const T of draftTables) {
    const q = `"${T}"`;
    const orphanWhere =
      `"DRAFTADMINISTRATIVEDATA_DRAFTUUID" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM ${ADMIN} a
            WHERE a."DRAFTUUID" = ${q}."DRAFTADMINISTRATIVEDATA_DRAFTUUID"
         )`;
    const n = (await db.run(`SELECT COUNT(*) AS N FROM ${q} WHERE ${orphanWhere}`))[0].N;
    if (n === 0) continue;
    totalOrphans += n;
    perTable.push({ table: T, orphans: n });

    if (COMMIT) {
      const del = await db.run(`DELETE FROM ${q} WHERE ${orphanWhere}`);
      const removed = del.changes ?? del ?? 0;
      totalDeleted += removed;
      console.log(`  ${T}: deleted ${removed}`);
    } else {
      console.log(`  ${T}: ${n} orphan(s) [dry-run]`);
    }
  }

  if (totalOrphans === 0) {
    console.log('No orphaned draft rows found — nothing to do.');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log(`\nDRY-RUN: ${totalOrphans} orphan row(s) across ${perTable.length} table(s).`);
    console.log('Re-run with --commit to delete them.');
    process.exit(0);
  }

  // Verify clean after commit.
  let remaining = 0;
  for (const { table } of perTable) {
    const q = `"${table}"`;
    const n = (
      await db.run(
        `SELECT COUNT(*) AS N FROM ${q}
          WHERE "DRAFTADMINISTRATIVEDATA_DRAFTUUID" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM ${ADMIN} a WHERE a."DRAFTUUID" = ${q}."DRAFTADMINISTRATIVEDATA_DRAFTUUID")`
      )
    )[0].N;
    remaining += n;
  }
  const liveAfter = (await db.run(`SELECT COUNT(*) AS N FROM ${ADMIN}`))[0].N;
  console.log(`\nDeleted ${totalDeleted} orphan row(s). Remaining orphans: ${remaining}.`);
  console.log(`Live admin rows before/after: ${liveAdmin}/${liveAfter} (must be equal).`);
  if (remaining !== 0 || liveAfter !== liveAdmin) {
    console.error('WARNING: post-cleanup verification unexpected — inspect manually.');
    process.exit(2);
  }
  console.log('OK — orphans cleared, live drafts intact.');
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});

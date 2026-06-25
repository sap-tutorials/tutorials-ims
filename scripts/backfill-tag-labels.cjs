#!/usr/bin/env node
/**
 * One-shot backfill for COM_SAP_DEVELOPERS_IMS_TAGS.LABEL.
 *
 * Issue (PR #648): The Advocate OP's Topics inline table renders the
 * Tag's primary key GUID instead of a label because @Common.Text: tag/label
 * resolves to NULL for Tags whose LABEL column is empty. The seed-tag-labels
 * script harvests labels from AEM Solr but doesn't cover every Tag in HANA
 * — gaps like '546f2cba-...' (SAP Cloud Application Programming Model) ship
 * with NAME populated but LABEL null, leaving FE V4 to render the FK GUID
 * as fallback.
 *
 * Fix: for any Tag row where LABEL IS NULL but NAME is non-empty, set
 * LABEL = NAME. The Tags admin UI lets admins refine labels later.
 *
 * Usage:
 *   # Dry-run (default) — counts + sample, no writes.
 *   npx cds bind --exec -- node scripts/backfill-tag-labels.cjs
 *
 *   # Live run — actually updates.
 *   npx cds bind --exec -- node scripts/backfill-tag-labels.cjs --commit
 *
 * Idempotent — second run finds 0 rows. Safe to retire after one clean run.
 */
'use strict';

const cds = require('@sap/cds');

const COMMIT = process.argv.includes('--commit');

async function main() {
  console.log('backfill-tag-labels');
  console.log(COMMIT ? '  Mode: --commit (will UPDATE matching rows)\n' : '  Mode: dry-run (no writes; use --commit to apply)\n');

  const db = await cds.connect.to('db');

  // Tags table columns are UPPERCASE in HANA (legacy migrator DDL path).
  const rows = await db.run(
    `SELECT "ID", NAME, LABEL
       FROM COM_SAP_DEVELOPERS_IMS_TAGS
      WHERE LABEL IS NULL
        AND LENGTH(TRIM(COALESCE(NAME, ''))) > 0`
  );

  console.log(`Found ${rows.length} Tag row(s) with NULL LABEL but non-empty NAME:`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.ID}  NAME='${r.NAME}'  → LABEL='${r.NAME}'`);
  }
  if (rows.length > 10) {
    console.log(`  ...and ${rows.length - 10} more`);
  }

  if (rows.length === 0) {
    console.log('\nNothing to backfill. Done.');
    return;
  }

  if (!COMMIT) {
    console.log('\nDry-run complete. Re-run with --commit to apply.');
    return;
  }

  const result = await db.run(
    `UPDATE COM_SAP_DEVELOPERS_IMS_TAGS
        SET LABEL = NAME
      WHERE LABEL IS NULL
        AND LENGTH(TRIM(COALESCE(NAME, ''))) > 0`
  );
  const affected = typeof result === 'number' ? result : (result?.affectedRows ?? rows.length);
  console.log(`\nUpdated row count reported by HANA: ${affected}`);
  console.log(`(Expected: ${rows.length}. Drift indicates concurrent writes during the run — re-run to converge.)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});

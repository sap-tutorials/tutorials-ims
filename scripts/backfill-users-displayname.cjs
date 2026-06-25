#!/usr/bin/env node
/**
 * One-shot backfill for COM_SAP_DEVELOPERS_IMS_USERS.DISPLAYNAME.
 *
 * Issue #638: migrated users often have firstName + lastName populated by
 * the JWT but displayName=null (the IMS migrator copied SAP_ID + totals
 * but never displayName). Empty displayName makes the Advocate OP's
 * "Linked User" field render '-' because @Common.Text: user/displayName
 * resolves to null.
 *
 * Fix: compute displayName = TRIM(firstName + ' ' + lastName) for any row
 * where displayName IS NULL AND at least one name part is non-empty. Rows
 * with no firstName AND no lastName get skipped — those are typically not-
 * yet-JIT-backfilled migrated users whose next login triggers
 * srv/lib/resolve-db-user.js#backfillUserProfile to populate everything.
 *
 * Usage:
 *   # Dry-run (default) — shows count + a sample, no writes.
 *   npx cds bind --exec -- node scripts/backfill-users-displayname.cjs
 *
 *   # Live run — actually updates.
 *   npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit
 *
 * Idempotent — second run finds 0 rows. Safe to retire after one clean
 * run on DEV, but harmless to keep around for future migrated batches.
 */
'use strict';

const cds = require('@sap/cds');

const COMMIT = process.argv.includes('--commit');

async function main() {
  console.log('backfill-users-displayname');
  console.log(COMMIT ? '  Mode: --commit (will UPDATE matching rows)\n' : '  Mode: dry-run (no writes; use --commit to apply)\n');

  const db = await cds.connect.to('db');

  // Find candidate rows. HANA stores unquoted CDS identifiers as
  // UPPERCASE; mixed-case identifiers must be quoted.
  const rows = await db.run(
    `SELECT "ID", "firstName", "lastName", "displayName", EMAIL
       FROM COM_SAP_DEVELOPERS_IMS_USERS
      WHERE "displayName" IS NULL
        AND (
          LENGTH(TRIM(COALESCE("firstName", ''))) > 0
          OR LENGTH(TRIM(COALESCE("lastName", ''))) > 0
        )`
  );

  console.log(`Found ${rows.length} candidate row(s) with NULL displayName but non-empty name:`);
  for (const r of rows.slice(0, 10)) {
    const newName = `${r.firstName || ''} ${r.lastName || ''}`.trim();
    console.log(`  ${r.ID}  '${r.firstName ?? ''}' + '${r.lastName ?? ''}' → '${newName}'  (${r.EMAIL ?? '<no email>'})`);
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

  // Run the UPDATE. The same WHERE clause is reapplied so the operation
  // remains idempotent — re-running after partial failure finds the
  // still-NULL rows. TRIM is double-applied (inner + the outer wrapping)
  // to defend against rows where firstName is '   ' (whitespace-only).
  const result = await db.run(
    `UPDATE COM_SAP_DEVELOPERS_IMS_USERS
        SET "displayName" = TRIM(
              COALESCE("firstName", '') || ' ' || COALESCE("lastName", '')
            )
      WHERE "displayName" IS NULL
        AND (
          LENGTH(TRIM(COALESCE("firstName", ''))) > 0
          OR LENGTH(TRIM(COALESCE("lastName", ''))) > 0
        )`
  );
  // hdb driver returns either a numeric affected-row count or an object
  // with affectedRows. Normalize for the log line.
  const affected = typeof result === 'number' ? result : (result?.affectedRows ?? rows.length);
  console.log(`\nUpdated row count reported by HANA: ${affected}`);
  console.log(`(Expected: ${rows.length}. Drift indicates concurrent writes during the run — re-run to converge.)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});

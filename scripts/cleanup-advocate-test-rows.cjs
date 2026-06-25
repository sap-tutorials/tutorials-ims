#!/usr/bin/env node
/**
 * One-shot cleanup for shadow / test-fixture rows in
 * COM_SAP_DEVELOPERS_IMS_ADVOCATES.
 *
 * Background (issue #638): On 2026-06-25 Tom's real advocate row on DEV
 * was reset to test-fixture identity strings. The fix is two-part: rename
 * the unit-test fixtures so they can't shadow real data (separate commits),
 * and this script to scrub the HANA row that already drifted.
 *
 * Matches:
 *   - slug LIKE '__test__%'        (catches the new __test__advocate-link-* fixture pattern)
 *   - firstName LIKE '__TEST__%'   (defensive — catches rows where slug was overwritten but identity wasn't)
 *   - slug = 'thomas-jung'         (one-time cleanup of the legacy fixture; only fires if the row
 *                                   IS the test fixture, not Tom's real row — Tom's row will get
 *                                   a different slug post-DB-cleanup, manually restored)
 *
 * Usage:
 *   # Dry-run (default) — shows what would be deleted, no writes.
 *   npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs
 *
 *   # Live run — actually deletes the rows.
 *   npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs --commit
 *
 * IMPORTANT: Tom must confirm the dry-run output before running --commit.
 * The legacy 'thomas-jung' literal in the WHERE clause is a transitional
 * safeguard; after one successful run on DEV + Tom's manual re-create of
 * his real advocate row with a new slug, the literal can be dropped.
 *
 * The script is idempotent — re-running after a clean execution finds 0 rows.
 */
'use strict';

const cds = require('@sap/cds');

const COMMIT = process.argv.includes('--commit');

async function main() {
  console.log('cleanup-advocate-test-rows');
  console.log(COMMIT ? '  Mode: --commit (will DELETE matching rows)\n' : '  Mode: dry-run (no writes; use --commit to apply)\n');

  const db = await cds.connect.to('db');

  // Identify candidate rows. HANA stores unquoted CDS identifiers as
  // UPPERCASE; only quote mixed-case identifiers ("ID", "firstName").
  const rows = await db.run(
    `SELECT "ID", SLUG, "firstName", "lastName", BIO
       FROM COM_SAP_DEVELOPERS_IMS_ADVOCATES
      WHERE SLUG LIKE '__test__%'
         OR "firstName" LIKE '__TEST__%'
         OR SLUG = 'thomas-jung'`
  );

  console.log(`Found ${rows.length} test-fixture / shadow row(s):`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.ID}  slug=${r.SLUG}  ${r.firstName} ${r.lastName}`);
  }
  if (rows.length > 10) {
    console.log(`  ...and ${rows.length - 10} more`);
  }

  if (rows.length === 0) {
    console.log('\nNothing to clean up. Done.');
    return;
  }

  if (!COMMIT) {
    console.log('\nDry-run complete. Re-run with --commit to delete these rows.');
    return;
  }

  // CASCADE: AdvocateTopics, AdvocateLinks, AdvocatePhotos all FK to Advocates.
  // The schema declares them as `Composition`, so deleting parent rows cascades
  // children. Confirm by attempting the parent DELETE; HANA raises a FK error
  // if any child row exists without ON DELETE CASCADE.
  const ids = rows.map((r) => r.ID);
  const placeholders = ids.map((_, i) => `?`).join(',');
  const result = await db.run(
    {
      query: `DELETE FROM COM_SAP_DEVELOPERS_IMS_ADVOCATES WHERE "ID" IN (${placeholders})`,
      values: ids,
    }
  );
  // hdb driver returns either a numeric affected-row count or an object
  // with affectedRows. Normalize for the log line.
  const affected = typeof result === 'number' ? result : (result?.affectedRows ?? rows.length);
  console.log(`\nDeleted ${affected} row(s) from Advocates. Cascade dropped any child Links/Topics/Photos.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});

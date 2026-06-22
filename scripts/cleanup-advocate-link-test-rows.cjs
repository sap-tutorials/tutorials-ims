#!/usr/bin/env node
/**
 * One-shot cleanup for orphan test-fixture rows in COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS.
 *
 * Background:
 *   Tom hit a 400 "Invalid value: ADL00001" error on 2026-06-22 trying to
 *   save an Advocate draft. Root cause: DEV HANA contains AdvocateLinks rows
 *   with IDs like 'ADL00001-0000-0000-0000-000000000001' — the literal test
 *   fixture from test/unit/advocates/api.test.js:41. The 'L' in 'ADL' is not
 *   a hex character, so when FE V4 builds an OData key URL like
 *   /AdvocateLinks(ID=guid'ADL00001-...') the @sap/cds OData parser bails
 *   with "Invalid value" before the request reaches any service handler.
 *
 *   The test file uses cds.test('serve', '--in-memory') so it should run
 *   against fresh in-memory SQLite — these rows must have been inserted by
 *   a developer running tests under `cds bind` against the deployed HANA,
 *   OR by an early seed pass that landed here by accident.
 *
 * Usage:
 *   # Dry-run (default) — shows what would be deleted, no writes.
 *   npx cds bind --exec -- node scripts/cleanup-advocate-link-test-rows.cjs
 *
 *   # Live run — actually deletes the rows.
 *   npx cds bind --exec -- node scripts/cleanup-advocate-link-test-rows.cjs --commit
 *
 * The script is idempotent — re-running after a clean execution finds 0 rows.
 * Safe to retire once DEV is verified clean.
 */
'use strict';

const cds = require('@sap/cds');

const COMMIT = process.argv.includes('--commit');

async function main() {
  console.log('cleanup-advocate-link-test-rows');
  console.log(COMMIT ? '  Mode: --commit (will DELETE matching rows)\n' : '  Mode: dry-run (no writes; use --commit to apply)\n');

  const db = await cds.connect.to('db');

  // Find the malformed rows. Match prefix only — the test fixture pattern
  // is 'ADL00001-0000-...' but we should catch any ID starting with non-hex
  // letters in the first 8 characters (UUIDs are 0-9a-fA-F only). For
  // safety, scope to known test prefix.
  // HANA stores unquoted CDS identifiers as UPPERCASE; only quote the
  // mixed-case ones (just "ID" here — "kind" and "url" map to KIND / URL).
  const rows = await db.run(
    `SELECT "ID", KIND, URL FROM COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS WHERE "ID" LIKE 'ADL%'`
  );

  console.log(`Found ${rows.length} rows with test-fixture IDs (prefix 'ADL'):`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.ID}  kind=${r.KIND}  url=${r.URL}`);
  }
  if (rows.length > 10) {
    console.log(`  ...and ${rows.length - 10} more`);
  }

  if (rows.length === 0) {
    console.log('\nNothing to clean up. Done.');
    return;
  }

  if (!COMMIT) {
    console.log('\n[dry-run] No rows deleted. Re-run with --commit to apply.');
    return;
  }

  const result = await db.run(
    `DELETE FROM COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS WHERE "ID" LIKE 'ADL%'`
  );
  // hdb returns either a numeric affected-row count or a result object
  // depending on driver version; normalize for readable output.
  const deleted = typeof result === 'number' ? result : (result?.affectedRows ?? rows.length);
  console.log(`\nDeleted ${deleted} row(s).`);

  // Also clear any draft rows that referenced them (FE V4 carries the orphan
  // composition into the draft buffer; a stale draft can re-create the
  // problem on next save).
  const draftsExists = await db.run(
    `SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = 'COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS_DRAFTS'`
  ).catch(() => []);
  if (draftsExists.length > 0) {
    const draftResult = await db.run(
      `DELETE FROM COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS_DRAFTS WHERE "ID" LIKE 'ADL%'`
    );
    const draftDeleted = typeof draftResult === 'number' ? draftResult : (draftResult?.affectedRows ?? 0);
    console.log(`Deleted ${draftDeleted} draft row(s).`);
  }
}

main().catch((err) => {
  console.error('\n❌ Cleanup failed:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});

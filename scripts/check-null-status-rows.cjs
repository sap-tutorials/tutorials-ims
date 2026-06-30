#!/usr/bin/env node
// One-shot diagnostic — run via `cds bind --exec -- node scripts/check-null-status-rows.cjs`
// against DEV (and optionally PROD). Reports Tutorials rows with status IS NULL.
//
// Used by docs/superpowers/plans/2026-06-30-orphan-purge.md Task 1 to validate
// the assumption that NULL-status rows are rare. The source-hashes filter in
// Task 3 already handles both cases (ships with OR-NULL clause), so this is
// a sanity check, not a decision branch.

const cds = require('@sap/cds');

(async () => {
  await cds.connect.to('db');
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  const sql = isHana
    ? `SELECT COUNT(*) AS NULL_COUNT FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "STATUS" IS NULL`
    : `SELECT COUNT(*) AS NULL_COUNT FROM com_sap_developers_ims_tutorials WHERE status IS NULL`;
  const result = await db.run(sql);
  const count = result[0]?.NULL_COUNT ?? result[0]?.null_count ?? result[0]?.['COUNT(*)'] ?? 0;
  console.log(`Tutorials with status IS NULL: ${count}`);
  if (count > 0) {
    console.log(`\n→ The new /content/source-hashes filter ships with`);
    console.log(`  WHERE (t.status IS NULL OR t.status != 'INACTIVE')`);
    console.log(`  so these NULL rows continue to be returned (matches the serve handler).`);
  } else {
    console.log(`→ Filter's OR-NULL clause is currently defensive (no rows match it today).`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});

/**
 * seed-codecheck-saved-queries.cjs — INSERT three canned AnalyticsSavedQuery
 * rows for Phase 4 (#210). Reads scripts/sample-submissions/seed-saved-queries.json
 * and creates each row via CDS QL against the bound HANA database.
 *
 * Runs once per environment. Idempotent on `name` — if a row with the same
 * name already exists, the script skips it and prints SKIPPED. Use --force
 * to overwrite (delete-then-insert).
 *
 * Why a script instead of UI import: app/analytics-explorer/'s SavedTab.vue
 * has no Import button. The only programmatic save path is `useSavedQueries.saveAs`
 * which POSTs through admin auth. Locally with `cds bind`, INSERTing via
 * CDS QL is the simplest route.
 *
 * Prerequisites:
 *   - `cf login` to the target space
 *   - `npx cds bind --to <hana-binding>`
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/seed-codecheck-saved-queries.cjs
 *
 * Flags:
 *   --force           Delete existing rows by name before re-inserting.
 *   --dry-run         Print the rows that would be inserted; do not write.
 */

const cds = require('@sap/cds');
const { readFileSync } = require('node:fs');

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');
  // Per [[feedback_cds_entities_runtime_only]], cds.entities(...) can be
  // undefined in plain CJS even after cds.load('*'). If this fails on first
  // run, fall back to raw SQL like setup-dev-data.cjs does:
  //   await db.run(`SELECT * FROM COM_SAP_DEVELOPERS_IMS_ANALYTICSSAVEDQUERY WHERE NAME = ?`, [row.name])
  const { AnalyticsSavedQuery } = cds.entities('com.sap.developers.ims');

  const seedPath = 'scripts/sample-submissions/seed-saved-queries.json';
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  if (!Array.isArray(seed)) {
    console.error(`Expected ${seedPath} to be a JSON array.`);
    process.exit(1);
  }

  console.log(`Seeding ${seed.length} SavedQuery rows from ${seedPath} (dry-run=${dryRun}, force=${force})\n`);

  let inserted = 0, skipped = 0, replaced = 0;

  for (const row of seed) {
    if (!row.name) {
      console.error('Row missing required `name` field — skipping.');
      continue;
    }
    const existing = await SELECT.one.from(AnalyticsSavedQuery).where({ name: row.name });

    if (existing && !force) {
      console.log(`  SKIPPED  ${row.name} — already exists (use --force to replace)`);
      skipped++;
      continue;
    }

    if (existing && force) {
      if (!dryRun) await DELETE.from(AnalyticsSavedQuery).where({ ID: existing.ID });
      console.log(`  REPLACED ${row.name}`);
      replaced++;
    } else {
      console.log(`  INSERTED ${row.name}`);
      inserted++;
    }

    if (!dryRun) {
      await INSERT.into(AnalyticsSavedQuery).entries({
        name: row.name,
        description: row.description || null,
        sql: row.sql,
        spec: row.spec || null,
        visibility: row.visibility || 'private',
      });
    }
  }

  console.log(`\nDone. inserted=${inserted}  skipped=${skipped}  replaced=${replaced}`);
  if (dryRun) console.log('(dry-run — no writes performed)');
  process.exit(0);
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});

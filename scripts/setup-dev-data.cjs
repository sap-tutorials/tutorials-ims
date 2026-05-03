/**
 * setup-dev-data.cjs — Prepare DEV HANA database for the build pipeline
 *
 * This script performs two operations:
 *   1. Deletes all "autotest" records (test data from IMS integration tests)
 *   2. Assigns slug values from .migration-data/slug-mapping.json to missions and groups
 *
 * Prerequisites:
 *   - `cf login` to the DEV space
 *   - `cds bind --to tutorials-db` (creates .cdsrc-private.json with HANA binding)
 *   - .migration-data/slug-mapping.json must exist (extracted from ContentFiles)
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/setup-dev-data.cjs
 *
 * Flags:
 *   --skip-cleanup    Skip autotest record deletion
 *   --skip-slugs      Skip slug assignment
 *   --dry-run         Show what would happen without making changes
 */

const cds = require('@sap/cds');
const fs = require('fs');

const args = process.argv.slice(2);
const skipCleanup = args.includes('--skip-cleanup');
const skipSlugs = args.includes('--skip-slugs');
const dryRun = args.includes('--dry-run');

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');

  if (dryRun) console.log('=== DRY RUN — no changes will be made ===\n');

  // --- Step 1: Delete autotest records ---
  if (!skipCleanup) {
    console.log('=== Step 1: Deleting autotest records ===');
    const tables = [
      { table: 'COM_SAP_DEVELOPERS_IMS_MISSIONS', col: 'TITLE', pattern: 'autotest%' },
      { table: 'COM_SAP_DEVELOPERS_IMS_TUTORIALS', col: 'TITLE', pattern: 'autotest%' },
      { table: 'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS', col: 'NAME', pattern: 'autotest%' },
      { table: 'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS', col: 'NAME', pattern: 'autotest%' },
      { table: 'COM_SAP_DEVELOPERS_IMS_EVENTS', col: 'NAME', pattern: 'autotest%' },
      { table: 'COM_SAP_DEVELOPERS_IMS_TAGS', col: 'NAME', pattern: 'autotest%' },
    ];

    for (const { table, col, pattern } of tables) {
      const [count] = await db.run(`SELECT COUNT(*) AS "C" FROM "${table}" WHERE "${col}" LIKE '${pattern}'`);
      if (count.C > 0) {
        if (!dryRun) {
          await db.run(`DELETE FROM "${table}" WHERE "${col}" LIKE '${pattern}'`);
        }
        console.log(`  ${dryRun ? 'Would delete' : 'Deleted'} ${count.C} rows from ${table.split('_').pop()}`);
      }
    }
  }

  // --- Step 2: Assign slugs ---
  if (!skipSlugs) {
    console.log('\n=== Step 2: Assigning slugs from slug-mapping.json ===');
    const mappingPath = '.migration-data/slug-mapping.json';
    if (!fs.existsSync(mappingPath)) {
      console.error(`ERROR: ${mappingPath} not found.`);
      console.error('Generate it with: node scripts/extract-slug-mapping.js');
      process.exit(1);
    }
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));

    // Missions
    const available = await db.run(
      `SELECT "ID", "LEGACYID", "TITLE" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE "SLUG" IS NULL ORDER BY "LEGACYID"`
    );
    console.log(`  Missions without slug: ${available.length}, slugs to assign: ${mapping.missions.length}`);

    if (available.length < mapping.missions.length) {
      console.error(`  WARNING: Only ${available.length} records available for ${mapping.missions.length} slugs`);
    }

    let mPatched = 0;
    const mCount = Math.min(available.length, mapping.missions.length);
    for (let i = 0; i < mCount; i++) {
      const { slug, title } = mapping.missions[i];
      if (!dryRun) {
        await db.run(
          `UPDATE "COM_SAP_DEVELOPERS_IMS_MISSIONS" SET "SLUG" = ?, "TITLE" = ? WHERE "ID" = ?`,
          [slug, title, available[i].ID]
        );
      }
      mPatched++;
    }
    console.log(`  Missions: ${mPatched} slugs ${dryRun ? 'would be' : ''} assigned`);

    // Groups (CompletionPaths)
    const availableGroups = await db.run(
      `SELECT "ID", "LEGACYID", "NAME" FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" WHERE "SLUG" IS NULL ORDER BY "LEGACYID"`
    );
    console.log(`  Groups without slug: ${availableGroups.length}, slugs to assign: ${mapping.groups.length}`);

    if (availableGroups.length < mapping.groups.length) {
      console.error(`  WARNING: Only ${availableGroups.length} records available for ${mapping.groups.length} slugs`);
    }

    let gPatched = 0;
    const gCount = Math.min(availableGroups.length, mapping.groups.length);
    for (let i = 0; i < gCount; i++) {
      const { slug, title } = mapping.groups[i];
      if (!dryRun) {
        await db.run(
          `UPDATE "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" SET "SLUG" = ?, "NAME" = ? WHERE "ID" = ?`,
          [slug, title, availableGroups[i].ID]
        );
      }
      gPatched++;
    }
    console.log(`  Groups: ${gPatched} slugs ${dryRun ? 'would be' : ''} assigned`);

    // Verify
    if (!dryRun) {
      const [mCheck] = await db.run(`SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE "SLUG" IS NOT NULL`);
      const [gCheck] = await db.run(`SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" WHERE "SLUG" IS NOT NULL`);
      console.log(`\n  Verification: ${mCheck.C} missions with slugs, ${gCheck.C} groups with slugs`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

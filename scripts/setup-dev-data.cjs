/**
 * setup-dev-data.cjs — Prepare DEV HANA database for the build pipeline
 *
 * This script performs two operations:
 *   1. Deletes all "autotest" records (test data from IMS integration tests)
 *   2. Derives slugs from titles for missions, groups, and CompletionPaths
 *
 * Prerequisites:
 *   - `cf login` to the DEV space
 *   - `cds bind --to tutorials-db` (creates .cdsrc-private.json with HANA binding)
 *
 * Slug coverage:
 *   - Step 3 (Title-derived) is the canonical path. It runs on all SLUG-NULL
 *     rows of Missions, Groups, and CompletionPaths whose TITLE/NAME is set.
 *   - Step 2 (static mapping from slug-mapping.json) is OFF by default since
 *     issue #348. The static mapping was a one-off bootstrap helper from a
 *     specific DEV state; running it against fresh prod data corrupts row
 *     titles via positional misalignment. Re-enable with --from-static-mapping
 *     for the legacy bootstrap scenario only.
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/setup-dev-data.cjs
 *
 * Flags:
 *   --skip-cleanup            Skip autotest record deletion
 *   --skip-slugs              Skip slug assignment (both Step 2 and Step 3)
 *   --from-static-mapping     Opt back into Step 2 (legacy bootstrap; corrupts titles)
 *   --dry-run                 Show what would happen without making changes
 */

const cds = require('@sap/cds');
const fs = require('fs');

const args = process.argv.slice(2);
const skipCleanup = args.includes('--skip-cleanup');
const skipSlugs = args.includes('--skip-slugs');
const fromStaticMapping = args.includes('--from-static-mapping');
const dryRun = args.includes('--dry-run');

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');
  // slug-utils.js is ESM — load via dynamic import from this CJS script.
  const { slugify, ensureUniqueSlug } = await import('../srv/lib/slug-utils.js');

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

  // --- Step 2: Assign slugs from static mapping (OFF by default since #348) ---
  //
  // This step blindly assigns SLUG and TITLE from .migration-data/slug-mapping.json
  // by positional index (i-th NULL-slug row gets the i-th mapping entry). It was
  // a one-off bootstrap helper for an earlier DEV state where the IDs in the JSON
  // happened to match. After a real prod migration the row order is different,
  // so this corrupts CompletionPath/Mission TITLEs by attaching them to the
  // wrong rows.
  //
  // Step 3 below derives slugs from real TITLEs, which is correct. Pass
  // --from-static-mapping to opt back into Step 2 for the original bootstrap
  // scenario.
  if (!skipSlugs && fromStaticMapping) {
    console.log('\n=== Step 2: Assigning slugs from slug-mapping.json (--from-static-mapping) ===');
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
  } else if (!skipSlugs) {
    console.log('\n=== Step 2: SKIPPED (use --from-static-mapping for legacy bootstrap behaviour) ===');
  }

  // --- Step 3: Title-derived slugs ---
  //
  // For Missions, Groups, and CompletionPaths: any row whose title (NAME for
  // CompletionPaths) is set but slug is NULL gets a derived slug. CompletionPaths
  // with NULL NAME stay slugless — Tom's published-default-false (#349) means
  // those paths aren't visible until a SuperAdmin curates them anyway, so the
  // missing slug doesn't strand any visible page.
  if (!skipSlugs) {
    console.log('\n=== Step 3: Deriving slugs from titles for remaining rows ===');

    for (const { name, table, titleCol } of [
      { name: 'Missions',         table: 'COM_SAP_DEVELOPERS_IMS_MISSIONS',         titleCol: 'TITLE' },
      { name: 'Groups',           table: 'COM_SAP_DEVELOPERS_IMS_GROUPS',           titleCol: 'TITLE' },
      { name: 'CompletionPaths',  table: 'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS',  titleCol: 'NAME'  },
    ]) {
      // Skip silently if the table doesn't exist yet (Groups slug column was
      // only just added — pre-deploy environments won't have it).
      let missing;
      try {
        missing = await db.run(
          `SELECT "ID", "${titleCol}" AS "TITLE" FROM "${table}" WHERE "SLUG" IS NULL AND "${titleCol}" IS NOT NULL`
        );
      } catch (e) {
        console.log(`  ${name}: table or SLUG column not present — skipping (${e.message})`);
        continue;
      }

      if (!missing.length) {
        console.log(`  ${name}: no rows missing slug`);
        continue;
      }

      const takenRows = await db.run(`SELECT "SLUG" FROM "${table}" WHERE "SLUG" IS NOT NULL`);
      const taken = new Set(takenRows.map(r => r.SLUG).filter(Boolean));

      let derived = 0;
      for (const row of missing) {
        const base = slugify(row.TITLE);
        const unique = ensureUniqueSlug(base, taken);
        taken.add(unique);
        if (!dryRun) {
          await db.run(`UPDATE "${table}" SET "SLUG" = ? WHERE "ID" = ?`, [unique, row.ID]);
        }
        derived++;
      }
      console.log(`  ${name}: ${derived} slug${derived === 1 ? '' : 's'} ${dryRun ? 'would be ' : ''}derived from title`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

/**
 * seed-dev-tags-and-slugs.cjs — Bootstrap an empty DEV database with tags, missions, and groups
 *
 * For use when the DEV HANA is freshly deployed with no data. Creates:
 *   1. Tags from IMS production API (no auth needed)
 *   2. Missions with slugs from slug-mapping.json
 *   3. Groups (CompletionPaths) with slugs from slug-mapping.json
 *
 * Prerequisites:
 *   - `cf login` to the DEV space
 *   - HANA Cloud must allow your IP (or use cds bind through cf ssh tunnel)
 *   - .migration-data/slug-mapping.json must exist
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/seed-dev-tags-and-slugs.cjs
 *
 * Flags:
 *   --dry-run         Show what would happen without making changes
 *   --skip-tags       Skip tag import from IMS
 *   --skip-missions   Skip mission creation
 *   --skip-groups     Skip group creation
 */

const cds = require('@sap/cds');
const fs = require('fs');
const crypto = require('crypto');

const IMS_BASE_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipTags = args.includes('--skip-tags');
const skipMissions = args.includes('--skip-missions');
const skipGroups = args.includes('--skip-groups');

function uuid() { return crypto.randomUUID(); }

async function fetchTags() {
  console.log(`  Fetching tags from ${IMS_BASE_URL}/api/tags ...`);
  const res = await fetch(`${IMS_BASE_URL}/api/tags`);
  if (!res.ok) throw new Error(`Failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const records = Array.isArray(data) ? data : (data.content || data._embedded?.tags || []);
  console.log(`  Got ${records.length} tags from IMS`);
  return records;
}

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');

  if (dryRun) console.log('=== DRY RUN — no changes will be made ===\n');

  // --- Step 1: Import Tags ---
  if (!skipTags) {
    console.log('=== Step 1: Importing Tags from IMS ===');

    const [existing] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_TAGS"');
    if (existing.C > 0) {
      console.log(`  Already have ${existing.C} tags — skipping (use --skip-tags to force)`);
    } else {
      const tags = await fetchTags();
      let inserted = 0;
      for (const tag of tags) {
        const id = uuid();
        const legacyId = tag.id || tag.legacyId;
        const name = tag.name || '';
        const titlePath = tag.titlePath || '';
        if (!dryRun) {
          await db.run(
            `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TAGS" ("ID", "LEGACYID", "NAME", "TITLEPATH") VALUES (?, ?, ?, ?)`,
            [id, legacyId, name, titlePath]
          );
        }
        inserted++;
      }
      console.log(`  ${dryRun ? 'Would insert' : 'Inserted'} ${inserted} tags`);
    }
  }

  // --- Step 2: Create Missions with slugs ---
  if (!skipMissions) {
    console.log('\n=== Step 2: Creating Missions with slugs ===');

    const [existing] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"');
    if (existing.C > 0) {
      console.log(`  Already have ${existing.C} missions — skipping`);
    } else {
      const mappingPath = '.migration-data/slug-mapping.json';
      if (!fs.existsSync(mappingPath)) {
        console.error(`  ERROR: ${mappingPath} not found`);
        process.exit(1);
      }
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));

      let inserted = 0;
      for (let i = 0; i < mapping.missions.length; i++) {
        const { slug, title } = mapping.missions[i];
        const id = uuid();
        const legacyId = 1000 + i;
        if (!dryRun) {
          await db.run(
            `INSERT INTO "COM_SAP_DEVELOPERS_IMS_MISSIONS" ("ID", "LEGACYID", "TITLE", "SLUG", "PUBLISHED", "LEVEL", "TIME") VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, legacyId, title, slug, true, 'beginner', 60]
          );
        }
        inserted++;
      }
      console.log(`  ${dryRun ? 'Would insert' : 'Inserted'} ${inserted} missions with slugs`);
    }
  }

  // --- Step 3: Create Groups (CompletionPaths) with slugs ---
  if (!skipGroups) {
    console.log('\n=== Step 3: Creating Groups (CompletionPaths) with slugs ===');

    const [existing] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"');
    if (existing.C > 0) {
      console.log(`  Already have ${existing.C} groups — skipping`);
    } else {
      const mappingPath = '.migration-data/slug-mapping.json';
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));

      // Need mission IDs for association — fetch first mission to associate
      const missions = await db.run(
        'SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" ORDER BY "LEGACYID" LIMIT 1'
      );
      const defaultMissionId = missions.length > 0 ? missions[0].ID : null;

      let inserted = 0;
      for (let i = 0; i < mapping.groups.length; i++) {
        const { slug, title } = mapping.groups[i];
        const id = uuid();
        const legacyId = 2000 + i;
        if (!dryRun) {
          await db.run(
            `INSERT INTO "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" ("ID", "LEGACYID", "NAME", "SLUG", "MISSION_ID") VALUES (?, ?, ?, ?, ?)`,
            [id, legacyId, title, slug, defaultMissionId]
          );
        }
        inserted++;
      }
      console.log(`  ${dryRun ? 'Would insert' : 'Inserted'} ${inserted} groups with slugs`);
    }
  }

  // --- Summary ---
  if (!dryRun) {
    console.log('\n=== Summary ===');
    const [tags] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_TAGS"');
    const [missions] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE "SLUG" IS NOT NULL');
    const [groups] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" WHERE "SLUG" IS NOT NULL');
    console.log(`  Tags: ${tags.C}`);
    console.log(`  Missions with slugs: ${missions.C}`);
    console.log(`  Groups with slugs: ${groups.C}`);
  }

  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

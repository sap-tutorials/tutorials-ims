/**
 * seed-dev-tutorials.cjs — Bootstrap DEV HANA with Tutorial records from cached .md files
 *
 * Creates Tutorial records from .tutorial-cache/*.md files, extracting:
 *   - slug (from filename)
 *   - title (from first H1 heading)
 *   - primaryTag (from frontmatter primary_tag)
 *   - experienceTag (from tags array, e.g. tutorial>beginner)
 *   - averageTimeToComplete (from frontmatter time)
 *
 * Prerequisites:
 *   - `cf login` to the DEV space
 *   - HANA Cloud must allow your IP
 *   - .tutorial-cache/ must contain fetched .md files
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/seed-dev-tutorials.cjs
 *
 * Flags:
 *   --dry-run         Show what would happen without making changes
 *   --skip-tags       Skip tag import from IMS
 */

const cds = require('@sap/cds');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMS_BASE_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CACHE_DIR = '.tutorial-cache';
const HUGO_CONTENT_DIR = path.join('hugo', 'content', 'tutorials');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipTags = args.includes('--skip-tags');
const skipSteps = args.includes('--skip-steps');

function uuid() { return crypto.randomUUID(); }

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim());
    }
    fm[key] = val;
  }
  return fm;
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function extractExperienceTag(tags) {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    if (t.startsWith('tutorial>')) return t.split('>')[1];
  }
  return null;
}

function loadTagsFromCache() {
  const tagFile = path.join('.migration-data', 'tags-from-cache.json');
  if (!fs.existsSync(tagFile)) {
    throw new Error(`${tagFile} not found. Extract tags from tutorial frontmatter first.`);
  }
  const tags = JSON.parse(fs.readFileSync(tagFile, 'utf-8'));
  console.log(`  Loaded ${tags.length} tags from ${tagFile}`);
  return tags;
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
      console.log(`  Already have ${existing.C} tags — skipping`);
    } else {
      const tags = loadTagsFromCache();
      let inserted = 0;
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const id = uuid();
        const legacyId = 5000 + i;
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

  // --- Step 2: Create Tutorials from .tutorial-cache ---
  console.log('\n=== Step 2: Creating Tutorials from cache ===');

  const [existing] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"');
  if (existing.C > 0) {
    console.log(`  Already have ${existing.C} tutorials — checking for missing legacyIds...`);
    const nullRows = await db.run(
      'SELECT "ID", "SLUG" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "LEGACYID" IS NULL ORDER BY "SLUG"'
    );
    if (nullRows.length === 0) {
      console.log('  All tutorials have legacyId — nothing to backfill');
    } else {
      console.log(`  Found ${nullRows.length} tutorials with NULL legacyId — backfilling...`);
      let backfilled = 0;
      for (let i = 0; i < nullRows.length; i++) {
        const legacyId = 20000 + i;
        if (!dryRun) {
          await db.run(
            'UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALS" SET "LEGACYID" = ? WHERE "ID" = ?',
            [legacyId, nullRows[i].ID]
          );
        }
        backfilled++;
      }
      console.log(`  ${dryRun ? 'Would backfill' : 'Backfilled'} ${backfilled} tutorials (legacyId 20000–${20000 + backfilled - 1})`);
    }
  } else {
    const mdFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.md'));
    console.log(`  Found ${mdFiles.length} tutorial .md files in cache`);

    let inserted = 0;
    let skipped = 0;
    const BATCH_SIZE = 50;
    let batch = [];

    for (let i = 0; i < mdFiles.length; i++) {
      const file = mdFiles[i];
      const slug = path.basename(file, '.md');
      const content = fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8');
      const fm = parseFrontmatter(content);
      const title = extractTitle(content) || slug;
      const primaryTag = fm.primary_tag || fm.primaryTag || null;
      const experienceTag = extractExperienceTag(fm.tags) || 'beginner';
      const time = parseInt(fm.time, 10) || null;
      const legacyId = 20000 + i;

      batch.push([uuid(), legacyId, slug, title, primaryTag, experienceTag, time, 'ACTIVE']);

      if (batch.length >= BATCH_SIZE) {
        if (!dryRun) {
          for (const row of batch) {
            await db.run(
              `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALS" ("ID", "LEGACYID", "SLUG", "TITLE", "PRIMARYTAG", "EXPERIENCETAG", "AVERAGETIMETOCOMPLETE", "STATUS") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              row
            );
          }
        }
        inserted += batch.length;
        process.stdout.write(`  ${inserted} inserted...\r`);
        batch = [];
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      if (!dryRun) {
        for (const row of batch) {
          await db.run(
            `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALS" ("ID", "LEGACYID", "SLUG", "TITLE", "PRIMARYTAG", "EXPERIENCETAG", "AVERAGETIMETOCOMPLETE", "STATUS") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            row
          );
        }
      }
      inserted += batch.length;
    }

    console.log(`  ${dryRun ? 'Would insert' : 'Inserted'} ${inserted} tutorials`);
  }

  // --- Summary ---
  if (!dryRun) {
    console.log('\n=== Summary ===');
    const [tags] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_TAGS"');
    const [tutorials] = await db.run('SELECT COUNT(*) AS "C" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"');
    console.log(`  Tags: ${tags.C}`);
    console.log(`  Tutorials: ${tutorials.C}`);
  }

  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

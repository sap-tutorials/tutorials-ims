/**
 * cleanup-catalog-pollution.cjs — One-shot cleanup for issue #114.
 *
 * Removes phantom Tutorials and ContentFiles rows whose slug starts with
 * "group-" or "mission-". Such rows were created by older runs of
 * publish-content (before PR #115 moved catalog pages to runtime SSR) when
 * stale "group-" / "mission-" directories left behind in
 * hugo/public/tutorials/ leaked into the publish payload. The new
 * content-store + publish-content filters block recurrence going forward;
 * this script cleans up what already landed.
 *
 * Operations (in order, all idempotent):
 *   1. Drop ContentFiles rows where slug starts with group-/mission-.
 *      Each is a duplicate of catalog data sourced from Groups/Missions.
 *   2. Drop Tutorials rows with the same slug shape. These are the rows
 *      that show up in the Admin UI Tutorials list with empty Tutorial ID.
 *   3. Print remaining counts so the operator can confirm the prod fix.
 *
 * It is safe to run multiple times.
 *
 * Prerequisites:
 *   - `cf login` to the target space
 *   - `cds bind --to tutorials-db` (creates .cdsrc-private.json with HANA
 *     binding) — or run with `--exec` against any deployed env you can reach.
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/cleanup-catalog-pollution.cjs
 *
 * Flags:
 *   --dry-run    Show counts without deleting
 *   --local      Also delete stale "group-*.md" and "mission-*.md" files in
 *                hugo/content/tutorials/ in the working tree (no DB needed).
 */

const cds = require('@sap/cds');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const local = args.includes('--local');

const NAMESPACE = 'com.sap.developers.ims';

async function cleanLocalHugoFiles() {
  const root = path.join(__dirname, '..');

  // 1) Source markdown that older fetch-tutorials runs emitted.
  const contentDir = path.join(root, 'hugo', 'content', 'tutorials');
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(contentDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const entry of entries) {
    if (!entry.startsWith('group-') && !entry.startsWith('mission-')) continue;
    if (!entry.endsWith('.md')) continue;
    const full = path.join(contentDir, entry);
    if (dryRun) {
      console.log(`  [dry-run] would delete ${full}`);
    } else {
      fs.unlinkSync(full);
      console.log(`  deleted ${full}`);
    }
    removed++;
  }

  // 2) Built output Hugo writes for those source files. publish-content
  //    reads from here, so we sweep here too.
  const publicDir = path.join(root, 'hugo', 'public', 'tutorials');
  let publicEntries = [];
  try {
    publicEntries = fs.readdirSync(publicDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const entry of publicEntries) {
    if (!entry.startsWith('group-') && !entry.startsWith('mission-')) continue;
    const full = path.join(publicDir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (dryRun) {
      console.log(`  [dry-run] would rmdir ${full}`);
    } else {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`  rmdir ${full}`);
    }
    removed++;
  }

  console.log(`Local Hugo sweep: ${removed} entr${removed === 1 ? 'y' : 'ies'} ${dryRun ? 'would be' : 'were'} removed.`);
}

(async () => {
  if (local) {
    await cleanLocalHugoFiles();
    // --local on its own (no bound DB) is a quick local-only hygiene step.
    // Skip the DB section unless we're bound to a real persistent DB. The
    // default is in-memory sqlite which has nothing to clean and would only
    // confuse the operator.
    const dbProfile = cds.env.requires?.db;
    const persistent = dbProfile?.kind === 'hana'
      || (dbProfile?.kind === 'sqlite' && dbProfile?.credentials?.url
        && dbProfile.credentials.url !== ':memory:');
    if (!persistent) {
      console.log('No persistent DB binding detected — skipping HANA cleanup. ' +
        'Run via `cds bind --exec` against DEV/PROD to also clean the DB.');
      process.exit(0);
    }
  }

  await cds.load('*');
  const db = await cds.connect.to('db');
  const { Tutorials, ContentFiles } = cds.entities(NAMESPACE);

  if (dryRun) console.log('=== DRY RUN — no DB changes will be made ===\n');

  // --- 1. ContentFiles ---
  const cfRows = await SELECT.from(ContentFiles)
    .columns('slug', 'version')
    .where(`slug like 'group-%' or slug like 'mission-%'`);
  const cfBySlug = new Map();
  for (const row of cfRows) {
    if (!cfBySlug.has(row.slug)) cfBySlug.set(row.slug, 0);
    cfBySlug.set(row.slug, cfBySlug.get(row.slug) + 1);
  }
  console.log(`ContentFiles to drop: ${cfRows.length} row(s) across ${cfBySlug.size} slug(s)`);
  for (const [slug, count] of cfBySlug) {
    console.log(`  ${slug}: ${count} row(s)`);
  }
  if (!dryRun && cfRows.length) {
    await DELETE.from(ContentFiles)
      .where(`slug like 'group-%' or slug like 'mission-%'`);
    console.log(`  → deleted.`);
  }

  // --- 2. Tutorials ---
  const tutRows = await SELECT.from(Tutorials)
    .columns('ID', 'slug', 'title', 'legacyId')
    .where(`slug like 'group-%' or slug like 'mission-%'`);
  console.log(`\nTutorials phantom rows to drop: ${tutRows.length}`);
  for (const row of tutRows) {
    console.log(`  ${row.slug}  title=${JSON.stringify(row.title)}  legacyId=${row.legacyId ?? 'null'}`);
  }
  if (!dryRun && tutRows.length) {
    // Cascade: a phantom Tutorials row could have spawned Steps, TutorialMeta,
    // etc. via publish-content. Delete the Tutorials row by ID and let CAP's
    // composition cascade clean up the children.
    for (const row of tutRows) {
      await DELETE.from(Tutorials).where({ ID: row.ID });
    }
    console.log(`  → deleted.`);
  }

  // --- 3. Confirm ---
  const remainingCf = await SELECT.from(ContentFiles)
    .columns('slug')
    .where(`slug like 'group-%' or slug like 'mission-%'`);
  const remainingTut = await SELECT.from(Tutorials)
    .columns('slug')
    .where(`slug like 'group-%' or slug like 'mission-%'`);
  console.log(`\nRemaining catalog-shaped slugs:  ContentFiles=${remainingCf.length}  Tutorials=${remainingTut.length}`);
  if (remainingCf.length || remainingTut.length) {
    console.log('  (dry-run leaves these in place; rerun without --dry-run to delete.)');
  }

  console.log('\nDone.');
  process.exit(0);
})().catch((err) => {
  console.error('cleanup-catalog-pollution failed:', err);
  process.exit(1);
});

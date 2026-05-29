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
 *   2. Drop Tutorials rows with the same slug shape, plus their dependents
 *      (Steps, TutorialMeta, TutorialContributors, TutorialRepositories,
 *       TutorialTags, TutorialEmbedding, TutorialBodyText,
 *       TutorialFeedback). These are the rows that show up in the Admin UI
 *      Tutorials list with empty Tutorial ID.
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

  // Use raw SQL with the underscore-flattened HANA table names (matches the
  // setup-dev-data.cjs pattern). cds.entities() is a runtime-only helper
  // and is undefined in plain CJS scripts; CAP's CQL composition cascade
  // is also not enough here since we want to sweep slug-keyed siblings
  // (TutorialBodyText, TutorialFeedback) the same pass.
  await cds.load('*');
  const db = await cds.connect.to('db');

  if (dryRun) console.log('=== DRY RUN — no DB changes will be made ===\n');

  const T = (name) => `COM_SAP_DEVELOPERS_IMS_${name.toUpperCase()}`;
  const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

  // --- 1. ContentFiles (slug-keyed) ---
  const cfRows = await db.run(
    `SELECT "SLUG", COUNT(*) AS "C" FROM "${T('ContentFiles')}"
       WHERE "SLUG" LIKE 'group-%' OR "SLUG" LIKE 'mission-%'
       GROUP BY "SLUG"`
  );
  const cfTotal = cfRows.reduce((sum, r) => sum + Number(r.C), 0);
  console.log(`ContentFiles to drop: ${cfTotal} row(s) across ${cfRows.length} slug(s)`);
  for (const r of cfRows) console.log(`  ${r.SLUG}: ${r.C} row(s)`);
  if (!dryRun && cfTotal > 0) {
    await db.run(
      `DELETE FROM "${T('ContentFiles')}"
         WHERE "SLUG" LIKE 'group-%' OR "SLUG" LIKE 'mission-%'`
    );
    console.log('  → deleted.');
  }

  // --- 2. Tutorials phantom rows + their dependents ---
  const tutRows = await db.run(
    `SELECT "ID", "SLUG", "TITLE", "LEGACYID" FROM "${T('Tutorials')}"
       WHERE "SLUG" LIKE 'group-%' OR "SLUG" LIKE 'mission-%'`
  );
  console.log(`\nTutorials phantom rows to drop: ${tutRows.length}`);
  for (const r of tutRows) {
    console.log(`  ${r.SLUG}  title=${JSON.stringify(r.TITLE)}  legacyId=${r.LEGACYID ?? 'null'}`);
  }

  if (!dryRun && tutRows.length) {
    const ids = tutRows.map((r) => r.ID);
    const slugs = tutRows.map((r) => r.SLUG);

    // FK-by-tutorial_ID children — delete first so the parent row drops
    // cleanly without FK-violation noise even where the schema enforces it.
    const childTablesById = [
      'Steps',
      'TutorialMeta',
      'TutorialContributors',
      'TutorialRepositories',
      'TutorialTags',
      'TutorialEmbedding',
    ];
    for (const tbl of childTablesById) {
      try {
        await db.run(
          `DELETE FROM "${T(tbl)}" WHERE "TUTORIAL_ID" IN (${placeholders(ids.length)})`,
          ids
        );
        console.log(`  swept ${T(tbl)} for ${ids.length} tutorial id(s)`);
      } catch (err) {
        // Some children may legitimately not exist yet on a particular
        // env (e.g. TutorialEmbedding pre-migration). Log and continue.
        console.warn(`  ${T(tbl)}: skipped — ${err.message}`);
      }
    }

    // Slug-keyed siblings.
    const slugTables = [
      { tbl: 'TutorialBodyText', col: 'SLUG' },
      { tbl: 'TutorialFeedback', col: 'TUTORIALSLUG' },
    ];
    for (const { tbl, col } of slugTables) {
      try {
        await db.run(
          `DELETE FROM "${T(tbl)}" WHERE "${col}" IN (${placeholders(slugs.length)})`,
          slugs
        );
        console.log(`  swept ${T(tbl)} for ${slugs.length} slug(s)`);
      } catch (err) {
        console.warn(`  ${T(tbl)}: skipped — ${err.message}`);
      }
    }

    // Finally, the phantom Tutorials rows themselves.
    await db.run(
      `DELETE FROM "${T('Tutorials')}" WHERE "ID" IN (${placeholders(ids.length)})`,
      ids
    );
    console.log('  → Tutorials rows deleted.');
  }

  // --- 3. Confirm ---
  const [{ C: remCf }] = await db.run(
    `SELECT COUNT(*) AS "C" FROM "${T('ContentFiles')}"
       WHERE "SLUG" LIKE 'group-%' OR "SLUG" LIKE 'mission-%'`
  );
  const [{ C: remTut }] = await db.run(
    `SELECT COUNT(*) AS "C" FROM "${T('Tutorials')}"
       WHERE "SLUG" LIKE 'group-%' OR "SLUG" LIKE 'mission-%'`
  );
  console.log(`\nRemaining catalog-shaped slugs:  ContentFiles=${remCf}  Tutorials=${remTut}`);
  if (Number(remCf) || Number(remTut)) {
    console.log('  (dry-run leaves these in place; rerun without --dry-run to delete.)');
  }

  console.log('\nDone.');
  process.exit(0);
})().catch((err) => {
  console.error('cleanup-catalog-pollution failed:', err);
  process.exit(1);
});

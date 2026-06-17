/* eslint-disable no-console */
/**
 * One-shot repair for duplicate slugs in Tutorials, Missions, and Groups.
 *
 * Background: the 2026-06-16 cutover rehearsal of scripts/migrate-from-hana.js
 * inserted rows whose SLUG had a `.md` suffix; the publish path's
 * LOWER(slug)=? lookup did not match those, so it INSERTed a duplicate.
 * A subsequent bulk UPDATE stripped `.md` from the migrated rows, leaving
 * 123 dup-groups in Tutorials.
 *
 * Strategy per dup-group:
 *   1. Pick the publish-side row as the WINNER (it has fresh stepCount,
 *      lowercase experienceTag, slug-format primaryTag — what the live
 *      site needs).
 *   2. Copy LEGACY-ONLY non-null fields (legacyId, mdFileUrl, featuredOrder,
 *      description, redirectTo_ID) from the loser onto the winner if the
 *      winner's value is null. Without this, the 3000+ TaskRecords keyed on
 *      taskLegacyId would orphan.
 *   3. Redirect every FK column in the project from loser.ID → winner.ID.
 *   4. Delete the loser.
 *
 * Modes:
 *   --dry-run     (default) — print every planned change, write nothing.
 *   --commit               — execute. Refuses to run without a fresh snapshot.
 *   --verify-only          — print remaining dup-groups, exit 0/2.
 *   --table=tutorials      — restrict to one of: tutorials | missions | groups.
 *
 * Run via:  npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(
  SNAPSHOT_DIR,
  `dup-merge-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
);
let snapshotInited = false;
function appendSnapshot(record) {
  if (!snapshotInited) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    snapshotInited = true;
  }
  fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(record) + '\n');
}

async function ensureSnapshot(db, I, table, rows, losers, fkList) {
  // Snapshot every row in the dup-group (winner + losers) so a full revert
  // can both re-INSERT loser rows AND see the winner state at merge time.
  for (const r of rows) {
    appendSnapshot({ kind: 'row', table: I.tables[table], data: r });
  }
  // Snapshot only the FK rows pointing at LOSERS — those are the rows the
  // merge will redirect to the winner. Winner-attached children stay put,
  // so including them would muddy the rollback contract (a `kind: 'fk'`
  // line means "this row was redirected away from fromId").
  //
  // Note on payload fidelity: SELECT * returns row data verbatim. Most
  // columns round-trip cleanly through JSON.stringify, but specialty HANA
  // types (e.g. Vector(N) on TutorialEmbedding) may not. For the current
  // dup-set the loser is always the legacy migration row which has no
  // TutorialEmbedding row, so this is moot — but a future use of this
  // script against a different dup-set should verify Vector serialisation
  // before relying on the snapshot for full revert.
  for (const [tbl, col] of fkList) {
    for (const loser of losers) {
      const refs = await db.run(`SELECT * FROM ${tbl} WHERE ${col} = ?`, [loser.ID]);
      for (const ref of refs) {
        appendSnapshot({ kind: 'fk', table: tbl, col, fromId: loser.ID, data: ref });
      }
    }
  }
}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const VERIFY_ONLY = argv.includes('--verify-only');
const DRY_RUN = argv.includes('--dry-run');
const TABLE_FILTER = (argv.find(a => a.startsWith('--table=')) || '').split('=')[1];
if (COMMIT && VERIFY_ONLY) {
  console.error('--commit and --verify-only are mutually exclusive');
  process.exit(1);
}
if (COMMIT && DRY_RUN) {
  console.error('--commit and --dry-run are mutually exclusive');
  process.exit(1);
}

// Dialect identifiers: HANA only. Throw if SQLite — running this against
// the in-memory dev DB makes no sense.
function ident() {
  return {
    tables: {
      tutorials: '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"',
      missions:  '"COM_SAP_DEVELOPERS_IMS_MISSIONS"',
      groups:    '"COM_SAP_DEVELOPERS_IMS_GROUPS"',
    },
    cols: {
      id: '"ID"',
      slug: '"SLUG"',
      createdAt: '"CREATEDAT"',
      createdBy: '"CREATEDBY"',
      legacyId: '"LEGACYID"',
    },
  };
}

// FK columns referencing Tutorials.ID / Missions.ID / Groups.ID, probed
// live 2026-06-17. If you add a new entity that associates to one of these,
// extend this map AND test/hybrid/duplicate-slugs.test.js.
const FK_REDIRECTS = {
  tutorials: [
    ['"COM_SAP_DEVELOPERS_IMS_CODECHECKSPECS"',         '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"',    '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS"',         '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_STEPS"',                  '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALCATEGORIES"',     '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS"',   '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"',      '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"',           '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES"',   '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALS"',              '"REDIRECTTO_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS"',           '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_VALIDATEANSWERSPECS"',    '"TUTORIAL_ID"'],
  ],
  missions: [
    ['"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"',        '"MISSION_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_EVENTS"',                 '"MISSION_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_MISSIONCATEGORIES"',      '"MISSION_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_MISSIONSLUGREDIRECTS"',   '"MISSION_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_MISSIONTAGS"',            '"MISSION_ID"'],
  ],
  groups: [
    ['"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"',    '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPCATEGORIES"',        '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS"',         '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPSLUGREDIRECTS"',     '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPTAGS"',              '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_MISSIONS"',               '"GROUP_ID"'],
  ],
};

// Columns we copy from loser → winner if winner's value is null. Each entry
// is [column-name, treat-zero-as-null]. legacyId is the critical one.
const CARRY_FORWARD = {
  tutorials: [
    ['"LEGACYID"', false],
    ['"MDFILEURL"', false],
    ['"FEATUREDORDER"', false],
    ['"DESCRIPTION"', false],
    ['"REDIRECTTO_ID"', false],
  ],
  missions: [['"LEGACYID"', false], ['"DESCRIPTION"', false], ['"GROUP_ID"', false]],
  groups:   [['"LEGACYID"', false], ['"DESCRIPTION"', false]],
};

async function main() {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }
  if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);
  const I = ident();
  // Order matters: groups must be merged BEFORE missions (Missions.GROUP_ID
  // is a carry-forward field for missions, so group-loser IDs must already
  // be redirected when we evaluate that carry-forward), and missions before
  // tutorials by symmetry. The default reflects this — do not flip.
  const tables = TABLE_FILTER ? [TABLE_FILTER] : ['groups', 'missions', 'tutorials'];
  for (const t of tables) {
    if (!I.tables[t]) {
      console.error(`Unknown --table=${t}. Pick one of tutorials, missions, groups.`);
      process.exit(1);
    }
  }

  if (VERIFY_ONLY) {
    let total = 0;
    for (const t of tables) {
      const dups = await findDups(db, I, t);
      console.log(`${t}: ${dups.length} dup-group(s)`);
      total += dups.length;
    }
    process.exit(total === 0 ? 0 : 2);
  }

  // Dry-run / commit path
  const summary = { tables: {} };
  for (const t of tables) {
    summary.tables[t] = await processTable(db, I, t, COMMIT);
  }
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (!COMMIT) {
    console.log('\nDry-run complete. Re-run with --commit to apply.');
  }
}

async function findDups(db, I, table) {
  return db.run(`
    SELECT LOWER(${I.cols.slug}) AS S, COUNT(*) AS C
      FROM ${I.tables[table]}
     WHERE ${I.cols.slug} IS NOT NULL
     GROUP BY LOWER(${I.cols.slug})
    HAVING COUNT(*) > 1
     ORDER BY S
  `);
}

async function processTable(db, I, table, commit) {
  const dups = await findDups(db, I, table);
  console.log(`\n--- ${table}: ${dups.length} dup-group(s) ---`);
  let merged = 0;
  let casingChecked = false;
  for (const g of dups) {
    const slug = g.S;
    const rows = await db.run(
      `SELECT * FROM ${I.tables[table]} WHERE LOWER(${I.cols.slug}) = ?`,
      [slug]
    );

    // One-time sanity check: every column lookup in this script assumes
    // the HANA driver returns row keys in UPPERCASE (because we SELECT
    // from a quoted upper-case table). If the keys come back lowercase,
    // we are connected to SQLite by accident — fail loud.
    if (!casingChecked && rows.length > 0) {
      casingChecked = true;
      const keys = Object.keys(rows[0]);
      if (!keys.includes('ID') || !keys.includes('SLUG')) {
        throw new Error(
          `Row keys are not uppercase as expected. Got: ${keys.join(', ')}\n` +
          `Are you connected to HANA? Run with: cds bind --exec -- node ...`
        );
      }
    }

    // Winner = the row whose CREATEDBY = 'anonymous' (publish path).
    // Fallback: newest CREATEDAT.
    const publishRows = rows.filter(r => r.CREATEDBY === 'anonymous');
    const winner = publishRows.length === 1
      ? publishRows[0]
      : rows.slice().sort((a, b) => (b.CREATEDAT > a.CREATEDAT ? 1 : -1))[0];
    const losers = rows.filter(r => r.ID !== winner.ID);

    console.log(`  slug=${slug}: winner=${winner.ID.slice(0,8)} losers=[${losers.map(l => l.ID.slice(0,8)).join(',')}]`);

    // Pre-merge snapshot: every row about to be touched, plus every FK row
    // about to be redirected. Written once per run, append-mode.
    if (commit) await ensureSnapshot(db, I, table, rows, losers, FK_REDIRECTS[table]);

    // Step 2.1.x is implemented in subsequent steps. Dry-run prints the plan.
    if (!commit) continue;

    // (Commit logic added in later steps)
    throw new Error('Commit mode not yet implemented; rebuild after step 2.3');
  }
  return { dupCount: dups.length, merged };
}

main().catch(e => { console.error(e); process.exit(1); });

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
  for (const fk of fkList) {
    for (const loser of losers) {
      const refs = await db.run(`SELECT * FROM ${fk.tbl} WHERE ${fk.col} = ?`, [loser.ID]);
      for (const ref of refs) {
        appendSnapshot({ kind: 'fk', table: fk.tbl, col: fk.col, fromId: loser.ID, data: ref });
      }
    }
  }
}

// Redirect a composite-PK FK column from loserId -> winnerId. Loser rows whose
// other-key tuple already exists on the winner side are DELETED (winner is
// canonical: the loser data is from a stale migration that was superseded by
// the publish path). Other loser rows are UPDATEd as in the simple path.
//
// otherKeys is an array of QUOTED column names for the rest of the composite PK.
async function redirectFkSafe(tx, tbl, col, otherKeys, loserId, winnerId) {
  // 1. Read winner's existing other-key tuples.
  const otherCols = otherKeys.join(', ');
  const winnerRows = await tx.run(
    `SELECT ${otherCols} FROM ${tbl} WHERE ${col} = ?`,
    [winnerId]
  );
  // Stringify the other-key tuple for set membership lookup.
  const winnerKeys = new Set(
    winnerRows.map(r => otherKeys.map(k => r[k.replace(/"/g, '')]).join('\x00'))
  );

  // 2. Read loser's rows; partition into to-delete vs to-update.
  const loserRows = await tx.run(
    `SELECT ${otherCols} FROM ${tbl} WHERE ${col} = ?`,
    [loserId]
  );
  const toDelete = [];
  const toRedirect = [];
  for (const r of loserRows) {
    const k = otherKeys.map(c => r[c.replace(/"/g, '')]).join('\x00');
    if (winnerKeys.has(k)) toDelete.push(r);
    else toRedirect.push(r);
  }

  // 3. DELETE the colliders. We delete by composite key (col + otherKeys) so
  //    we never affect rows already on the winner.
  for (const r of toDelete) {
    const whereParts = [`${col} = ?`, ...otherKeys.map(k => `${k} = ?`)];
    const params = [loserId, ...otherKeys.map(k => r[k.replace(/"/g, '')])];
    await tx.run(`DELETE FROM ${tbl} WHERE ${whereParts.join(' AND ')}`, params);
  }

  // 4. UPDATE the survivors.
  if (toRedirect.length > 0) {
    await tx.run(
      `UPDATE ${tbl} SET ${col} = ? WHERE ${col} = ?`,
      [winnerId, loserId]
    );
  }

  // Return summary for logging — total rows acted on and how many were dropped.
  return { redirected: toRedirect.length, dropped: toDelete.length };
}

// Redirect a "logical singleton" FK column (e.g. TutorialMeta) where the
// parent should have exactly one child row. If the winner already has a
// child, DELETE the loser's child(ren) — the winner's row is canonical.
// If the winner has no child, UPDATE the loser's row to point at winner.
//
// This avoids the post-merge state of two singleton rows per parent that
// would otherwise occur with kind:'simple' on TutorialMeta etc.
async function redirectFkSingleton(tx, tbl, col, loserId, winnerId) {
  const winnerRows = await tx.run(`SELECT "ID" FROM ${tbl} WHERE ${col} = ?`, [winnerId]);
  if (winnerRows.length === 0) {
    // Winner has no row — promote the loser's row.
    const r = await tx.run(`UPDATE ${tbl} SET ${col} = ? WHERE ${col} = ?`, [winnerId, loserId]);
    return { redirected: typeof r === 'number' ? r : 0, dropped: 0 };
  }
  // Winner already has a row — drop loser's row(s).
  const loserRows = await tx.run(`SELECT "ID" FROM ${tbl} WHERE ${col} = ?`, [loserId]);
  for (const r of loserRows) {
    await tx.run(`DELETE FROM ${tbl} WHERE "ID" = ?`, [r.ID]);
  }
  return { redirected: 0, dropped: loserRows.length };
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
//
// Each entry: { tbl, col, kind, otherKeys? }
//   kind: 'simple'        — naive UPDATE works (cuid PK on the ID column)
//   kind: 'composite-pk'  — composite PK on (col, ...otherKeys); use redirectFkSafe()
const FK_REDIRECTS = {
  tutorials: [
    { tbl: '"COM_SAP_DEVELOPERS_IMS_CODECHECKSPECS"',       col: '"TUTORIAL_ID"',   kind: 'composite-pk', otherKeys: ['"STEPNUMBER"'] },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"',  col: '"TUTORIAL_ID"',   kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS"',       col: '"TUTORIAL_ID"',   kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_STEPS"',                col: '"TUTORIAL_ID"',   kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_TUTORIALCATEGORIES"',   col: '"TUTORIAL_ID"',   kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS"', col: '"TUTORIAL_ID"',   kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"',    col: '"TUTORIAL_ID"',   kind: 'composite-pk', otherKeys: ['"STEPNUMBER"'] },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"',         col: '"TUTORIAL_ID"',   kind: 'singleton' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES"', col: '"TUTORIAL_ID"',   kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"',            col: '"REDIRECTTO_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS"',         col: '"TUTORIAL_ID"',   kind: 'composite-pk', otherKeys: ['"TAG_ID"'] },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_VALIDATEANSWERSPECS"',  col: '"TUTORIAL_ID"',   kind: 'composite-pk', otherKeys: ['"STEPNUMBER"', '"QUESTIONID"'] },
  ],
  missions: [
    { tbl: '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"',      col: '"MISSION_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_EVENTS"',               col: '"MISSION_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_MISSIONCATEGORIES"',    col: '"MISSION_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_MISSIONSLUGREDIRECTS"', col: '"MISSION_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_MISSIONTAGS"',          col: '"MISSION_ID"', kind: 'composite-pk', otherKeys: ['"TAG_ID"'] },
  ],
  groups: [
    { tbl: '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"',  col: '"GROUP_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_GROUPCATEGORIES"',      col: '"GROUP_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS"',       col: '"GROUP_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_GROUPSLUGREDIRECTS"',   col: '"GROUP_ID"', kind: 'simple' },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_GROUPTAGS"',            col: '"GROUP_ID"', kind: 'composite-pk', otherKeys: ['"TAG_ID"'] },
    { tbl: '"COM_SAP_DEVELOPERS_IMS_MISSIONS"',             col: '"GROUP_ID"', kind: 'simple' },
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
  // Pre-compute the full loser set across this table so the carry-forward
  // step can detect self-references that would dangle after deletion.
  // Self-ref columns we care about: Tutorials.REDIRECTTO_ID, Missions.GROUP_ID.
  const allLoserIds = new Set();
  const allLoserIdToWinnerId = new Map();
  for (const g of dups) {
    const slug = g.S;
    const rs = await db.run(
      `SELECT ${I.cols.id}, ${I.cols.createdBy}, ${I.cols.createdAt}
         FROM ${I.tables[table]} WHERE LOWER(${I.cols.slug}) = ?`,
      [slug]
    );
    const pubRows = rs.filter(r => r.CREATEDBY === 'anonymous');
    const w = pubRows.length === 1
      ? pubRows[0]
      : rs.slice().sort((a, b) => (b.CREATEDAT > a.CREATEDAT ? 1 : -1))[0];
    for (const r of rs) {
      if (r.ID !== w.ID) {
        allLoserIds.add(r.ID);
        allLoserIdToWinnerId.set(r.ID, w.ID);
      }
    }
  }
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

    if (!commit) continue;

    // KEY-CASING NOTE: every SELECT in this script targets a quoted
    // upper-case table name (e.g. "COM_SAP_DEVELOPERS_IMS_TUTORIALS").
    // HANA preserves case for quoted identifiers, so result rows always
    // come back keyed UPPERCASE: r.ID, r.SLUG, r.LEGACYID, r.CREATEDAT,
    // etc. Sanity-check this once on first run with:
    //     console.log(Object.keys(rows[0]));
    // If the keys come back lowercase, the script is connected to SQLite
    // (e.g. accidentally without `cds bind --exec`) — abort.
    const colKey = (q) => q.replace(/"/g, '');  // '"LEGACYID"' -> 'LEGACYID'

    // Wrap the per-slug merge in a transaction so a mid-merge failure
    // leaves the original row pair intact rather than half-redirecting
    // FKs and then crashing.
    await db.tx(async tx => {

      // 1. Carry forward legacy-only fields. This is the critical step:
      //    TaskRecords are keyed on legacyId (numeric), not tutorial_ID.
      //    Without this, every user's progress history orphans.
      //
      //    Edge case: the carried-forward column may itself be a self-ref
      //    (e.g. Tutorials.REDIRECTTO_ID) pointing at another loser ID
      //    that gets deleted later in this same run. Map donor's value
      //    through the loser-set so we never carry a dangling reference.
      const sets = [];
      const params = [];
      for (const [colQ] of CARRY_FORWARD[table]) {
        const colName = colKey(colQ);
        const donor = losers.find(l => l[colName] !== null && l[colName] !== undefined);
        const winnerVal = winner[colName];
        if (!donor) continue;
        if (winnerVal !== null && winnerVal !== undefined) continue;

        let donorVal = donor[colName];

        // If the donor value is itself a loser ID we are about to delete,
        // remap it to that loser's winner. For the simple two-row dup-group
        // case this collapses to a self-loop — null it out instead of
        // pointing at the winner row itself.
        if (typeof donorVal === 'string' && allLoserIds.has(donorVal)) {
          const target = allLoserIdToWinnerId.get(donorVal);
          donorVal = (target === winner.ID) ? null : target;
        }

        sets.push(`${colQ} = ?`);
        params.push(donorVal);
      }
      if (sets.length > 0) {
        params.push(winner.ID);
        await tx.run(
          `UPDATE ${I.tables[table]} SET ${sets.join(', ')} WHERE ${I.cols.id} = ?`,
          params
        );
      }

      // 2. Redirect every FK column from loser.ID -> winner.ID. CAP doesn't
      //    emit DB-level FK constraints (verified via SYS.REFERENTIAL_CONSTRAINTS),
      //    so plain UPDATE works without cascade fights.
      //    Tables with single-column PK on `ID` (cuid) take the simple UPDATE path.
      //    Tables with composite PK including the FK col use redirectFkSafe(),
      //    which DELETEs loser rows that would collide with existing winner rows
      //    on the other-key tuple (e.g. (tutorial_ID, stepNumber) in
      //    TutorialEmbedding) and UPDATEs the rest.
      for (const loser of losers) {
        for (const fk of FK_REDIRECTS[table]) {
          if (fk.kind === 'simple') {
            const r = await tx.run(
              `UPDATE ${fk.tbl} SET ${fk.col} = ? WHERE ${fk.col} = ?`,
              [winner.ID, loser.ID]
            );
            if (typeof r === 'number' && r > 50) {
              console.log(`    ${fk.tbl}.${fk.col}: ${r} rows`);
            }
          } else if (fk.kind === 'composite-pk') {
            const summary = await redirectFkSafe(tx, fk.tbl, fk.col, fk.otherKeys, loser.ID, winner.ID);
            if (summary.dropped > 0 || summary.redirected > 50) {
              console.log(`    ${fk.tbl}.${fk.col}: redirected=${summary.redirected} dropped=${summary.dropped}`);
            }
          } else if (fk.kind === 'singleton') {
            const summary = await redirectFkSingleton(tx, fk.tbl, fk.col, loser.ID, winner.ID);
            if (summary.dropped > 0 || summary.redirected > 50) {
              console.log(`    ${fk.tbl}.${fk.col}: redirected=${summary.redirected} dropped=${summary.dropped}`);
            }
          } else {
            throw new Error(`Unknown FK redirect kind: ${fk.kind} for ${fk.tbl}`);
          }
        }
      }

      // 3. Delete the loser row(s). At this point nothing references them.
      for (const loser of losers) {
        await tx.run(
          `DELETE FROM ${I.tables[table]} WHERE ${I.cols.id} = ?`,
          [loser.ID]
        );
      }
    });

    merged++;
  }
  return { dupCount: dups.length, merged };
}

main().catch(e => { console.error(e); process.exit(1); });

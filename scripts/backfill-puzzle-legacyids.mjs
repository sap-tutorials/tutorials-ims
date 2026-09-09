// scripts/backfill-puzzle-legacyids.mjs
//
// One-time (idempotent) backfill for issue #2185.
//
// Admin-authored puzzles were created with a NULL legacyId (the #436
// draft-lifecycle bug, never extended to Puzzles). Their PUZZLE TaskRecords
// were therefore written with taskLegacyId=NULL and are silently dropped from
// My Completions (srv/lib/user-progress.js) and the Devtoberfest points path.
//
// This script, run AFTER the code fix is deployed (so the PUZZLES sequence
// exists in HANA):
//   1. Assigns a legacyId (from COM_SAP_DEVELOPERS_IMS_PUZZLES_SEQ) to every
//      Puzzles row whose legacyId IS NULL.
//   2. Relinks orphaned PUZZLE TaskRecords (taskLegacyId IS NULL) to the newly
//      assigned puzzle legacyId by matching titleSnapshot === puzzle.title.
//
// Safe to re-run: puzzles that already have a legacyId are skipped, and only
// TaskRecords still carrying NULL taskLegacyId are touched. If a titleSnapshot
// maps to zero or more-than-one NULL-legacyId puzzle, those records are left
// untouched and reported (no ambiguous guesses).
//
// Usage (against a bound HANA):
//   cds bind --exec -- node scripts/backfill-puzzle-legacyids.mjs           # dry run (default)
//   cds bind --exec -- node scripts/backfill-puzzle-legacyids.mjs --apply   # perform writes
//   cds bind --exec --profile hybrid-prod -- node scripts/backfill-puzzle-legacyids.mjs --apply
//
// NOTE: does NOT recompute parent mission/group rollups. The affected puzzles
// are standalone (not mission items). If a backfilled puzzle is later found to
// be a mission item, re-run the completion rollup separately.

import cds from '@sap/cds';
import { getNextLegacyId } from '../srv/lib/legacy-id.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const db = await cds.connect.to('db');

  // Robust entity resolution across booted-server and standalone
  // `cds bind --exec` contexts (same gotcha as seed-poc-puzzle.js).
  let Puzzles, TaskRecords;
  if (typeof cds.entities === 'function' && cds.model) {
    ({ Puzzles, TaskRecords } = cds.entities('com.sap.developers.ims'));
  } else {
    const linked = cds.linked(await cds.load('*'));
    ({ Puzzles, TaskRecords } = linked.entities('com.sap.developers.ims'));
  }

  const mode = APPLY ? 'APPLY' : 'DRY RUN';
  console.log(`\n=== Puzzle legacyId backfill (${mode}) ===\n`);

  // 1) Puzzles missing a legacyId.
  const nullPuzzles = await SELECT.from(Puzzles)
    .columns('ID', 'slug', 'title', 'legacyId')
    .where({ legacyId: null });

  if (nullPuzzles.length === 0) {
    console.log('No puzzles with NULL legacyId — nothing to assign.');
  }

  // title -> count, to detect ambiguous titleSnapshot matches.
  const titleCounts = nullPuzzles.reduce((m, p) => {
    m.set(p.title, (m.get(p.title) || 0) + 1);
    return m;
  }, new Map());

  const assigned = []; // { slug, title, legacyId }
  for (const p of nullPuzzles) {
    const newId = APPLY ? await getNextLegacyId('Puzzles', db) : '(next-seq)';
    if (APPLY) {
      await UPDATE(Puzzles).set({ legacyId: newId }).where({ ID: p.ID });
    }
    assigned.push({ slug: p.slug, title: p.title, legacyId: newId });
    console.log(`  puzzle "${p.slug}" (title="${p.title}") -> legacyId ${newId}`);
  }

  // 2) Relink orphaned PUZZLE TaskRecords by titleSnapshot === puzzle.title.
  console.log('\n--- Orphaned PUZZLE TaskRecords (taskLegacyId IS NULL) ---');
  const orphans = await SELECT.from(TaskRecords)
    .columns('ID', 'titleSnapshot', 'status', 'completionDate')
    .where({ taskType: 'PUZZLE', taskLegacyId: null });

  console.log(`  found ${orphans.length} orphaned PUZZLE records`);

  let relinked = 0;
  const skipped = [];
  for (const r of orphans) {
    const matches = assigned.filter(a => a.title === r.titleSnapshot);
    if (matches.length !== 1 || titleCounts.get(r.titleSnapshot) !== 1) {
      skipped.push({ ID: r.ID, titleSnapshot: r.titleSnapshot, reason: matches.length === 0 ? 'no matching puzzle' : 'ambiguous title' });
      continue;
    }
    const target = matches[0];
    if (APPLY) {
      await UPDATE(TaskRecords).set({ taskLegacyId: target.legacyId }).where({ ID: r.ID });
    }
    relinked++;
    console.log(`  record ${r.ID} (${r.status}, "${r.titleSnapshot}") -> taskLegacyId ${target.legacyId}`);
  }

  if (skipped.length) {
    console.log('\n  SKIPPED (left untouched):');
    for (const s of skipped) console.log(`    ${s.ID} "${s.titleSnapshot}" — ${s.reason}`);
  }

  console.log(`\n=== Summary (${mode}) ===`);
  console.log(`  puzzles assigned legacyId : ${assigned.length}`);
  console.log(`  TaskRecords relinked      : ${relinked}`);
  console.log(`  TaskRecords skipped       : ${skipped.length}`);
  if (!APPLY) console.log('\n  (dry run — re-run with --apply to perform writes)');
  console.log('');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

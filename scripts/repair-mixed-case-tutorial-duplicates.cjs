// scripts/repair-mixed-case-tutorial-duplicates.cjs
//
// One-shot repair for tutorials whose Tutorials.slug shipped with mixed case
// (e.g. "abap-environment-sbpa-workflow-extend-RAP-App"). Before the publisher
// was canonicalized, those publishes inserted a parallel lowercase row holding
// the fresh stepCount/title/etc., while the original mixed-case row (still
// referenced by GroupPathItems/CompletionPathItems via tutorial_ID) kept stale
// or null metadata. Result: group SSR rendered "0 steps" for the affected
// tutorial. See plan docs/superpowers/plans/2026-05-31-mixed-case-slug-stepcount.md.
//
// Repair strategy (per duplicate pair {mixedCaseRow, lowerCaseRow}):
//   1. Copy stepCount, title, description, averageTimeToComplete, experienceTag,
//      primaryTag from the lowercase orphan onto the mixed-case row (where the
//      lowercase value is non-null and the mixed-case value is null/empty).
//   2. Re-point any Steps rows that reference the orphan back to the canonical row
//      (only when the canonical row has zero Steps — otherwise leave alone to avoid
//      unique-constraint pain on (tutorial_ID, stepOrder)).
//   3a. Check FK references to the orphan in Steps, GroupPathItems, CompletionPathItems,
//       NgdsResults (if present), and TaskRecords (if present).
//       If TOTAL refs == 0: hard-DELETE the orphan row. This is the safe path —
//       orphans were never wired into FK chains in practice (Steps are re-parented
//       above; GPI/CPI always referenced the mixed-case canonical row).
//   3b. If TOTAL refs > 0: log a WARN with per-table counts and mark the orphan
//       status='INACTIVE' so admins can reconcile manually.
//
// Hard-deleting safe orphans avoids leaving INACTIVE landmines that exact-match
// `where({ slug })` read paths might find.
//
// The script is IDEMPOTENT: running twice is a no-op. It is DRY-RUN by default
// (logs the proposed mutations to stdout). Pass --apply to actually write.
//
// Usage:
//   cf login                                                     # DEV space
//   npx cds bind --exec -- node scripts/repair-mixed-case-tutorial-duplicates.cjs            # dry-run
//   npx cds bind --exec -- node scripts/repair-mixed-case-tutorial-duplicates.cjs --apply    # mutate

'use strict';

const cds = require('@sap/cds');

const NS = 'com.sap.developers.ims';
const APPLY = process.argv.includes('--apply');

const COPY_FIELDS = [
  'stepCount', 'title', 'description', 'averageTimeToComplete',
  'experienceTag', 'primaryTag',
];

function isEmpty(v) {
  return v === null || v === undefined || v === '' || v === 0;
}

async function main() {
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  await cds.connect.to('db');

  const entities = cds.entities(NS);
  const { Tutorials, Steps, GroupPathItems, CompletionPathItems } = entities;
  const NgdsResults = entities.NgdsResults ?? null;
  const TaskRecords = entities.TaskRecords ?? null;

  console.log(`mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);

  // Pull every tutorial whose slug is non-lowercase. Then for each, look for a
  // companion row whose slug equals slug.toLowerCase() and is not the same row.
  const all = await SELECT.from(Tutorials).columns(
    'ID', 'slug', 'status',
    ...COPY_FIELDS,
  );

  const bySlug = new Map(all.map(r => [r.slug, r]));
  const pairs = [];

  for (const row of all) {
    if (!row.slug) continue;
    const lower = row.slug.toLowerCase();
    if (lower === row.slug) continue;       // already canonical, no orphan possible from this row's perspective
    const orphan = bySlug.get(lower);
    if (!orphan) continue;                  // no duplicate — nothing to repair
    if (orphan.ID === row.ID) continue;     // safety: same physical row
    pairs.push({ canonical: row, orphan });
  }

  if (pairs.length === 0) {
    console.log('no mixed-case duplicate Tutorials rows found — nothing to repair');
    return;
  }

  console.log(`found ${pairs.length} duplicate pair(s):`);
  for (const { canonical, orphan } of pairs) {
    console.log(`  ${canonical.slug} (canonical ID=${canonical.ID.slice(0,8)} stepCount=${canonical.stepCount ?? 'null'})`);
    console.log(`    └─ orphan ${orphan.slug} (ID=${orphan.ID.slice(0,8)} stepCount=${orphan.stepCount ?? 'null'} status=${orphan.status})`);
  }

  let copied = 0, reparented = 0, deactivated = 0, deleted = 0;

  for (const { canonical, orphan } of pairs) {
    // 1. Field copy
    const updates = {};
    for (const f of COPY_FIELDS) {
      if (isEmpty(canonical[f]) && !isEmpty(orphan[f])) {
        updates[f] = orphan[f];
      }
    }
    if (Object.keys(updates).length > 0) {
      console.log(`  copy onto ${canonical.slug}: ${JSON.stringify(updates)}`);
      if (APPLY) await UPDATE(Tutorials).where({ ID: canonical.ID }).set(updates);
      copied++;
    }

    // 2. Re-parent Steps only if the canonical row has none
    const canonicalSteps = await SELECT.from(Steps).where({ tutorial_ID: canonical.ID }).columns('ID');
    const orphanSteps = await SELECT.from(Steps).where({ tutorial_ID: orphan.ID }).columns('ID', 'stepOrder', 'title');
    if (canonicalSteps.length === 0 && orphanSteps.length > 0) {
      console.log(`  re-parent ${orphanSteps.length} Steps from orphan → canonical`);
      if (APPLY) {
        await UPDATE(Steps).where({ tutorial_ID: orphan.ID }).set({ tutorial_ID: canonical.ID });
      }
      reparented++;
    } else if (canonicalSteps.length > 0 && orphanSteps.length > 0) {
      console.log(`  WARN ${canonical.slug}: canonical has ${canonicalSteps.length} Steps and orphan has ${orphanSteps.length} — leaving Steps alone`);
    }

    // 3. Hard-delete orphan if no FK refs remain; INACTIVE-flag only when refs exist.
    let refCounts = { Steps: 0, GroupPathItems: 0, CompletionPathItems: 0, NgdsResults: 0, TaskRecords: 0 };
    try {
      const [stepsRef, gpiRef, cpiRef] = await Promise.all([
        SELECT.one.from(Steps).where({ tutorial_ID: orphan.ID }).columns('count(*) as n'),
        SELECT.one.from(GroupPathItems).where({ tutorial_ID: orphan.ID }).columns('count(*) as n'),
        SELECT.one.from(CompletionPathItems).where({ tutorial_ID: orphan.ID }).columns('count(*) as n'),
      ]);
      refCounts.Steps = Number(stepsRef?.n ?? 0);
      refCounts.GroupPathItems = Number(gpiRef?.n ?? 0);
      refCounts.CompletionPathItems = Number(cpiRef?.n ?? 0);

      if (NgdsResults) {
        const r = await SELECT.one.from(NgdsResults).where({ tutorial_ID: orphan.ID }).columns('count(*) as n');
        refCounts.NgdsResults = Number(r?.n ?? 0);
      }
      if (TaskRecords) {
        const r = await SELECT.one.from(TaskRecords).where({ tutorial_ID: orphan.ID }).columns('count(*) as n');
        refCounts.TaskRecords = Number(r?.n ?? 0);
      }
    } catch (err) {
      console.log(`  WARN ${orphan.slug}: FK ref check failed (${err.message}) — falling back to INACTIVE`);
      refCounts = null; // sentinel: unknown refs → safe default is INACTIVE-flag
    }

    const totalRefs = refCounts
      ? Object.values(refCounts).reduce((a, b) => a + b, 0)
      : 1; // unknown → treat as > 0

    if (totalRefs === 0) {
      console.log(`  hard-delete orphan (0 FK refs across all tables)`);
      if (APPLY) await DELETE.from(Tutorials).where({ ID: orphan.ID });
      deleted++;
    } else {
      const detail = refCounts
        ? Object.entries(refCounts).filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`).join(', ')
        : 'ref-check-failed';
      console.log(`  WARN ${orphan.slug}: ${totalRefs} FK ref(s) found (${detail}) — marking INACTIVE instead of deleting`);
      if (orphan.status !== 'INACTIVE') {
        if (APPLY) await UPDATE(Tutorials).where({ ID: orphan.ID }).set({ status: 'INACTIVE' });
        deactivated++;
      }
    }
  }

  console.log(`\nsummary: copied=${copied} reparented=${reparented} deleted=${deleted} deactivated=${deactivated}  ${APPLY ? '(applied)' : '(dry-run)'}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});

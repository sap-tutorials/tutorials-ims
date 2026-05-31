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
//   3. Mark the orphan lowercase row status='INACTIVE' so it stops appearing in
//      /build/slug-mapping and any catalog reads.
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

  const { Tutorials, Steps } = cds.entities(NS);

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

  let copied = 0, reparented = 0, deactivated = 0;

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

    // 3. INACTIVE the orphan
    if (orphan.status !== 'INACTIVE') {
      console.log(`  mark orphan INACTIVE`);
      if (APPLY) await UPDATE(Tutorials).where({ ID: orphan.ID }).set({ status: 'INACTIVE' });
      deactivated++;
    }
  }

  console.log(`\nsummary: copied=${copied} reparented=${reparented} deactivated=${deactivated}  ${APPLY ? '(applied)' : '(dry-run)'}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});

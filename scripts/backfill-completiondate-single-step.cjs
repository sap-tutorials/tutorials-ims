// Backfill completionDate on COMPLETED TUTORIAL TaskRecords that have a null
// completionDate — the single-step-tutorial (stepCount=1) bug.
//
// Root cause: developer-service.js _updateTutorialProgress's INSERT branch
// (a NEW record landing straight in COMPLETED — the single-step case) omitted
// completionDate, leaving rows COMPLETED with a null date. Date-windowed
// consumers drop them: the Devtoberfest gameboard's withinWindow guard excludes
// null-date completions ("can't prove in-window"), so single-step tutorials
// (e.g. the Week-1 Scavenger Hunt, 3,000 pts) scored 0 in the arcade while the
// schedule page counted them — the arcade/schedule mismatch.
//
// The forward fix (stamp completionDate in the INSERT branch) stops NEW null-date
// rows. This script repairs EXISTING ones by stamping completionDate from the
// row's own audit timestamp — modifiedAt (when the completion was written),
// falling back to createdAt. Only touches status='COMPLETED' rows with a null
// completionDate; SUPERSEDED and IN_PROGRESS rows are left alone (their null
// date is correct).
//
// Scope guard: only rows whose parent Tutorial has stepCount=1, matching the
// bug's origin. (In practice 100% of prod null-date COMPLETED tutorial rows are
// stepCount=1, but the guard keeps the write narrow and auditable.)
//
// Usage:
//   cf login   (target the space you intend to repair — DEV first, then PROD)
//   npx cds bind --exec --profile hybrid     -- node scripts/backfill-completiondate-single-step.cjs --dry-run
//   npx cds bind --exec --profile hybrid     -- node scripts/backfill-completiondate-single-step.cjs
//   npx cds bind --exec --profile hybrid-prod -- node scripts/backfill-completiondate-single-step.cjs --dry-run
//
// Default is a WRITE. Pass --dry-run to preview without writing.

const cds = require('@sap/cds');

const DRY_RUN = process.argv.includes('--dry-run');
const NS = 'com.sap.developers.ims';

(async () => {
  console.log(`Backfill single-step completionDate ${DRY_RUN ? '(DRY RUN)' : '(WRITE)'}`);
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');
  const { Tutorials, TaskRecords } = cds.entities(NS);

  // Single-step tutorials only — the population the bug can touch.
  const singleStep = await SELECT.from(Tutorials)
    .columns('legacyId', 'slug')
    .where({ stepCount: 1 });
  const legacyIds = singleStep.map(t => t.legacyId).filter(Boolean);
  const slugByLegacy = new Map(singleStep.map(t => [t.legacyId, t.slug]));
  if (legacyIds.length === 0) {
    console.log('No single-step tutorials found — nothing to do.');
    process.exit(0);
  }
  console.log(`Single-step tutorials: ${legacyIds.length}`);

  // COMPLETED TUTORIAL rows for those tutorials with a null completionDate.
  const broken = await SELECT.from(TaskRecords)
    .columns('ID', 'user_ID', 'taskLegacyId', 'status', 'completionDate', 'modifiedAt', 'createdAt')
    .where({
      taskType: 'TUTORIAL',
      status: 'COMPLETED',
      completionDate: null,
      taskLegacyId: { in: legacyIds },
    });

  console.log(`Rows to repair: ${broken.length}`);
  let repaired = 0;
  let skipped = 0;
  for (const rec of broken) {
    const stamp = rec.modifiedAt || rec.createdAt;
    const slug = slugByLegacy.get(rec.taskLegacyId) || `legacy:${rec.taskLegacyId}`;
    if (!stamp) {
      // No audit timestamp to derive from — leave it for manual review rather
      // than inventing a date that could mis-window the completion.
      console.log(`  SKIP (no timestamp) ${slug} user=${String(rec.user_ID).slice(0, 8)}`);
      skipped += 1;
      continue;
    }
    console.log(`  ${DRY_RUN ? 'WOULD SET' : 'SET'} ${slug} user=${String(rec.user_ID).slice(0, 8)} completionDate=${stamp}`);
    if (!DRY_RUN) {
      await UPDATE(TaskRecords).where({ ID: rec.ID }).set({ completionDate: stamp });
    }
    repaired += 1;
  }

  console.log(`\n${DRY_RUN ? 'Would repair' : 'Repaired'} ${repaired} rows${skipped ? `, skipped ${skipped} (no timestamp)` : ''}.`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });

// Backfill script for issue #89 — recompute every TUTORIAL TaskRecord
// against the user's actual completed STEP records, using the authoritative
// step count from the parsed source frontmatter (.tutorial-cache/metadata
// is unreliable; we read .md files in hugo/content/tutorials directly).
//
// Two run modes:
//   --derive-stepcount    Read hugo/content/tutorials/*.md, parse `steps:`
//                         array length from frontmatter, write Tutorials.stepCount.
//                         Run this AFTER deploying the schema change.
//   --recompute           Walk every Tutorial with stepCount > 0, recompute
//                         all its TUTORIAL TaskRecords. Flips stale 100% rows
//                         to IN_PROGRESS where appropriate. Logs per-row diffs.
//
// Usage:
//   cf login   (DEV space)
//   npx cds bind --exec -- node scripts/backfill-issue-89.cjs --dry-run
//   npx cds bind --exec -- node scripts/backfill-issue-89.cjs
//
// Default: both modes run in sequence. --dry-run prints the proposed changes
// without writing.

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_DERIVE = process.argv.includes('--derive-stepcount');
const ONLY_RECOMPUTE = process.argv.includes('--recompute');
const RUN_DERIVE = !ONLY_RECOMPUTE;
const RUN_RECOMPUTE = !ONLY_DERIVE;

const NS = 'com.sap.developers.ims';

function loadStepCounts() {
  const dir = path.resolve(__dirname, '..', 'hugo', 'content', 'tutorials');
  if (!fs.existsSync(dir)) {
    console.error(`hugo/content/tutorials not found at ${dir} — run npm run fetch-tutorials first`);
    process.exit(2);
  }
  const map = new Map();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const slug = entry.replace(/\.md$/, '');
    const raw = fs.readFileSync(path.join(dir, entry), 'utf-8');
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) continue;
    let fm;
    try { fm = yaml.load(fmMatch[1]); } catch { continue; }
    if (Array.isArray(fm?.steps) && fm.steps.length > 0) {
      map.set(slug, fm.steps.length);
    }
  }
  return map;
}

async function deriveStepCounts(db) {
  console.log('\n=== Mode 1: derive Tutorials.stepCount from hugo/content ===');
  const counts = loadStepCounts();
  console.log(`Loaded step counts for ${counts.size} tutorials`);
  const { Tutorials } = cds.entities(NS);
  const tutorials = await SELECT.from(Tutorials).columns('ID', 'slug', 'stepCount');

  let toUpdate = 0;
  let updated = 0;
  for (const t of tutorials) {
    const expected = counts.get(t.slug);
    if (!expected) continue;
    if (t.stepCount === expected) continue;
    toUpdate += 1;
    if (DRY_RUN) {
      console.log(`  WOULD SET ${t.slug}: stepCount ${t.stepCount ?? 'null'} → ${expected}`);
    } else {
      await UPDATE(Tutorials).where({ ID: t.ID }).set({ stepCount: expected });
      updated += 1;
    }
  }
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} ${DRY_RUN ? toUpdate : updated} tutorials`);
}

async function recomputeAll(db) {
  console.log('\n=== Mode 2: recompute TUTORIAL TaskRecords against stepCount ===');
  const { Tutorials, Steps, TaskRecords } = cds.entities(NS);

  const tutorials = await SELECT.from(Tutorials).columns('ID', 'slug', 'legacyId', 'stepCount');
  let totalRecords = 0;
  let totalUpdated = 0;
  for (const t of tutorials) {
    if (!t.legacyId) continue;
    if (!Number.isInteger(t.stepCount) || t.stepCount <= 0) continue;

    const steps = await SELECT.from(Steps).where({ tutorial_ID: t.ID }).columns('legacyId');
    const stepLegacyIds = steps.map(s => s.legacyId).filter(Boolean);
    if (stepLegacyIds.length === 0) continue;

    const tutorialRecs = await SELECT.from(TaskRecords).where({
      taskLegacyId: t.legacyId,
      taskType: 'TUTORIAL'
    });
    if (tutorialRecs.length === 0) continue;
    totalRecords += tutorialRecs.length;

    for (const rec of tutorialRecs) {
      const completed = await SELECT.from(TaskRecords).where({
        user_ID: rec.user_ID,
        taskType: 'STEP',
        status: 'COMPLETED',
        taskLegacyId: { in: stepLegacyIds }
      }).columns('ID');
      const newProgress = Math.round((completed.length / t.stepCount) * 100);
      const newStatus = newProgress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
      if (rec.progress === newProgress && rec.status === newStatus) continue;
      console.log(`  ${t.slug} user=${rec.user_ID.slice(0,8)} progress ${rec.progress}→${newProgress} status ${rec.status}→${newStatus} (${completed.length}/${t.stepCount} steps)`);
      if (!DRY_RUN) {
        const set = { progress: newProgress, status: newStatus };
        if (newStatus !== 'COMPLETED') set.completionDate = null;
        await UPDATE(TaskRecords).where({ ID: rec.ID }).set(set);
        totalUpdated += 1;
      } else {
        totalUpdated += 1;
      }
    }
  }
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} ${totalUpdated} of ${totalRecords} TUTORIAL TaskRecords`);
}

(async () => {
  console.log(`Issue #89 backfill ${DRY_RUN ? '(DRY RUN)' : ''}`);
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');

  if (RUN_DERIVE) await deriveStepCounts(db);
  if (RUN_RECOMPUTE) await recomputeAll(db);

  console.log('\nDone.');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });

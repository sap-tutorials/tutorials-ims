#!/usr/bin/env node
// scripts/run-missing-kg-fetchers.js
//
// One-shot operational driver that cold-starts the external-content
// fetcher crons that have never run on a deployed environment. Solves
// the "Other resources rail is empty" problem found during KG widget
// testing on DEV 2026-06-30.
//
// Background: Phase 4.1-4.6 of #447/#746/#747 shipped fetcher cron jobs
// for the cross-corpus "Other resources" rail (learning journeys, blog
// posts, discovery missions, videos, api docs, samples). Each runs on a
// weekly cadence per registerJobs() in srv/jobs/scheduler.js. On DEV
// 2026-06-30, JobLastRun showed LASTSUCCESSAT = NULL for six of them —
// they were registered but had never been triggered (the relevant cron
// minute hadn't been reached, or the app was restarted before it fired).
// Result: every corpus table is empty and the rail renders nothing.
//
// Each fetcher hits a public API (learning.sap.com, community.sap.com,
// YouTube, etc.) so this script can take 5-15 minutes wall-clock. They
// run sequentially so a transient rate-limit on one corpus doesn't kill
// the others.
//
// Run via:
//   npx cds bind --exec -- node scripts/run-missing-kg-fetchers.js           # dry-run (lists jobs only)
//   npx cds bind --exec -- node scripts/run-missing-kg-fetchers.js --commit  # actually runs them
//
// Idempotent: runJobByName goes through runWithLock (srv/jobs/scheduler.js)
// so two concurrent invocations against the same DB instance won't double-
// execute a fetcher — the second one short-circuits with skipped:true.

import cds from '@sap/cds';
import { registerJobs, runJobByName, _getJobRegistry } from '../srv/jobs/scheduler.js';

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const INITIATOR = process.env.INITIATOR || 'scripts/run-missing-kg-fetchers';

// The fetchers that were observed NULL in JobLastRun on DEV 2026-06-30.
// Order matters slightly:
//   - consolidateConcepts first so any new concepts get deduped before
//     downstream link tables reference them.
//   - learning-journeys before blog-posts/videos/discovery: the journey
//     taxonomy is the strongest signal for the "Other resources" rail.
//   - gc-external-content last so it has something to GC.
const TARGET_JOBS = [
  'consolidateConcepts',
  'fetch-learning-journeys',
  'fetch-blog-posts',
  'fetch-discovery-missions',
  'fetch-videos',
  'fetch-api-docs',
  'fetch-samples',
  'gc-external-content',
];

async function main() {
  // Same warmup pattern as scripts/backfill-tutorial-meta.js so the
  // standalone process boots CAP's model + DB without a server context.
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');

  // Populate JOB_REGISTRY. registerJobs DOES call cron.schedule for each
  // entry — but those schedules use setTimeout-based scheduling that
  // tears down cleanly on process.exit(), so this is safe in a one-shot
  // script that exits before any cron-minute fires.
  registerJobs();

  const registry = _getJobRegistry();
  console.log(`Job registry populated: ${registry.size} jobs.`);
  console.log();

  // Filter to the targets that actually exist (registerJobs guards
  // against drift between this script and the live registry).
  const missing = TARGET_JOBS.filter(n => !registry.has(n));
  if (missing.length) {
    console.error(`Unknown jobs (typo or removed?): ${missing.join(', ')}`);
    console.error(`Available jobs: ${Array.from(registry.keys()).join(', ')}`);
    process.exit(2);
  }

  // Look up JobLastRun so we can show "previously NULL" vs "previously
  // ran on YYYY-MM-DD" for each target.
  const lastRun = await db.run(`SELECT jobName, lastSuccessAt FROM com_sap_developers_ims_JobLastRun`);
  const lastRunByName = new Map(lastRun.map(r => [r.JOBNAME ?? r.jobName, r.LASTSUCCESSAT ?? r.lastSuccessAt]));

  console.log(`Targets (in run order):`);
  console.log(`  job                                last success`);
  console.log(`  --------------------------------   ----------------------------`);
  for (const jobName of TARGET_JOBS) {
    const last = lastRunByName.get(jobName);
    const cell = last ? new Date(last).toISOString() : '(never)';
    console.log(`  ${jobName.padEnd(34)}   ${cell}`);
  }
  console.log();

  if (!COMMIT) {
    console.log('Dry-run — no jobs invoked. Re-run with --commit to execute.');
    return;
  }

  // Sequential execution with per-job logging. Each invocation goes
  // through runWithLock which writes its own PipelineLog + JobLastRun
  // rows. We don't double-log here.
  console.log(`Running jobs sequentially as initiator=${INITIATOR}...`);
  console.log();
  for (const jobName of TARGET_JOBS) {
    const t0 = Date.now();
    process.stdout.write(`▶ ${jobName.padEnd(34)} `);
    try {
      const res = await runJobByName(jobName, { manualTrigger: true, user: INITIATOR });
      const dt = Math.round((Date.now() - t0) / 1000);
      if (res?.skipped) {
        console.log(`SKIPPED  (${res.reason})           ${dt}s`);
      } else {
        const outcome = res?.outcome || 'success';
        const summary = formatSummary(res?.result);
        console.log(`${outcome.padEnd(8)} ${summary.padEnd(28)} ${dt}s`);
        if (res?.errorMessage) console.log(`    ${res.errorMessage.slice(0, 200)}`);
      }
    } catch (err) {
      const dt = Math.round((Date.now() - t0) / 1000);
      console.log(`THREW    ${(err.message || String(err)).slice(0, 60)}  ${dt}s`);
    }
  }
  console.log();
  console.log(`Done. Verify on DEV (need a logged-in browser cookie for /graph/* — see DEV approuter):`);
  console.log(`  curl -s -b "<cookie>" "https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/graph/neighborhood(slug='btp-sdm-gwi-crossdomain-mapping')"`);
  console.log(`  → expect "otherResources" array with learning-journey / blog-post / video / discovery-mission rows.`);
}

// Best-effort one-line summary of the job's return shape. Jobs vary —
// some return {found, written}, some {processed, skipped}, some void.
function formatSummary(result) {
  if (result == null) return '';
  if (typeof result !== 'object') return String(result).slice(0, 28);
  const keys = Object.keys(result).slice(0, 4);
  return keys.map(k => `${k}=${JSON.stringify(result[k])}`).join(' ');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});

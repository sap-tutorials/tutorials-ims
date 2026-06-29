#!/usr/bin/env node
// scripts/seed-videos.cjs
//
// Phase 4.4 (#447): one-shot 24-month historical backfill for SAP Developers
// YouTube videos. Bypasses the cron's ChatSettings budget gate AND the
// MAX-or-abort first-run gate so a deliberate operator-initiated run can
// populate the corpus.
//
// USAGE
//   node scripts/seed-videos.cjs --months=24 --limit=5000 --dry-run
//   node scripts/seed-videos.cjs --months=24 --limit=5000 --commit
//   node scripts/seed-videos.cjs --resume --commit
//
// Spec: docs/superpowers/specs/2026-06-29-447-phase4.4-videos.md §8

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2).reduce((acc, arg) => {
  const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
  if (m) acc[m[1]] = m[2] ?? true;
  return acc;
}, {});

const MONTHS = parseInt(args.months ?? '24', 10);
const LIMIT = parseInt(args.limit ?? '5000', 10);
const DRY_RUN = !!args['dry-run'];
const RESUME = !!args.resume;
const COMMIT = !!args.commit;

if (!DRY_RUN && !COMMIT) {
  console.error('Refusing to run without --dry-run or --commit.');
  process.exit(2);
}

(async () => {
  // Load the CDS model so `cds.entities(...)` is callable. The serving
  // lifecycle does this for you; `cds bind --exec` does not. See #757.
  cds.model = await cds.load('*');
  await cds.connect.to('db');

  const { runFetchVideos } = await import('../srv/jobs/fetch-videos-job.js');
  const { Videos } = cds.entities('com.sap.developers.ims.external');

  let sinceIso = null;
  if (RESUME) {
    const max = await SELECT.one.from(Videos).columns('max(publishedAt) as m');
    sinceIso = max?.m ?? null;
    console.log(`[seed] resume: sinceIso=${sinceIso ?? '(null — full backfill)'}`);
    if (!sinceIso) {
      // Resume on an empty table → fall back to MONTHS window.
      const since = new Date();
      since.setMonth(since.getMonth() - MONTHS);
      sinceIso = since.toISOString();
      console.log(`[seed] resume on empty table; falling back to months=${MONTHS}, sinceIso=${sinceIso}`);
    }
  } else {
    const since = new Date();
    since.setMonth(since.getMonth() - MONTHS);
    sinceIso = since.toISOString();
    console.log(`[seed] backfill: months=${MONTHS}, sinceIso=${sinceIso}, limit=${LIMIT}`);
  }

  if (DRY_RUN) {
    console.log(`[seed] dry-run: would invoke runFetchVideos with budgetOverride=${LIMIT}, sinceIsoOverride=${sinceIso}`);
    console.log('[seed] dry-run: pass --commit to actually fetch + persist.');
    process.exit(0);
  }

  // COMMIT mode: invoke runFetchVideos with two deps overrides:
  //   - budgetOverride: LIMIT (bypasses ChatSettings; lets the script set
  //     its own per-run cap rather than coupling to the twice-weekly cron)
  //   - sinceIsoOverride: sinceIso (bypasses the MAX(publishedAt)-or-abort
  //     gate so the cron doesn't refuse to bootstrap on an empty Videos
  //     table)
  //
  // YOUTUBE_API_KEY is resolved by the cron itself via resolveSecret (same
  // credstore wiring as the homepage video band).
  //
  // Both deps are explicit operator seams declared on the cron's signature
  // (see srv/jobs/fetch-videos-job.js). No sentinel row hack, no
  // ChatSettings monkey-patching.

  try {
    const summary = await runFetchVideos({
      budgetOverride: LIMIT,
      sinceIsoOverride: sinceIso,
    });
    console.log(`[seed] summary: ${JSON.stringify(summary, null, 2)}`);

    // Write summary to .migration-data for audit trail.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const summaryPath = path.join(process.cwd(), '.migration-data', `videos-backfill-${stamp}.json`);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`[seed] summary written to ${summaryPath}`);
  } catch (err) {
    console.error(`[seed] backfill failed: ${err.message}`);
    process.exit(3);
  }

  process.exit(0);
})().catch(err => {
  console.error(`[seed] fatal: ${err.message}`);
  process.exit(3);
});

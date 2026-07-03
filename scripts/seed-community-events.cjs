#!/usr/bin/env node
// scripts/seed-community-events.cjs
//
// Phase 4.8 (#765): operator seed CLI. Bypasses the MAX-or-abort gate to
// bootstrap the CommunityEvents table on a freshly deployed DB.
//
// Usage:
//   node scripts/seed-community-events.cjs                # --dry-run (default)
//   node scripts/seed-community-events.cjs --commit       # actually seed
//   cds bind --exec -- node scripts/seed-community-events.cjs --commit   # hybrid

'use strict';

const cds = require('@sap/cds');

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const dryRun = !commit || args.includes('--dry-run');

(async () => {
  cds.model = cds.linked(await cds.load('*'));
  void cds.model.entities;
  await cds.connect.to('db');

  const { runFetchCommunityEvents } = await import('../srv/jobs/fetch-community-events-job.js');

  const opts = {
    sinceIsoOverride: '1970-01-01T00:00:00Z',
    manualTrigger: true,
  };
  if (dryRun) {
    opts.budgetOverride = 0;
    opts.extractFn = async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 });
    console.log('[seed-community-events] DRY RUN — no LLM calls, budget 0. Pass --commit to seed for real.');
  } else {
    opts.budgetOverride = Infinity;
    console.log('[seed-community-events] COMMIT — full extraction, budget Infinity.');
  }

  const summary = await runFetchCommunityEvents('seed-cli', opts);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors > 0) process.exit(1);
})().catch((err) => {
  console.error('seed-community-events failed:', err);
  process.exit(1);
});

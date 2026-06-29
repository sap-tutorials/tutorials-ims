#!/usr/bin/env node
// scripts/seed-samples.cjs
//
// Phase 4.6 (#747): operator CLI to bootstrap the Samples corpus.
// Invokes the cron's runner with sinceIsoOverride to bypass the
// MAX-or-abort first-run gate exactly once.
//
// Usage:
//   node scripts/seed-samples.cjs --dry-run           # default
//   node scripts/seed-samples.cjs --commit
//   node scripts/seed-samples.cjs --commit --resume
//
// Spec: docs/superpowers/specs/2026-06-29-747-phase4.6-code-samples.md §8

const cds = require('@sap/cds');

async function main() {
  const args = new Set(process.argv.slice(2));
  const commit = args.has('--commit');
  const resume = args.has('--resume');

  if (!commit && !args.has('--dry-run')) {
    console.log('seed-samples: defaulting to --dry-run (pass --commit to actually seed)');
  }

  // Load the CDS model so `cds.entities(...)` is callable. The serving
  // lifecycle does this for you; `cds bind --exec` does not. See #757.
  cds.model = await cds.load('*');
  await cds.connect.to('db');

  const { runFetchSamples } = await import('../srv/jobs/fetch-samples-job.js');

  const opts = {
    budgetOverride: 1000,                          // bypass per-cycle budget
    sinceIsoOverride: '1970-01-01T00:00:00Z',     // bypass MAX-or-abort
  };
  if (!commit) {
    // Dry-run: skip extraction by injecting a no-op extractor.
    opts.extractFn = async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 });
  }

  console.log(`seed-samples: invoking runFetchSamples (commit=${commit}, resume=${resume})`);
  const summary = await runFetchSamples(null, opts);
  console.log('seed-samples summary:', JSON.stringify(summary, null, 2));
  process.exit(summary.errors > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

#!/usr/bin/env node
// scripts/seed-help-docs.cjs
//
// Phase 4.7 (#748): operator CLI to bootstrap the HelpDocs corpus.
// Invokes runFetchHelpDocs directly with sinceIsoOverride to bypass the
// MAX-or-abort first-run gate exactly once. Mirrors scripts/seed-samples.cjs.
//
// Usage:
//   node scripts/seed-help-docs.cjs --dry-run            # default; no LLM calls
//   node scripts/seed-help-docs.cjs --commit             # actual seed
//   node scripts/seed-help-docs.cjs --commit --slug <s>  # (reserved; today re-seeds all)
//
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §9

const cds = require('@sap/cds');

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const commit = args.has('--commit');
  const slugIdx = argv.indexOf('--slug');
  const slug = slugIdx >= 0 ? argv[slugIdx + 1] : null;

  if (!commit && !args.has('--dry-run')) {
    console.log('seed-help-docs: defaulting to --dry-run (pass --commit to actually seed)');
  }

  // Load the CDS model so `cds.entities(...)` is callable. The serving
  // lifecycle does this for you; `cds bind --exec` does not.
  cds.model = await cds.load('*');
  await cds.connect.to('db');

  const { runFetchHelpDocs } = await import('../srv/jobs/fetch-help-docs-job.js');

  const opts = {
    sinceIsoOverride: '1970-01-01T00:00:00Z',     // bypass MAX-or-abort
    manualTrigger: true,
  };
  if (commit) {
    // Full unbounded seed (first-time bootstrap).
    opts.budgetOverride = Infinity;
  } else {
    // Dry-run: skip extraction entirely (budget 0 + no-op extractor).
    opts.budgetOverride = 0;
    opts.extractFn = async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 });
  }

  console.log(`seed-help-docs: invoking runFetchHelpDocs (commit=${commit}, slug=${slug ?? 'ALL'})`);
  if (slug) {
    // Slug-targeted re-seed is reserved for a future chassis-level filter.
    // Today the cron ignores this and re-seeds all; contentHash short-circuit
    // makes the extra work bounded.
    console.log('seed-help-docs: --slug is reserved; today the cron re-seeds all (contentHash short-circuits unchanged rows).');
  }
  const summary = await runFetchHelpDocs(null, opts);
  console.log('seed-help-docs summary:', JSON.stringify(summary, null, 2));
  process.exit((summary?.errors ?? 0) > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

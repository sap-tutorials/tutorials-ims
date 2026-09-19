#!/usr/bin/env node
// scripts/seed-concept-definitions.cjs
//
// #2426: operator CLI to bootstrap the concept-definition generator. Invokes
// the generate-concept-definitions job directly with manualTrigger to bypass
// the (default-OFF) conceptDefinitionsEnabled feature flag exactly once.
// Mirrors scripts/seed-help-docs.cjs.
//
// Every definition is written as descriptionStatus='DRAFT' — nothing goes live
// until an admin approves it in /admin-ui/ (Concepts → Approve Definition).
//
// Usage:
//   node scripts/seed-concept-definitions.cjs                 # dry-run (no LLM calls)
//   node scripts/seed-concept-definitions.cjs --commit        # generate (respects DEFAULT_BUDGET)
//   node scripts/seed-concept-definitions.cjs --commit --redraft   # also re-draft existing DRAFTs
//   node scripts/seed-concept-definitions.cjs --commit --budget 50 # cap this run
//
// Run against real data:  cds bind --exec -- node scripts/seed-concept-definitions.cjs --commit

const cds = require('@sap/cds');

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const commit = args.has('--commit');
  const redraft = args.has('--redraft');
  const budgetIdx = argv.indexOf('--budget');
  const budget = budgetIdx >= 0 ? Number(argv[budgetIdx + 1]) : undefined;

  if (!commit && !args.has('--dry-run')) {
    console.log('seed-concept-definitions: defaulting to --dry-run (pass --commit to actually generate)');
  }

  // Load the model so cds.entities(...) works under `cds bind --exec` (#757/#911).
  cds.model = cds.linked(await cds.load('*'));
  void cds.model.entities;
  await cds.connect.to('db');

  const { runGenerateConceptDefinitions } = await import('../srv/jobs/generate-concept-definitions-job.js');

  const opts = { manualTrigger: true, redraft };
  if (Number.isFinite(budget)) opts.budgetOverride = budget;
  if (!commit) {
    // Dry-run: no LLM calls — count candidates only via a no-op generate fn.
    opts.generateFn = async () => ({ definition: null, reason: 'dry-run', violations: [], promptTokens: 0, completionTokens: 0 });
  }

  console.log(`seed-concept-definitions: running (commit=${commit}, redraft=${redraft}, budget=${budget ?? 'default'})`);
  const summary = await runGenerateConceptDefinitions(null, opts);
  console.log('seed-concept-definitions summary:', JSON.stringify(summary, null, 2));
  process.exit((summary?.errors ?? 0) > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

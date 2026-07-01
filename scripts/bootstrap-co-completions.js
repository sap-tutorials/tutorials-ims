#!/usr/bin/env node
// scripts/bootstrap-co-completions.js
//
// One-shot bootstrap for the CoCompletions materialized table (introduced
// by the KG widget perf PR). Run this ONCE after the migration deploys so
// the runtime neighborhood handler has a populated table on its first hit.
// After that, the daily 04:33 UTC cron in srv/jobs/scheduler.js keeps it
// fresh.
//
// Usage:
//   npx cds bind --exec -- node scripts/bootstrap-co-completions.js               # dry-run (prints counts)
//   npx cds bind --exec -- node scripts/bootstrap-co-completions.js --commit      # actually writes
//
// Idempotent: re-running truncates the table + repopulates in one
// transaction. Safe to run multiple times.

import cds from '@sap/cds';
import { runMaterializeCoCompletions } from '../srv/jobs/materialize-co-completions.js';

async function main() {
  const commit = process.argv.includes('--commit');
  if (!commit) {
    console.log('bootstrap-co-completions: dry-run mode (pass --commit to write)');
  }

  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');

  const { CoCompletions } = cds.entities('com.sap.developers.ims');
  const before = (await db.run(`SELECT COUNT(*) AS N FROM com_sap_developers_ims_CoCompletions`))[0].N;
  console.log(`Rows before: ${before}`);

  if (!commit) {
    console.log(`(Would compute + rewrite. Skip with --commit to actually run the cron.)`);
    return;
  }

  console.log('Running materialize-co-completions...');
  const summary = await runMaterializeCoCompletions();
  console.log('Summary:', JSON.stringify(summary, null, 2));

  const after = (await db.run(`SELECT COUNT(*) AS N FROM com_sap_developers_ims_CoCompletions`))[0].N;
  console.log(`Rows after: ${after}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});

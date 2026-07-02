#!/usr/bin/env node
// scripts/soft-delete-sandbox-tutorials.cjs
//
// One-shot cleanup for #862 reopen: soft-delete Tutorials rows sourced
// from sap-tutorials/sandbox and sap-tutorials/sandbox-Contribution.
// Those repos were added to EXCLUDED_REPOS in scripts/parsers/github.ts
// so future rebuilds won't reintroduce them, but existing DB rows (e.g.
// rbrainey-sandbox-1) linger. This script sets Tutorials.status =
// 'INACTIVE' for those rows so they drop off all three MyTutorials-family
// endpoints without hard-delete cascade risk.
//
// Idempotent: rows already status=INACTIVE are skipped.
//
// Usage (from a `cf login`-authenticated shell targeting DEV):
//   npx cds bind --exec -- node scripts/soft-delete-sandbox-tutorials.cjs
//   npx cds bind --exec -- node scripts/soft-delete-sandbox-tutorials.cjs --commit

'use strict';

const cds = require('@sap/cds');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const initIdx = argv.indexOf('--initiator');
const INITIATOR =
  initIdx >= 0
    ? argv[initIdx + 1]
    : process.env.INITIATOR || 'scripts/soft-delete-sandbox-tutorials';

const SANDBOX_REPO_NAMES = ['sandbox', 'sandbox-Contribution'];

async function main() {
  const log = cds.log('soft-delete-sandbox');
  log.info(`mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} initiator=${INITIATOR}`);

  await cds.connect.to('db');
  const { Tutorials, TutorialMeta, TutorialRepositories } =
    cds.entities('com.sap.developers.ims');

  const repos = await SELECT.from(TutorialRepositories)
    .columns('ID', 'name')
    .where({ name: { in: SANDBOX_REPO_NAMES } });
  if (!repos.length) {
    log.info('no sandbox repositories found — nothing to do');
    return;
  }
  log.info(`found ${repos.length} sandbox repo row(s): ${repos.map((r) => r.name).join(', ')}`);

  const repoIds = repos.map((r) => r.ID);

  // The repository FK lives on TutorialMeta, not Tutorials — Tutorials has
  // only { author, redirectTo } as its outgoing associations (see
  // db/schema.cds:32-49). Two-step: find TutorialMeta rows for the sandbox
  // repos, then look up the parent Tutorials rows by tutorial_ID.
  const metas = await SELECT.from(TutorialMeta)
    .columns('tutorial_ID')
    .where({ 'repository_ID': { in: repoIds } });
  const tutIds = [...new Set(metas.map((m) => m.tutorial_ID).filter(Boolean))];
  if (!tutIds.length) {
    log.info('no TutorialMeta rows found for sandbox repos — nothing to do');
    return;
  }

  const rows = await SELECT.from(Tutorials)
    .columns('ID', 'slug', 'status')
    .where({ ID: { in: tutIds } });

  const buckets = { 'soft-delete': [], 'already-inactive': [] };
  for (const row of rows) {
    if (row.status === 'INACTIVE') buckets['already-inactive'].push(row);
    else buckets['soft-delete'].push(row);
  }

  console.log('\nbucket,slug,current_status');
  for (const [bucket, rowList] of Object.entries(buckets)) {
    for (const row of rowList) console.log(`${bucket},${row.slug},${row.status ?? ''}`);
  }
  console.log(
    `\nsummary: soft-delete=${buckets['soft-delete'].length} already-inactive=${buckets['already-inactive'].length}`
  );

  if (!COMMIT) {
    log.info('dry-run only — re-run with --commit to apply');
    return;
  }
  if (!buckets['soft-delete'].length) {
    log.info('nothing to update');
    return;
  }

  for (const row of buckets['soft-delete']) {
    await UPDATE(Tutorials).set({ status: 'INACTIVE' }).where({ ID: row.ID });
    log.info(`INACTIVE ${row.slug} (${row.ID})`);
  }
  log.info(`committed ${buckets['soft-delete'].length} row(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

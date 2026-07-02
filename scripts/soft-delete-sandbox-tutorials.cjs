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
// Detection strategy — TWO passes, take the union:
//   1. Via TutorialMeta.repository_ID: preferred when the tutorial was
//      normally published (fully linked to TutorialRepositories row).
//   2. Via slug prefix (e.g. contains "sandbox"): fallback for tutorials
//      that landed via the discovery-baseline JSON without a repository FK.
//      This was the actual state on DEV for rbrainey-sandbox-1 — the
//      first-pass discovery couldn't find it. See #862 rollout notes.
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
// Slug patterns that indicate a sandbox origin even when the repository
// FK isn't set. Conservative — matches only slugs with "sandbox" as a
// bounded segment, not e.g. "sandboxie-config" or similar.
const SANDBOX_SLUG_RE = /(^|-)sandbox($|-)/i;

async function main() {
  const log = cds.log('soft-delete-sandbox');
  log.info(`mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} initiator=${INITIATOR}`);

  // Load + compile the CDS model. Matches scripts/repair-author-id-phase-c.cjs
  // — required so cds.entities() resolves the namespace under `cds bind --exec`.
  // Without this the call throws TypeError: cds.entities is not a function.
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);

  await cds.connect.to('db');
  const { Tutorials, TutorialMeta, TutorialRepositories } =
    cds.entities('com.sap.developers.ims');

  // ── Pass 1: via TutorialMeta.repository_ID → TutorialRepositories.name
  const foundTutIds = new Set();
  const repos = await SELECT.from(TutorialRepositories)
    .columns('ID', 'name')
    .where({ name: { in: SANDBOX_REPO_NAMES } });
  if (repos.length) {
    log.info(`Pass 1: ${repos.length} sandbox repo row(s): ${repos.map((r) => r.name).join(', ')}`);
    const repoIds = repos.map((r) => r.ID);
    const metas = await SELECT.from(TutorialMeta)
      .columns('tutorial_ID')
      .where({ 'repository_ID': { in: repoIds } });
    for (const m of metas) if (m.tutorial_ID) foundTutIds.add(m.tutorial_ID);
    log.info(`Pass 1: ${metas.length} TutorialMeta row(s) linked to sandbox repos`);
  } else {
    log.info('Pass 1: no sandbox TutorialRepositories rows');
  }

  // ── Pass 2: via slug pattern (finds orphan rows with no repository FK)
  const allTuts = await SELECT.from(Tutorials).columns('ID', 'slug', 'status');
  const bySlug = allTuts.filter((t) => t.slug && SANDBOX_SLUG_RE.test(t.slug));
  for (const t of bySlug) foundTutIds.add(t.ID);
  log.info(`Pass 2: ${bySlug.length} tutorial(s) matched by slug pattern /(^|-)sandbox($|-)/i`);

  if (!foundTutIds.size) {
    log.info('no sandbox tutorials found by either pass — nothing to do');
    return;
  }

  const rowsById = new Map(allTuts.map((t) => [t.ID, t]));
  const rows = [...foundTutIds].map((id) => rowsById.get(id)).filter(Boolean);

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

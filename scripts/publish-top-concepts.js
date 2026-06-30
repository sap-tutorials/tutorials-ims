#!/usr/bin/env node
// scripts/publish-top-concepts.js
//
// One-shot operational script — publishes the top-N highest-coverage
// Concepts so they show up in /build/concepts and the tutorial sidebar's
// `teaches[]` enrichment. Solves the "widget is empty for most tutorials"
// problem found during KG widget testing on DEV 2026-06-30.
//
// Background: KnowledgeGraphService.PublishedConcepts is filtered to
// `publishedAt IS NOT NULL AND status = 'ACTIVE'`. The sidebar's
// teaches[] only renders published concepts. On DEV 2026-06-30 there
// were 1,635 ACTIVE concepts with 4,679 TutorialConceptLinks rows but
// only 10 published — so the widget was effectively dark on ~99% of
// tutorials that had concept extraction.
//
// What this script does
//   1. Ranks ACTIVE, unpublished concepts by the count of
//      TutorialConceptLinks pointing at them (more links → publishing
//      this one unlocks more tutorials).
//   2. Picks the top --limit (default 100) rows.
//   3. Sets publishedAt = now() + publishedBy = <initiator> in a single
//      UPDATE per row (matches the publishConcept bound-action flow at
//      srv/knowledge-graph-service.js so the audit trail is consistent).
//   4. Prints which concepts went live and how many tutorials each
//      unlocks. With --dry-run default, no writes — just the preview.
//
// Run via:
//   npx cds bind --exec -- node scripts/publish-top-concepts.js               # dry-run
//   npx cds bind --exec -- node scripts/publish-top-concepts.js --commit      # writes
//   npx cds bind --exec -- node scripts/publish-top-concepts.js --commit --limit 50
//
// Idempotent: re-running picks up where the previous run stopped because
// the WHERE clause filters to publishedAt IS NULL. Running twice with
// --limit 100 publishes the top-200.

import cds from '@sap/cds';

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const limitIdx = argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : 100;
const INITIATOR = process.env.INITIATOR || 'scripts/publish-top-concepts';

if (!Number.isFinite(LIMIT) || LIMIT < 1 || LIMIT > 5000) {
  console.error(`Invalid --limit ${argv[limitIdx + 1]} (expected 1-5000)`);
  process.exit(2);
}

async function main() {
  // Same warmup pattern as scripts/backfill-tutorial-meta.js so the
  // standalone process boots CAP's model + DB without a server context.
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');

  // 1. Inventory.
  const total      = (await db.run(`SELECT COUNT(*) AS N FROM com_sap_developers_ims_Concepts`))[0].N;
  const active     = (await db.run(`SELECT COUNT(*) AS N FROM com_sap_developers_ims_Concepts WHERE status='ACTIVE'`))[0].N;
  const published  = (await db.run(`SELECT COUNT(*) AS N FROM com_sap_developers_ims_Concepts WHERE status='ACTIVE' AND publishedAt IS NOT NULL`))[0].N;
  const eligible   = (await db.run(`SELECT COUNT(*) AS N FROM com_sap_developers_ims_Concepts WHERE status='ACTIVE' AND publishedAt IS NULL`))[0].N;

  console.log(`Concepts:`);
  console.log(`  total        ${total}`);
  console.log(`  ACTIVE       ${active}`);
  console.log(`  published    ${published}`);
  console.log(`  eligible     ${eligible}  (status=ACTIVE AND publishedAt IS NULL)`);
  console.log();

  if (eligible === 0) {
    console.log('Nothing to publish — every ACTIVE concept is already published.');
    return;
  }

  // 2. Rank by link count. Concept rows that have zero TutorialConceptLinks
  // are excluded (publishing them wouldn't change widget coverage).
  // HANA-side LEFT JOIN + GROUP BY is the cheapest plan for ~1,600 rows.
  const candidates = await db.run(`
    SELECT
      c.ID         AS id,
      c.slug       AS slug,
      c.name       AS name,
      COUNT(tcl.tutorial_ID) AS linkcount
    FROM com_sap_developers_ims_Concepts c
    JOIN com_sap_developers_ims_TutorialConceptLinks tcl
      ON tcl.concept_ID = c.ID
    WHERE c.status = 'ACTIVE'
      AND c.publishedAt IS NULL
    GROUP BY c.ID, c.slug, c.name
    ORDER BY COUNT(tcl.tutorial_ID) DESC, c.slug ASC
    LIMIT ${LIMIT}
  `);

  if (candidates.length === 0) {
    console.log('No candidate concepts have TutorialConceptLinks — nothing to publish.');
    return;
  }

  // Distinct-tutorial coverage union (so we can estimate widget impact).
  const ids = candidates.map(c => c.ID ?? c.id);
  const placeholders = ids.map(() => '?').join(',');
  const coverage = await db.run(
    `SELECT COUNT(DISTINCT tutorial_ID) AS N
     FROM com_sap_developers_ims_TutorialConceptLinks
     WHERE concept_ID IN (${placeholders})`,
    ids,
  );
  const distinctTutorials = coverage[0]?.N ?? coverage[0]?.n ?? 0;

  console.log(`Top ${candidates.length} eligible concepts by link count:`);
  console.log(`(Publishing unlocks teaches[] for ${distinctTutorials} distinct tutorials)`);
  console.log();
  console.log(`  rank  links  slug                                            name`);
  console.log(`  ----  -----  ----------------------------------------------  ----------------`);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const slug = String(c.SLUG ?? c.slug).padEnd(46).slice(0, 46);
    const name = String(c.NAME ?? c.name ?? '').slice(0, 60);
    const linkcount = String(c.LINKCOUNT ?? c.linkcount).padStart(5);
    console.log(`  ${String(i + 1).padStart(4)}  ${linkcount}  ${slug}  ${name}`);
  }
  console.log();

  if (!COMMIT) {
    console.log('Dry-run — no changes written. Re-run with --commit to publish.');
    return;
  }

  // 3. Write. One UPDATE per row using the same column writes as the
  // publishConcept bound action (publishedAt, publishedBy). Wrapped in a
  // transaction so a mid-run failure rolls back cleanly.
  console.log(`Writing publishedAt for ${candidates.length} concepts as initiator=${INITIATOR}...`);
  await db.tx(async tx => {
    for (const c of candidates) {
      await tx.run(
        `UPDATE com_sap_developers_ims_Concepts
         SET publishedAt = CURRENT_UTCTIMESTAMP,
             publishedBy = ?,
             modifiedAt  = CURRENT_UTCTIMESTAMP,
             modifiedBy  = ?
         WHERE ID = ?
           AND publishedAt IS NULL`,
        [INITIATOR, INITIATOR, c.ID ?? c.id],
      );
    }
  });
  console.log(`Done. ${candidates.length} concepts published. Distinct tutorial coverage: ${distinctTutorials}.`);
  console.log();
  console.log(`Verify on DEV:`);
  console.log(`  curl -s "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/kg-stats"`);
  console.log(`  → expect "concepts" count to jump by ${candidates.length}.`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});

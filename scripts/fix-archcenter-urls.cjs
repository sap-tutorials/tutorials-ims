#!/usr/bin/env node
// scripts/fix-archcenter-urls.cjs
//
// Targeted data fix for PR #2948 follow-up: already-stored HelpDocs rows for the
// SAP Architecture Center (source='architecture-sap-com') still carry the old
// path-derived URLs (…/docs/ref-arch/RA0029/…/readme) that 404. PR #2948 fixed
// URL *generation* going forward, but never repaired existing rows. The weekly
// fetch-help-docs cron would also correct these, but only when it re-fetches AND
// TUTORIALS_GITHUB_TOKEN is bound. This script repairs the rows surgically — no
// full corpus regen, no LLM cost, nothing else touched.
//
// Each target is keyed by (source, sourceId). The corrected URL is the live
// Docusaurus slug route, verified 200 against architecture.learning.sap.com.
//
// Usage (via cds bind so it hits the bound HANA):
//   cds bind --exec -- node scripts/fix-archcenter-urls.cjs            # dry-run (default)
//   cds bind --exec -- node scripts/fix-archcenter-urls.cjs --commit   # apply
//
// Idempotent: re-running after a successful apply updates 0 rows.

const cds = require('@sap/cds');

const SOURCE = 'architecture-sap-com';
const SITE_BASE = 'https://architecture.learning.sap.com';

// sourceId (repo-relative path) → corrected URL. For ref-arch docs the fix is
// the Docusaurus slug route (`${SITE_BASE}/docs${slug}`); for the dated news
// post it is the blog date-path route (`${SITE_BASE}/news/YYYY/MM/DD/rest`).
// Every target below was verified 200 against the live site.
const FIXES = [
  { sourceId: 'docs/ref-arch/RA0029/readme.md', url: `${SITE_BASE}/docs/ref-arch/98efa0` },
  { sourceId: 'docs/ref-arch/RA0029/1-a2a-and-mcp/readme.md', url: `${SITE_BASE}/docs/ref-arch/76ec36` },
  { sourceId: 'docs/ref-arch/RA0029/4-integrate-ai-agents-with-joule/readme.md', url: `${SITE_BASE}/docs/ref-arch/ae6821` },
  { sourceId: 'docs/ref-arch/RA0029/5-integrate-joule-agents-and-tools-into-your-ecosystem/readme.md', url: `${SITE_BASE}/docs/ref-arch/fe0d1d` },
  { sourceId: 'docs/ref-arch/RA0029/5-integrate-joule-agents-and-tools-into-your-ecosystem/1-aws-integration/readme.md', url: `${SITE_BASE}/docs/ref-arch/b4d7e2` },
  { sourceId: 'docs/ref-arch/RA0039/readme.md', url: `${SITE_BASE}/docs/ref-arch/5hj89h` },
  { sourceId: 'news/2026-10-27-a2a-agent-gateway-interoperability.md', url: `${SITE_BASE}/news/2026/10/27/a2a-agent-gateway-interoperability` },
];

const COMMIT = process.argv.includes('--commit');

async function main() {
  await cds.connect.to('db');
  const { HelpDocs, HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');

  console.log(`\nfix-archcenter-urls — ${COMMIT ? 'COMMIT' : 'DRY-RUN'} mode`);
  console.log('='.repeat(72));

  let planned = 0;
  let changed = 0;
  const plan = [];
  const presentIds = [];   // every target HelpDoc row that EXISTS (for the nudge),
                           // independent of whether its url needed changing.

  for (const { sourceId, url: newUrl } of FIXES) {
    // Metadata-only read (never SELECT description/LOB alongside) — LOB-locator safe.
    const row = await SELECT.one
      .from(HelpDocs)
      .columns('ID', 'sourceId', 'url')
      .where({ source: SOURCE, sourceId });

    if (!row) {
      console.log(`  MISSING  ${sourceId}\n           (no row — skipping; nothing to fix)`);
      continue;
    }
    presentIds.push(row.ID);
    if (row.url === newUrl) {
      console.log(`  OK       ${sourceId}\n           already ${newUrl}`);
      continue;
    }
    planned++;
    plan.push({ ID: row.ID, sourceId, oldUrl: row.url, newUrl });
    console.log(`  FIX      ${sourceId}`);
    console.log(`           old: ${row.url}`);
    console.log(`           new: ${newUrl}`);
  }

  console.log('='.repeat(72));
  console.log(`${planned} row(s) need update, ${FIXES.length - planned} already correct/missing.`);

  if (!COMMIT) {
    console.log('\nDRY-RUN — no writes. Re-run with --commit to apply.\n');
    return;
  }

  for (const p of plan) {
    const n = await UPDATE(HelpDocs).set({ url: p.newUrl }).where({ ID: p.ID });
    changed += n;
  }
  console.log(`\nApplied: ${changed} url row(s) updated (${plan.length === 0 ? 'all already correct' : ''}).`);

  // Concept-publish digest nudge (#2948 follow-up): the concept re-render phase
  // keys its delta on concept-input-digest.js, which probes max(modifiedAt) over
  // HelpDocConceptLinks — but NOT over HelpDocs. So a bare HelpDocs.url change
  // does NOT bump the digest, and a full publish would phase-skip and never
  // re-bake the corrected href into the concept BLOB. Touching the linking rows
  // bumps their managed modifiedAt (= $now on any UPDATE) so the next full
  // publish re-renders the affected concept pages. We write each row's EXISTING
  // modelVersion back unchanged — content-neutral (no column value altered),
  // modifiedAt is the only field that moves.
  //
  // IMPORTANT: nudge ALL present target HelpDocs' links, not just the ones whose
  // url changed this run. On a re-run where urls are already correct (idempotent
  // path), the data is right but the served BLOB may still be stale — the nudge
  // is exactly what forces the re-bake, so it must fire regardless of `changed`.
  let touched = 0;
  if (presentIds.length > 0) {
    const linkRows = await SELECT.from(HelpDocConceptLinks)
      .columns('ID', 'modelVersion')
      .where({ helpDoc_ID: { in: presentIds } });
    for (const lr of linkRows) {
      touched += await UPDATE(HelpDocConceptLinks)
        .set({ modelVersion: lr.modelVersion })  // same value → only modifiedAt moves
        .where({ ID: lr.ID });
    }
  }
  console.log(`Digest nudge: touched ${touched} HelpDocConceptLinks row(s) (bumps modifiedAt for concept re-render; values unchanged).`);

  if (plan.length === 0 && touched === 0) {
    console.log('\nNothing to apply and no links to nudge.\n');
    return;
  }

  // Post-write read-back for audit.
  console.log('\nVerification (stored url after write):');
  for (const p of plan) {
    const row = await SELECT.one.from(HelpDocs).columns('url').where({ ID: p.ID });
    const ok = row && row.url === p.newUrl;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${p.sourceId} => ${row ? row.url : '(gone)'}`);
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('fix-archcenter-urls FAILED:', err.message || err);
    process.exit(1);
  });

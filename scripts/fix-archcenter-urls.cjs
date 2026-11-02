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

// sourceId (repo-relative path) → corrected slug (as it appears in frontmatter).
// Final URL = `${SITE_BASE}/docs${slug}`. Slugs are root-absolute (leading /).
const FIXES = [
  { sourceId: 'docs/ref-arch/RA0029/readme.md', slug: '/ref-arch/98efa0' },
  { sourceId: 'docs/ref-arch/RA0029/1-a2a-and-mcp/readme.md', slug: '/ref-arch/76ec36' },
  { sourceId: 'docs/ref-arch/RA0029/4-integrate-ai-agents-with-joule/readme.md', slug: '/ref-arch/ae6821' },
  { sourceId: 'docs/ref-arch/RA0029/5-integrate-joule-agents-and-tools-into-your-ecosystem/readme.md', slug: '/ref-arch/fe0d1d' },
  { sourceId: 'docs/ref-arch/RA0029/5-integrate-joule-agents-and-tools-into-your-ecosystem/1-aws-integration/readme.md', slug: '/ref-arch/b4d7e2' },
  { sourceId: 'docs/ref-arch/RA0039/readme.md', slug: '/ref-arch/5hj89h' },
];

const COMMIT = process.argv.includes('--commit');

async function main() {
  await cds.connect.to('db');
  const { HelpDocs } = cds.entities('com.sap.developers.ims.external');

  console.log(`\nfix-archcenter-urls — ${COMMIT ? 'COMMIT' : 'DRY-RUN'} mode`);
  console.log('='.repeat(72));

  let planned = 0;
  let changed = 0;
  const plan = [];

  for (const { sourceId, slug } of FIXES) {
    const newUrl = `${SITE_BASE}/docs${slug}`;
    // Metadata-only read (never SELECT description/LOB alongside) — LOB-locator safe.
    const row = await SELECT.one
      .from(HelpDocs)
      .columns('ID', 'sourceId', 'url')
      .where({ source: SOURCE, sourceId });

    if (!row) {
      console.log(`  MISSING  ${sourceId}\n           (no row — skipping; nothing to fix)`);
      continue;
    }
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
  if (planned === 0) {
    console.log('\nNothing to apply.\n');
    return;
  }

  for (const p of plan) {
    const n = await UPDATE(HelpDocs).set({ url: p.newUrl }).where({ ID: p.ID });
    changed += n;
  }
  console.log(`\nApplied: ${changed} row(s) updated.`);

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

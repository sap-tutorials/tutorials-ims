#!/usr/bin/env node
// One-shot backfill for #985: populate Missions.sourceKgCommunityFingerprint
// for missions promoted from a KG community before the fingerprint column
// existed. Idempotent: skips rows where the fingerprint is already set.
//
// The fingerprint for an existing promoted mission is SHA-256 hex over the
// sorted slug list of the mission's tutorial-typed CompletionPathItems —
// which is exactly the tutorial set the promotion handler wrote at draft
// time (see srv/admin-service.js promoteCommunityToMission). This means
// the backfill re-derives the same fingerprint the handler would produce
// today for that mission, giving KgCommunitySummaryV's LEFT JOIN a match
// after the next Louvain pass — even though the source communityId has
// rotated.
//
// Rows on DEV: expected to be zero at land time — #917 hasn't seen a
// production promotion yet. Landed for completeness / for hybrid tests
// that seed missions with sourceKgCommunityId but no fingerprint, and
// as a documented recovery path if anyone hand-writes a row via the
// admin UI in the future.
//
// Usage:
//   npx cds bind --exec -- node scripts/backfill-kg-community-fingerprint.js [--dry-run]

import cds from '@sap/cds';
import { computeKgCommunityFingerprint } from '../srv/lib/kg-community-fingerprint.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  process.env.cds_requires_auth_kind = 'mocked';
  await cds.load('*');
  const db = await cds.connect.to('db');

  // Candidate rows: promoted from a KG community (sourceKgCommunityId is
  // non-null) but fingerprint hasn't been written yet.
  const candidates = await db.run(`
    SELECT m."ID", m."slug", m."sourceKgCommunityId"
    FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" m
    WHERE m."sourceKgCommunityId" IS NOT NULL
      AND m."sourceKgCommunityFingerprint" IS NULL
  `);

  if (candidates.length === 0) {
    console.log('No missions require fingerprint backfill.');
    process.exit(0);
  }

  console.log(`${candidates.length} mission(s) need fingerprint backfill.`);

  let updated = 0;
  let skippedEmpty = 0;
  for (const m of candidates) {
    // Reconstruct the mission's tutorial slug set by walking its
    // CompletionPaths → CompletionPathItems → Tutorials.
    const tutorials = await db.run(
      `SELECT t."slug"
       FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS" i
       JOIN "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" p ON i."path_ID" = p."ID"
       JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON i."tutorial_ID" = t."ID"
       WHERE p."mission_ID" = ? AND i."taskType" = 'TUTORIAL'`,
      [m.ID]
    );
    const slugs = tutorials.map((t) => t.slug).filter(Boolean);
    if (slugs.length === 0) {
      console.warn(`  ${m.slug}: skipped — no tutorial members resolvable`);
      skippedEmpty++;
      continue;
    }
    const fingerprint = computeKgCommunityFingerprint(slugs);
    if (dryRun) {
      console.log(`  ${m.slug} (${slugs.length} tutorials) → ${fingerprint}`);
    } else {
      await db.run(
        `UPDATE "COM_SAP_DEVELOPERS_IMS_MISSIONS"
           SET "sourceKgCommunityFingerprint" = ?
         WHERE "ID" = ?`,
        [fingerprint, m.ID]
      );
      updated++;
    }
  }

  if (dryRun) {
    console.log(`\nDry run — would update ${candidates.length - skippedEmpty} mission(s).`);
  } else {
    console.log(`\nUpdated ${updated} mission(s); skipped ${skippedEmpty} (no tutorial members).`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('Error:', e); process.exit(1); });

#!/usr/bin/env node
// scripts/reclassify-contentless-tutorials.cjs
//
// Issue #1960: soft-delete Tutorials rows that are still status ACTIVE (or
// null) but have NO published content, so they stop surfacing in search and
// every other status-gated query.
//
// THE PROBLEM
//   The legacy IMS→CAP migration (scripts/migrate-from-hana.js) inserted an
//   ACTIVE Tutorials row for every non-deleted IMS tutorial. Some of those
//   tutorials' content lives ONLY in a private `<topic>-Contribution` repo
//   (e.g. data-warehouse-cloud-Contribution / datasphere-skills-club-
//   Contribution) which the prod fetch pipeline deliberately excludes
//   (scripts/parsers/github.ts). Their content was never published to HANA,
//   so `/tutorials/<slug>` 404s — yet the ACTIVE metadata row still matches
//   the SearchableItems view (db/views.cds, `status is null or 'ACTIVE'`) and
//   shows up in the tutorial navigator. On DEV that was 127 rows (40
//   datasphere/data-warehouse-cloud plus 87 other legacy topics such as
//   cp-portal-* / cp-mobile-cards-*).
//
// THE FIX
//   A tutorial "serves" iff it has a ContentFiles row at the ACTIVE
//   ContentManifest version (that is exactly what content-store.js#serveHandler
//   reads; anything else 404s). This script finds ACTIVE/null-status tutorials
//   whose slug is NOT in that live set and flips them to status='DELETED'.
//   Once DELETED they fall out of SearchableItems (status filter) and every
//   other ACTIVE-gated read — no redeploy required.
//
// WHY THIS IS DURABLE (won't be undone by the next rebuild)
//   The content-publish upsert force-sets status='ACTIVE' ONLY for slugs it
//   actually publishes (content-publish-session.js). These slugs are never
//   fetched (Contribution repos are excluded from prod), so publish never
//   touches them and DELETED sticks. If real content is ever published for a
//   slug later, that same upsert self-heals it back to ACTIVE.
//
// SAFETY
//   - Verified on DEV before writing this: of the ACTIVE rows with no
//     ContentFiles at the active version, ZERO actually serve content, and
//     ZERO live-serving tutorials lack that row — the criterion is exact.
//   - Only touches rows whose status is ACTIVE or null. INACTIVE (admin-
//     managed) and already-DELETED rows are left alone.
//   - Status-only column update — no hard delete, no cascade.
//   - Idempotent: re-runs converge (nothing left to flip once committed).
//   - Refuses to run if the active-version live-content set is empty (guards
//     against nuking the whole catalog if the manifest can't be resolved).
//
// Usage (from a `cf login`-authenticated shell targeting the right space):
//   npx cds bind --exec --profile hybrid -- node scripts/reclassify-contentless-tutorials.cjs
//   npx cds bind --exec --profile hybrid -- node scripts/reclassify-contentless-tutorials.cjs --commit
//
// Flags:
//   --commit           apply the UPDATEs (default is dry-run)
//   --status <VALUE>   target status to set (default: DELETED)
//   --initiator <str>  attribution label for logs

'use strict';

const cds = require('@sap/cds');

const NS = 'com.sap.developers.ims';
const norm = (s) => (typeof s === 'string' ? s.toLowerCase() : s);

/**
 * Core logic — resolves the contentless ACTIVE/null tutorials and, when
 * `commit` is set, flips them to `targetStatus`. Assumes the `db` service is
 * already connected (cds.connect.to('db') or a cds.test bootstrap) and the
 * `${NS}` entities are in the model.
 *
 * @returns {Promise<{activeVersion:number, liveSlugCount:number, candidateCount:number, toDelete:Array, updated:number}>}
 */
async function reclassifyContentless({ commit = false, targetStatus = 'DELETED', log } = {}) {
  const logger = log || cds.log('reclassify-contentless');
  const { Tutorials, ContentFiles, ContentManifest } = cds.entities(NS);

  // ── Resolve the ACTIVE content version (ground truth for "serves").
  const [manifest] = await SELECT.from(ContentManifest)
    .columns('version')
    .where({ status: 'ACTIVE' })
    .orderBy('version desc')
    .limit(1);
  if (!manifest || manifest.version == null) {
    logger.warn('no ACTIVE ContentManifest row found — refusing to run (cannot determine live content set)');
    return { activeVersion: null, liveSlugCount: 0, candidateCount: 0, toDelete: [], updated: 0 };
  }
  const activeVersion = manifest.version;
  logger.info(`active content version = ${activeVersion}`);

  // ── Set of slugs that actually serve content at the active version.
  const liveFiles = await SELECT.from(ContentFiles)
    .columns('slug')
    .where({ version: activeVersion });
  const liveSlugs = new Set(liveFiles.map((r) => norm(r.slug)).filter(Boolean));
  logger.info(`live content slugs at v${activeVersion}: ${liveSlugs.size}`);

  if (!liveSlugs.size) {
    logger.warn('live content set is empty — refusing to run (would delete everything)');
    return { activeVersion, liveSlugCount: 0, candidateCount: 0, toDelete: [], updated: 0 };
  }

  // ── Candidate tutorials: status ACTIVE or null, whose slug has no live
  // content. Fetch all (3 columns) and filter in Node — mirrors
  // scripts/soft-delete-sandbox-tutorials.cjs and avoids OR-in-CQL quirks.
  const allTuts = await SELECT.from(Tutorials).columns('ID', 'slug', 'status');
  const isCandidate = (t) => t.status == null || t.status === 'ACTIVE';
  const candidateCount = allTuts.filter(isCandidate).length;

  const toDelete = allTuts.filter(
    (t) => isCandidate(t) && t.slug && !liveSlugs.has(norm(t.slug))
  );

  let updated = 0;
  if (commit && toDelete.length) {
    // Chunk the IN-list to stay under HANA's parameter/packet cap
    // ([[cqn-where-in-hana-packet-cap]]).
    const ids = toDelete.map((r) => r.ID);
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      await UPDATE(Tutorials).set({ status: targetStatus }).where({ ID: { in: batch } });
      updated += batch.length;
    }
  }

  return {
    activeVersion,
    liveSlugCount: liveSlugs.size,
    candidateCount,
    toDelete,
    updated,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const COMMIT = argv.includes('--commit');
  const statusIdx = argv.indexOf('--status');
  const TARGET_STATUS = statusIdx >= 0 ? argv[statusIdx + 1] : 'DELETED';
  const initIdx = argv.indexOf('--initiator');
  const INITIATOR =
    initIdx >= 0
      ? argv[initIdx + 1]
      : process.env.INITIATOR || 'scripts/reclassify-contentless-tutorials';

  const log = cds.log('reclassify-contentless');
  log.info(`mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} target=${TARGET_STATUS} initiator=${INITIATOR}`);

  // Load + compile the CDS model so cds.entities() resolves under
  // `cds bind --exec`. Mirrors scripts/soft-delete-sandbox-tutorials.cjs.
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  await cds.connect.to('db');

  const result = await reclassifyContentless({ commit: COMMIT, targetStatus: TARGET_STATUS, log });

  console.log('\nslug,current_status');
  for (const row of result.toDelete) console.log(`${row.slug},${row.status ?? ''}`);
  console.log(
    `\nsummary: active_or_null=${result.candidateCount} contentless=${result.toDelete.length} -> ${TARGET_STATUS}`
  );

  if (!COMMIT) {
    log.info('dry-run only — re-run with --commit to apply');
  } else {
    log.info(`committed ${result.updated} row(s) -> status=${TARGET_STATUS}`);
  }
}

module.exports = { reclassifyContentless };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

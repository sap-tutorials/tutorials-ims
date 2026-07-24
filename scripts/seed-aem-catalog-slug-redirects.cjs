#!/usr/bin/env node
// scripts/seed-aem-catalog-slug-redirects.cjs
//
// Seed GroupSlugRedirects / MissionSlugRedirects with the LEGACY AEM catalog
// slugs so old developers.sap.com bookmarks survive the cutover.
//
// THE PROBLEM (dev, 2026-07-24):
//   Legacy AEM served group/mission pages at the site root as
//     /group.<aemSlug>.html   /mission.<aemSlug>.html
//   PR #1310's approuter/lib/catalog-legacy-redirects.js rewrites the URL SHAPE
//     /group.<aemSlug>.html -> /tutorials/group-<aemSlug>
//   but passes the slug through UNCHANGED. At cutover, slugs were regenerated
//   from titles via slugify(title), so the short AEM slug
//     deploy-full-stack-cap-kyma-runtime
//   no longer matches the current canonical slug
//     deploy-a-full-stack-cap-application-in-sap-btp-kyma-runtime-following-sap-btp-developer-s-guide
//   => the rewritten URL 404s in content-store.js serveHandler.
//
// THE FIX (reuses existing machinery, no serving-code change):
//   serveHandler (srv/lib/content-store.js:871-906) already consults
//   GroupSlugRedirects / MissionSlugRedirects and 301s an old slug to the
//   entity's CURRENT slug. Those tables are only populated by admin renames
//   (admin-service.js:966-982) and were never seeded with AEM slugs. This
//   script seeds them from the cutover match files.
//
// SOURCE MAP (oldAemSlug -> dbId):
//   .migration-data/cutover-<ts>/aem-group-matches.json   (193 rows)
//   .migration-data/cutover-<ts>/aem-mission-matches.json ( 87 rows)
//   Each row: { slug: <aemSlug>, title, dbId: <entity ID (UUID)> }
//   dbId === Groups.ID / Missions.ID (TaskBase : cuid).
//
// SAFETY:
//   - Skip when oldSlug === currentSlug (no redirect needed).
//   - Skip when oldSlug is a LIVE slug of ANY group/mission — a redirect row
//     is consulted BEFORE the catalog render, so seeding it would SHADOW a real
//     page. Whoever owns the slug now wins.
//   - Skip when a redirect row already holds oldSlug (unique constraint + idempotent).
//   - Skip when dbId is not a current live entity (stale match row).
//   - Deterministic UUIDv5 row IDs (namespace below) so re-runs and DEV/PROD
//     converge on identical bytes, matching the project's seed convention.
//
// Usage:
//   cds bind --exec -- node scripts/seed-aem-catalog-slug-redirects.cjs --dry-run
//   cds bind --exec -- node scripts/seed-aem-catalog-slug-redirects.cjs --commit
//
// Exit: 0 ok · 2 bad args · 1 runtime error.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cds = require('@sap/cds');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const COMMIT = args.includes('--commit');
const VERBOSE = args.includes('--verbose');

if (!DRY_RUN && !COMMIT) {
  console.error('Refusing to run without --dry-run or --commit.');
  process.exit(2);
}
if (DRY_RUN && COMMIT) {
  console.error('Pass exactly one of --dry-run / --commit.');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');

// Permanent namespace for deterministic UUIDv5 redirect-row IDs. Distinct from
// the migration namespaces; changing it would orphan previously-seeded rows.
const NS = 'a1f0c9e2-7b34-5d68-9a21-aem-slug-redirect';
// uuidv5 needs a 16-byte namespace; derive one deterministically from the label.
const NS_BYTES = crypto.createHash('sha1').update(NS).digest().subarray(0, 16);
function uuidv5(name) {
  const h = crypto.createHash('sha1');
  h.update(NS_BYTES);
  h.update(Buffer.from(name, 'utf8'));
  const b = h.digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = b.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function findCutoverDir() {
  const base = path.join(ROOT, '.migration-data');
  const dirs = fs.readdirSync(base)
    .filter(d => d.startsWith('cutover-'))
    .sort()
    .reverse();
  if (!dirs.length) throw new Error('no .migration-data/cutover-* directory found');
  // Not every cutover run captured the AEM match files — pick the NEWEST dir
  // that actually contains BOTH, rather than blindly the newest by timestamp.
  const REQUIRED = ['aem-group-matches.json', 'aem-mission-matches.json'];
  const withMatches = dirs.find(d =>
    REQUIRED.every(f => fs.existsSync(path.join(base, d, f)))
  );
  if (!withMatches) {
    throw new Error(
      `no cutover-* dir contains ${REQUIRED.join(' + ')} (checked ${dirs.length} dirs)`
    );
  }
  return path.join(base, withMatches);
}

function loadMatches(dir, file) {
  const p = path.join(dir, file);
  const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`${file} is not an array`);
  return rows;
}

(async () => {
  // Model priming — cds bind --exec does not run the serving lifecycle. #757/#911
  cds.model = cds.linked(await cds.load('*'));
  void cds.model.entities;
  const db = await cds.connect.to('db');

  const { Groups, Missions, GroupSlugRedirects, MissionSlugRedirects } =
    cds.entities('com.sap.developers.ims');

  const cutoverDir = findCutoverDir();
  console.log(`[seed] cutover source: ${path.relative(ROOT, cutoverDir)}`);

  const specs = [
    { kind: 'group',   Entity: Groups,   Redirect: GroupSlugRedirects,   fk: 'group_ID',   matches: loadMatches(cutoverDir, 'aem-group-matches.json') },
    { kind: 'mission', Entity: Missions, Redirect: MissionSlugRedirects, fk: 'mission_ID', matches: loadMatches(cutoverDir, 'aem-mission-matches.json') },
  ];

  const summary = [];

  for (const { kind, Entity, Redirect, fk, matches } of specs) {
    // Live slug/ID snapshot for this entity type.
    const live = await SELECT.from(Entity).columns('ID', 'slug');
    const idToSlug = new Map(live.map(r => [r.ID, r.slug]));
    const liveSlugs = new Set(live.map(r => r.slug).filter(Boolean).map(s => s.toLowerCase()));

    // Existing redirect rows (idempotency + unique-slug guard).
    const existing = await SELECT.from(Redirect).columns('slug');
    const existingSlugs = new Set(existing.map(r => (r.slug || '').toLowerCase()));

    const toInsert = [];
    const skip = { sameSlug: 0, shadowsLive: 0, alreadySeeded: 0, staleDbId: 0, noSlug: 0 };

    for (const m of matches) {
      const oldSlug = (m.slug || '').trim();
      const dbId = m.dbId;
      if (!oldSlug) { skip.noSlug++; continue; }
      if (!dbId || !idToSlug.has(dbId)) { skip.staleDbId++; continue; }

      const currentSlug = idToSlug.get(dbId);
      const oldLc = oldSlug.toLowerCase();

      if (currentSlug && currentSlug.toLowerCase() === oldLc) { skip.sameSlug++; continue; }
      if (liveSlugs.has(oldLc)) { skip.shadowsLive++; if (VERBOSE) console.log(`  [skip shadows-live] ${kind} ${oldSlug} (a live page owns this slug)`); continue; }
      if (existingSlugs.has(oldLc)) { skip.alreadySeeded++; continue; }

      toInsert.push({
        ID: uuidv5(`${kind}:${oldSlug}`),
        [fk]: dbId,
        slug: oldSlug,
        _current: currentSlug,
      });
      existingSlugs.add(oldLc); // guard against dup within this run
    }

    console.log(`\n[${kind}] matches=${matches.length} live=${live.length} existingRedirects=${existing.length}`);
    console.log(`  to insert: ${toInsert.length}`);
    console.log(`  skipped: sameSlug=${skip.sameSlug} shadowsLive=${skip.shadowsLive} alreadySeeded=${skip.alreadySeeded} staleDbId=${skip.staleDbId} noSlug=${skip.noSlug}`);
    if (VERBOSE || DRY_RUN) {
      for (const r of toInsert.slice(0, 10)) {
        console.log(`    ${r.slug}  ->  /tutorials/${kind}-${r._current}`);
      }
      if (toInsert.length > 10) console.log(`    … +${toInsert.length - 10} more`);
    }

    summary.push({ kind, insert: toInsert.length, ...skip });

    if (COMMIT && toInsert.length) {
      const entries = toInsert.map(({ _current, ...row }) => row);
      await INSERT.into(Redirect).entries(entries);
      console.log(`  ✓ inserted ${entries.length} ${kind} redirect rows`);
    }
  }

  const totalInsert = summary.reduce((a, s) => a + s.insert, 0);
  console.log(`\n[seed] ${DRY_RUN ? 'DRY RUN' : 'COMMIT'} — total rows ${DRY_RUN ? 'that WOULD be' : ''} inserted: ${totalInsert}`);
  if (DRY_RUN) console.log('[seed] no writes performed. Re-run with --commit to apply.');
  await cds.disconnect?.();
  process.exit(0);
})().catch(err => {
  console.error('[seed] FAILED:', err?.stack || err);
  process.exit(1);
});

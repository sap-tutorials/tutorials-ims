// scripts/check-sitemap-tutorials.cjs
//
// Build-time guard for the runtime-push (rebuild-content.yml) path. Fails the
// run if the baked hugo/public/sitemap.xml contains ZERO /tutorials/ <loc>
// entries — the exact signature of a sitemap wiped down to only its
// non-tutorial pages.
//
// Root cause it prevents (reported 2026-09-03 by the Intelligent Search Data
// Crawling team — crawled docs dropped ~1700 → ~1500, live sitemap held only
// ~180 links):
//   /sitemap.xml is served from HANA as the `page-sitemap.xml` blob (see
//   srv/lib/page-key-map.js IN_SCOPE_PAGES). publish-content.ts merges that
//   page-* blob into the publish set via discoverPageFiles() — but ONLY when
//   NOT slug-scoped (`if (!opts.slug)`). So:
//     - slug-targeted  → page-sitemap.xml NOT republished (server carries it
//                        forward). SAFE.
//     - full           → "Fetch tutorials" runs, Hugo bakes the full ~1.4k
//                        tutorial <urlset>, republishes the good sitemap. SAFE.
//     - catalog-only   → "Fetch tutorials" is SKIPPED, so hugo/content/tutorials
//                        is EMPTY, Hugo bakes a sitemap with NO /tutorials/ URLs,
//                        and that tutorial-less blob is republished — WIPING the
//                        live sitemap to ~180 URLs. THIS is the wipe class.
//   Same family as the /browse/ (2026-08-07) and /authors/ (#1659 Phase C)
//   catalog-only wipes. The durable fix pairs this guard with
//   scripts/seed-sitemap-from-deployed.ts, which re-hydrates the deployed
//   sitemap in catalog-only BEFORE this guard runs so a legit catalog-only
//   rebuild carries the tutorial <loc>s forward and passes.
//
// This guard is the fail-closed net: whatever the cause (broken preserve step,
// a future mode that skips fetch, a bad Hugo build), if the sitemap about to be
// published names zero tutorials it FAILS the run rather than let publish-content
// clobber the good page-sitemap.xml blob. A hard red run is visible and
// recoverable (re-run mode=full); a silently wiped sitemap is the incident.
//
// Why a standalone .cjs (not a prebuild hook): the project's global npm config
// sets ignore-scripts=true, which blocks all pre/post lifecycle hooks. Invoked
// as an explicit workflow step. Mirrors scripts/check-verb-shelves.cjs.
//
// Exit codes:
//   0  sitemap has >= MIN_SITEMAP_TUTORIALS tutorial <loc> entries.
//   1  sitemap file missing/unreadable, OR fewer than the minimum tutorial URLs
//      (default 1). Set ALLOW_EMPTY_SITEMAP=1 to allow zero (genuinely empty
//      seed envs), mirroring seed-browse's ALLOW_EMPTY_BROWSE escape hatch.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Pure core (unit-tested in scripts/__tests__/check-sitemap-tutorials.test.ts).
// Count <loc> entries whose URL path is under /tutorials/. Host-agnostic: matches
// both absolute (https://developers.sap.com/tutorials/<slug>/) and, defensively,
// root-relative (/tutorials/<slug>/) forms. The bare section index /tutorials/
// (no trailing slug) is excluded from the sitemap by the template, so any match
// here is a real tutorial page.
// ---------------------------------------------------------------------------
function countTutorialLocs(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return 0;
  let count = 0;
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    let loc = m[1];
    // Strip scheme+host so we compare on the path only.
    const pathOnly = loc.replace(/^https?:\/\/[^/]+/i, '');
    // A real tutorial URL has a slug after /tutorials/ — require a non-empty
    // path segment so the bare /tutorials/ section index (if ever emitted) and
    // /tutorials-<something> siblings don't count.
    if (/^\/tutorials\/[^/][^<]*$/i.test(pathOnly)) count += 1;
  }
  return count;
}

module.exports = { countTutorialLocs };

// ---------------------------------------------------------------------------
// CLI (only when run directly, so the pure core imports cleanly under Vitest).
// ---------------------------------------------------------------------------
function fail(lines) {
  console.error('');
  console.error('[rebuild] sitemap-tutorials guard FAILED:');
  for (const l of lines) console.error(`          ${l}`);
  console.error('');
  console.error('          /sitemap.xml is served from the HANA `page-sitemap.xml` blob and is');
  console.error('          republished on every full/catalog-only rebuild. A sitemap with no');
  console.error('          /tutorials/ URLs means the Hugo build had no tutorial content — a');
  console.error('          catalog-only rebuild that skipped "Fetch tutorials" and whose');
  console.error('          seed-sitemap-from-deployed.ts preserve step did not carry the');
  console.error('          deployed sitemap forward. Fix: re-run the rebuild with mode=full to');
  console.error('          regenerate the full sitemap, then catalog-only will preserve it.');
  console.error('');
  process.exit(1);
}

function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const hugoDir = argOf('--hugo-dir', 'hugo/public');
  const sitemapPath = path.resolve(process.cwd(), hugoDir, 'sitemap.xml');
  const allowEmpty = process.env.ALLOW_EMPTY_SITEMAP === '1';
  const min = allowEmpty ? 0 : Math.max(1, parseInt(process.env.MIN_SITEMAP_TUTORIALS || '1', 10));

  if (!fs.existsSync(sitemapPath)) {
    fail([`sitemap not found at ${path.relative(process.cwd(), sitemapPath)}.`,
          'The Hugo build did not emit a sitemap — check hugo.toml `home` outputs include \'sitemap\'.']);
  }

  let xml;
  try {
    xml = fs.readFileSync(sitemapPath, 'utf-8');
  } catch (err) {
    fail([`could not read ${sitemapPath}: ${err.message}`]);
  }

  const tutorialCount = countTutorialLocs(xml);
  const totalLocs = (xml.match(/<loc>/gi) || []).length;

  if (tutorialCount < min) {
    fail([`sitemap has ${tutorialCount} /tutorials/ URL(s) (require >= ${min}); ${totalLocs} <loc> total.`,
          'This is the wipe signature — the live sitemap would drop to non-tutorial pages only.']);
  }

  console.log(`[rebuild] sitemap-tutorials guard OK — ${tutorialCount} /tutorials/ URLs of ${totalLocs} total <loc>.`);
}

if (require.main === module) main();

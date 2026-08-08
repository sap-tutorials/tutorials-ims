import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// scripts/seed-browse-from-deployed.ts
//
// Fixes the "catalog-only rebuild wipes /browse/" bug (root-caused 2026-08-07).
//
// THE BUG
//   /browse/ is served from the approuter's OWN static dir (xs-app.json route
//   79 catch-all → static), NOT proxied to HANA like /tutorials/ and /concepts/.
//   Its card data is baked into browse/index.html at Hugo build time from
//   hugo/data/browse.json, which is written ONLY by writeBrowseData() inside
//   scripts/fetch-tutorials.ts (fetch-tutorials.ts:1253, guarded on
//   missions.length > 0).
//
//   The rebuild-content workflow skips fetch-tutorials.ts in `catalog-only`
//   mode (rebuild-content.yml "Fetch tutorials" step is `if effective_mode !=
//   'catalog-only'`) — so no browse.json is produced — but STILL runs the Hugo
//   build, the "Assemble static content" step, and the "Push content to
//   AppRouter" step (all gated only `!= 'slug-targeted'`). Hugo then renders an
//   EMPTY browse/index.html ("all":[]), the tarball carries it, and the
//   approuter's /admin/rebuild handler ATOMICALLY replaces its whole STATIC_DIR
//   with the tarball (approuter/server.js:336-339) — clobbering the good,
//   populated browse page a prior full rebuild / mta deploy had shipped.
//
// WHY NOT just regenerate browse in catalog-only?
//   buildAllCards() needs per-tutorial fields (time, level, missionId, groupId,
//   primaryTag, displayTags, stepCount) that come ONLY from the GitHub tutorial
//   markdown fetch — /build/catalog's `tutorials[]` carries just
//   {slug,title,description,categorySlugs}. catalog-only deliberately skips that
//   fetch (it's the fast admin-edit path), so the data to rebuild cards from
//   scratch is not present. Running the fetch would defeat the mode.
//
// THE FIX (this script)
//   In catalog-only mode, BEFORE the Hugo build, re-hydrate hugo/data/browse.json
//   from the browse page the approuter is CURRENTLY serving. The deployed
//   /browse/ inlines its data verbatim as `<script id="browse-data">…</script>`
//   in the exact browse.json shape ({all,featured,recent,categories,buildAt}),
//   so we fetch it, extract that JSON, and write it back. Hugo then re-renders
//   the SAME populated page and the tarball ships it — /browse/ is preserved
//   across content-only rebuilds instead of being wiped.
//
// FAIL-SAFE
//   If the deployed page can't be fetched, has no browse-data script, or the
//   blob is empty ("all":[]), this script EXITS NON-ZERO without writing. That
//   deliberately FAILS the catalog-only rebuild rather than let it proceed to
//   ship an empty browse page — a hard failure is visible and recoverable
//   (re-run mode=full), whereas silently wiping /browse/ is the exact incident
//   this fixes. The one acceptable "write empty" case — a genuinely empty
//   catalog — is handled by ALLOW_EMPTY_BROWSE=1 (used by fresh/seed envs).

const APPROUTER_URL = (process.env.APPROUTER_URL || '').replace(/\/+$/, '');
// Channel-aware target, mirroring scripts/fetch-tutorials.ts browseDataFile():
// prod → hugo/data/browse.json, qa → hugo/data-qa/browse.json.
const CHANNEL = process.env.BROWSE_CHANNEL === 'qa' ? 'qa' : 'prod';
const OUT_PATH = join('hugo', CHANNEL === 'qa' ? 'data-qa' : 'data', 'browse.json');
const ALLOW_EMPTY = process.env.ALLOW_EMPTY_BROWSE === '1';

export interface BrowseDataPayload {
  all?: unknown[];
  featured?: unknown[];
  recent?: unknown[];
  categories?: unknown[];
  buildAt?: string;
}

// The deployed /browse/ inlines the browse.json payload verbatim in a
// `<script id="browse-data" type="application/json">…</script>` tag. Hugo emits
// the id both quoted and unquoted depending on minification, so match either.
// Throws (never process.exit) so it stays pure + unit-testable; main() maps the
// throw to a fail-safe non-zero exit.
export function extractBrowseData(html: string): BrowseDataPayload {
  const m = html.match(/<script id=["']?browse-data["']?[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('deployed /browse/ has no <script id="browse-data"> block');
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`browse-data block is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('browse-data block did not parse to an object');
  }
  return parsed as BrowseDataPayload;
}

function die(msg: string): never {
  console.error(`[seed-browse] FAILED: ${msg}`);
  console.error('[seed-browse] Refusing to proceed — a catalog-only rebuild must not ship an empty /browse/.');
  console.error('[seed-browse] Recover by re-running the rebuild with mode=full, or set ALLOW_EMPTY_BROWSE=1 if the catalog is genuinely empty.');
  process.exit(1);
}

async function main() {
  if (!APPROUTER_URL) die('APPROUTER_URL is not set');

  let html: string;
  try {
    const res = await fetch(`${APPROUTER_URL}/browse/`, { redirect: 'follow' });
    if (!res.ok) die(`GET ${APPROUTER_URL}/browse/ returned ${res.status}`);
    html = await res.text();
  } catch (err) {
    die(`could not fetch ${APPROUTER_URL}/browse/ — ${err instanceof Error ? err.message : err}`);
  }

  let data: BrowseDataPayload;
  try {
    data = extractBrowseData(html);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  const cardCount = Array.isArray(data.all) ? data.all.length : 0;

  if (cardCount === 0 && !ALLOW_EMPTY) {
    die('deployed /browse/ browse-data is empty ("all":[]). This env has no populated browse page to preserve — a previous catalog-only rebuild may have already wiped it. Re-run with mode=full to regenerate.');
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[seed-browse] wrote ${cardCount} cards to ${OUT_PATH} (preserved from deployed ${APPROUTER_URL}/browse/, buildAt=${data.buildAt ?? '?'})`);
}

// Only run main() when invoked directly (not when imported by the unit test).
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}


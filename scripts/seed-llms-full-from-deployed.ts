import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// scripts/seed-llms-full-from-deployed.ts
//
// Preserves /llms-full.txt across catalog-only rebuilds — the SAME wipe class as
// the /browse/ (seed-browse-from-deployed.ts), /authors/ (seed-authors-from-
// deployed.ts) and /sitemap.xml (seed-sitemap-from-deployed.ts) preserve steps.
// Reported as issue #2584 (5 consecutive prod rebuild failures, the #1373 silent-
// failure signature): the "Verify SEO catalog freshness" gate went red with
// `expected 722 to be greater than 10000`.
//
// THE BUG
//   /llms-full.txt is served from HANA as the `page-llms-full.txt` blob (packages/
//   core/page-key-map.js IN_SCOPE_PAGES). scripts/publish-content.ts merges that
//   page-* blob into the publish set via discoverPageFiles() whenever the run is
//   NOT slug-scoped. Its body is rendered by hugo/layouts/_default/llmsfull.txt,
//   which ranges `.Site.RegularPages` of Type "tutorials" — i.e. the generated
//   markdown under hugo/content/tutorials/. The rebuild-content workflow skips
//   "Fetch tutorials" in catalog-only mode, so hugo/content/tutorials holds only
//   the committed test-tutorial fixture, the Hugo build bakes a ~722-byte
//   llms-full.txt, and publishing that thin blob WIPES the live full catalog
//   (~1.4k tutorials, >10 KB) down to a single fixture entry.
//
// WHY NOT just regenerate it in catalog-only?
//   Like /sitemap.xml, llms-full.txt is a Hugo build OUTPUT with no JSON data
//   input (it reads .Site.RegularPages, not .Site.Data) — it needs the ~1.4k
//   tutorial content pages present at build time. Those come ONLY from the GitHub
//   tutorial-markdown fetch that catalog-only deliberately skips (it's the fast
//   admin-edit path). Running the fetch would defeat the mode.
//
// THE FIX (this script)
//   In catalog-only mode, AFTER the Hugo build (like seed-sitemap, and UNLIKE
//   seed-browse/seed-authors which re-hydrate build INPUTS before the build),
//   overwrite the freshly-baked (fixture-only) hugo/public/llms-full.txt with the
//   body the approuter is CURRENTLY serving at /llms-full.txt. That deployed body
//   already carries the full catalog from the last full rebuild, so the publish
//   step carries it forward verbatim instead of shipping a wiped one. The
//   "Verify SEO catalog freshness" gate (test/smoke/seo-files.test.js) then runs
//   as the fail-closed net.
//
// FAIL-SAFE
//   If the deployed body can't be fetched, or is shorter than the catalog-fresh
//   threshold the SEO gate enforces (MIN_BYTES, kept in sync with
//   seo-files.test.js), this script EXITS NON-ZERO without writing — deliberately
//   FAILING the catalog-only rebuild rather than shipping a wiped llms-full.txt.
//   A hard failure is visible and recoverable (re-run mode=full); a silent wipe is
//   the exact incident #2584 reports. The one acceptable "empty" case (a fresh/
//   seed env with no tutorials yet) is handled by ALLOW_EMPTY_LLMS_FULL=1.

const APPROUTER_URL = (process.env.APPROUTER_URL || '').replace(/\/+$/, '');
const OUT_PATH = join('hugo', 'public', 'llms-full.txt');
const ALLOW_EMPTY = process.env.ALLOW_EMPTY_LLMS_FULL === '1';

// Catalog-fresh threshold. Kept in sync with test/smoke/seo-files.test.js
// (`expect(text.length).toBeGreaterThan(10000)` for /llms-full.txt): preserving a
// body below this would merely move the red run from the preserve step to the SEO
// gate, so fail here first with a clearer message.
export const MIN_BYTES = 10000;

// Count catalog entries (one "URL: " line per tutorial in llmsfull.txt). The
// fixture-only wipe produces exactly 1; a healthy catalog produces ~1.4k.
// Exported for the unit test (mirrors seed-sitemap's exported countTutorialLocs).
export function countCatalogEntries(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const m = text.match(/^URL:\s+\S/gim);
  return m ? m.length : 0;
}

function die(msg: string): never {
  console.error(`[seed-llms-full] FAILED: ${msg}`);
  console.error('[seed-llms-full] Refusing to proceed — a catalog-only rebuild must not ship a thin/wiped /llms-full.txt.');
  console.error('[seed-llms-full] Recover by re-running the rebuild with mode=full, or set ALLOW_EMPTY_LLMS_FULL=1 if the catalog is genuinely empty.');
  process.exit(1);
}

async function main() {
  if (!APPROUTER_URL) die('APPROUTER_URL is not set');

  let text: string;
  try {
    const res = await fetch(`${APPROUTER_URL}/llms-full.txt`, { redirect: 'follow' });
    if (!res.ok) die(`GET ${APPROUTER_URL}/llms-full.txt returned ${res.status}`);
    text = await res.text();
  } catch (err) {
    die(`could not fetch ${APPROUTER_URL}/llms-full.txt — ${err instanceof Error ? err.message : err}`);
  }

  if (!text.startsWith('# SAP Developers Tutorials')) {
    die('deployed /llms-full.txt does not start with the expected brand header (got an error page or redirect body?)');
  }

  if (text.length < MIN_BYTES && !ALLOW_EMPTY) {
    const entries = countCatalogEntries(text);
    die(
      `deployed /llms-full.txt is only ${text.length} bytes (${entries} catalog entr${entries === 1 ? 'y' : 'ies'}), ` +
      `below the ${MIN_BYTES}-byte catalog-fresh threshold. This env has no populated full catalog to preserve — a ` +
      `previous catalog-only rebuild may have already wiped it. Re-run with mode=full to regenerate.`,
    );
  }

  if (!existsSync(dirname(OUT_PATH))) mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, text, 'utf-8');
  console.log(
    `[seed-llms-full] wrote ${text.length} bytes to ${OUT_PATH} ` +
    `(preserved from deployed ${APPROUTER_URL}/llms-full.txt, ${countCatalogEntries(text)} catalog entries).`,
  );
}

// Only run main() when invoked directly (not when imported by the unit test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}

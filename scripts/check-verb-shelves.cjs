// scripts/check-verb-shelves.cjs
//
// Build-time guard chained into `build:hugo` via `&&`. Fails loudly if any
// homepage verb baked into hugo/data/verb_definitions.json has ZERO active
// shelf rows in hugo/data/homepage_shelves.json.
//
// Root cause it prevents (issue #1029 follow-up):
//   The verb sub-pages (/model/, /build/, …) are Hugo-static — baked at build
//   time by scripts/fetch-{verb-definitions,homepage-shelves}.ts, which fetch
//   from whatever CAP server sits at CAP_BASE_URL (default localhost:4004). A
//   build run against a CSV-seeded SQLite backend (plain `cds watch`) instead
//   of the HANA-backed hybrid server bakes an empty shelf set for any verb
//   whose shelf content lives only in HANA. MODEL was the canary: 12 rows live
//   in HANA, but a SQLite-backed build baked /model/ with zero shelf cards and
//   shipped it to DEV. The hero still renders, so the page looks "half alive"
//   and the regression is easy to miss.
//
// Now that MODEL's rows are backported into the seed CSV, a CSV-seeded build
// is no longer empty — but this guard is the durable net: it fails the build
// for ANY verb that bakes empty, whatever the cause (bad CAP_BASE_URL, fetch
// error writing the empty-payload fallback, a future verb added without seed
// rows, an isActive=false sweep, etc.).
//
// Why a chained && instead of a `prebuild:hugo` npm lifecycle hook?
// The project's global npm config sets `ignore-scripts=true` as a
// supply-chain-security policy, which blocks ALL pre/post lifecycle hooks.
// Chaining keeps the guard reliable on Windows dev workstations regardless of
// that setting. Mirrors scripts/check-explore-bundle-manifest.cjs.
//
// Exit codes:
//   0  every baked verb has >=1 active shelf row.
//   1  a data file is missing/unreadable, OR at least one verb baked empty.
//      Stderr names every offending verb + the likely fix.
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.resolve(__dirname, '..', 'hugo', 'data');
const VERB_DEFS = path.join(DATA_DIR, 'verb_definitions.json');
const SHELVES = path.join(DATA_DIR, 'homepage_shelves.json');

// ---------------------------------------------------------------------------
// Pure core (unit-tested in scripts/__tests__/check-verb-shelves.test.ts).
// Given the parsed verb_definitions + homepage_shelves payloads, return the
// list of verbKeys that have zero active shelf rows. A row explicitly
// isActive:false is skipped; anything else counts, mirroring what the verb
// page template (verb/list.html) actually renders.
// ---------------------------------------------------------------------------
function findEmptyVerbs(verbDefs, shelvesDoc) {
  const verbs = Array.isArray(verbDefs && verbDefs.verbs) ? verbDefs.verbs : [];
  const shelves = Array.isArray(shelvesDoc && shelvesDoc.shelves) ? shelvesDoc.shelves : [];

  const activeCountByVerb = new Map();
  for (const row of shelves) {
    if (!row || row.isActive === false) continue;
    activeCountByVerb.set(row.verb, (activeCountByVerb.get(row.verb) || 0) + 1);
  }

  const empties = [];
  for (const def of verbs) {
    const key = def && def.verbKey;
    if ((activeCountByVerb.get(key) || 0) === 0) empties.push(key);
  }

  return {
    empties,
    verbCount: verbs.length,
    shelfCount: shelves.length,
    verbsWithRows: activeCountByVerb.size,
  };
}

module.exports = { findEmptyVerbs };

// ---------------------------------------------------------------------------
// CLI (only when run directly, so the pure core imports cleanly under Vitest).
// ---------------------------------------------------------------------------
function fail(lines) {
  console.error('');
  console.error('[build:hugo] verb-shelf guard FAILED:');
  for (const l of lines) console.error(`             ${l}`);
  console.error('');
  console.error('             Verb sub-pages (/model/, /build/, …) render empty when their');
  console.error('             shelf rows are missing from the baked feed. This usually means');
  console.error('             the build fetched from a CSV-seeded SQLite backend instead of');
  console.error('             HANA. Fix: point CAP_BASE_URL at a HANA-backed CAP (npm run');
  console.error('             watch:hybrid) and re-run fetch-homepage-shelves, or confirm the');
  console.error('             verb has seed rows in db/data/*-HomepageShelves.csv.');
  console.error('');
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    fail([`${label} not found at ${path.relative(process.cwd(), file)}.`,
          'Run `npm run fetch-verb-definitions` + `npm run fetch-homepage-shelves` (or `npm run build:all`).']);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    fail([`${label} is not valid JSON: ${err.message}`]);
  }
}

function main() {
  const verbDefs = readJson(VERB_DEFS, 'verb_definitions.json');
  const shelvesDoc = readJson(SHELVES, 'homepage_shelves.json');

  const { empties, verbCount, shelfCount, verbsWithRows } = findEmptyVerbs(verbDefs, shelvesDoc);

  if (verbCount === 0) {
    fail(['verb_definitions.json has no verbs — the feed baked empty.',
          'Confirm the CAP /build/verb-definitions endpoint returned data.']);
  }

  if (empties.length > 0) {
    fail([`verb(s) with ZERO active shelf rows: ${empties.join(', ')}`,
          `(baked ${shelfCount} shelf rows across ${verbsWithRows} verbs; ${verbCount} verbs defined)`]);
  }

  console.log(`[build:hugo] verb-shelf guard OK — all ${verbCount} verbs have shelf content ` +
              `(${shelfCount} rows total).`);
}

if (require.main === module) main();

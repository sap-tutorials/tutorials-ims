// scripts/clean-island-bundles.cjs
//
// Removes Vite-generated island artifacts from hugo/static/js/ before a fresh
// `vite build`, so content-hashed bundles from prior builds don't accumulate
// (#1604). Vite runs with `emptyOutDir: false` (the dir also holds committed
// files like joule.js and the vendored bundles), so it never clears stale
// output itself. Without this, repeated local `build:all` runs pile up dead
// <name>-<oldhash>.js files that the MTA's union `cp` then copies into the
// approuter — bloat, and (worse) an old buggy bundle stays reachable by direct
// URL even though nothing references it.
//
// Deleting by "looks-hashed" filename shape is UNSAFE: committed/stable names
// like consent-trustarc.js and nav-dropdown.js end in an 8-char hyphenated
// segment that mimics a Vite hash. So we delete by EXCLUSION instead — a
// preserve-set of everything that is NOT a hashed Vite entry:
//   - files git tracks under hugo/static/js/ (joule.js, consent.js, etc.)
//   - the two un-hashed CAP-stable entries (nav-dropdown.js, concepts-filter.js)
//   - the vendor/ subdir (vendored, not Vite output)
// Everything else at the top level, plus chunks/ and .vite/ wholesale, is
// Vite entry output and safe to remove; `vite build` regenerates it.

const { readdirSync, rmSync, existsSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = process.env.CLEAN_ISLAND_BUNDLES_ROOT
  ? resolve(process.env.CLEAN_ISLAND_BUNDLES_ROOT)
  : resolve(__dirname, '..');

const JS_DIR = join(REPO_ROOT, 'hugo', 'static', 'js');

if (!existsSync(JS_DIR)) {
  console.log('[clean-island-bundles] no hugo/static/js yet — nothing to clean');
  process.exit(0);
}

// Build the preserve-set from git-tracked files (basename only, top level).
const preserve = new Set([
  // CAP-stable entries: emitted un-hashed because srv/lib renderers hardcode
  // their paths at request time (see vite.config.ts entryFileNames).
  'nav-dropdown.js',
  'concepts-filter.js',
]);
try {
  const tracked = execFileSync('git', ['ls-files', 'hugo/static/js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  for (const line of tracked.split('\n')) {
    const rel = line.trim();
    if (!rel) continue;
    // Only top-level entries matter here; vendor/ is handled by the dir skip.
    const parts = rel.split('/');
    if (parts.length === 4) preserve.add(parts[3]); // hugo/static/js/<file>
  }
} catch (err) {
  // No git (unlikely in this repo) — fall back to the known committed set so
  // we never delete a hand-authored file.
  for (const f of [
    'joule.js', 'joule-render.js', 'consent.js', 'consent-trustarc.js',
    'popular-rail.js', 'featured-rail.js',
  ]) preserve.add(f);
}

let removed = 0;

for (const sub of ['chunks', '.vite']) {
  const p = join(JS_DIR, sub);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    removed++;
  }
}

for (const name of readdirSync(JS_DIR)) {
  if (name === 'vendor' || preserve.has(name)) continue;
  const p = join(JS_DIR, name);
  // Only unlink plain .js files at the top level; leave any other dir alone.
  if (name.endsWith('.js') && statSync(p).isFile()) {
    rmSync(p, { force: true });
    removed++;
  }
}

console.log(`[clean-island-bundles] removed ${removed} stale Vite artifact(s) from hugo/static/js`);

// scripts/build-island-manifest.cjs
//
// Bridges Vite's build manifest to Hugo (#1604). The Vite islands in
// hugo-apps/ are emitted with content-hashed filenames (e.g.
// navigator-BqX3k_2a.js) so a changed bundle gets a new URL the CDN edge
// (Akamai on PROD) has never cached. Hugo templates can't know the hash,
// so this script reads Vite's manifest and writes a flat Hugo data file
// mapping each entry name to its hashed public path:
//
//   { "navigator": "/js/navigator-BqX3k_2a.js", ... }
//
// hugo/layouts/partials/island-src.html reads it via
// `site.Data.island_manifest`, falling back to /js/<name>.js when a key is
// absent (the local `dev` = `hugo server` never runs Vite; the two
// CAP-stable entries nav-dropdown/concepts-filter are emitted un-hashed and
// resolve to their bare path either way).
//
// Runs in `postbuild:apps` (package.json), right after `vite build` and well
// before `build:hugo`, so the data file exists when Hugo builds.
//
// Exit codes:
//   0  wrote the data file with >= 1 entry.
//   1  Vite manifest missing, unparseable, or contained zero entries.

const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO_ROOT = process.env.BUILD_ISLAND_MANIFEST_ROOT
  ? resolve(process.env.BUILD_ISLAND_MANIFEST_ROOT)
  : resolve(__dirname, '..');

const VITE_MANIFEST = join(REPO_ROOT, 'hugo', 'static', 'js', '.vite', 'manifest.json');
const OUT = join(REPO_ROOT, 'hugo', 'data', 'island_manifest.json');

function fail(msg) {
  console.error(`[build-island-manifest] ${msg}`);
  process.exit(1);
}

if (!existsSync(VITE_MANIFEST)) {
  fail(`Vite manifest not found at ${VITE_MANIFEST}. Did \`vite build\` run with build.manifest:true?`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(VITE_MANIFEST, 'utf8'));
} catch (err) {
  fail(`could not parse ${VITE_MANIFEST}: ${err.message}`);
}

const out = {};
for (const record of Object.values(manifest)) {
  // Only top-level entry bundles carry a stable `name` layouts reference by.
  // `file` is relative to the Vite outDir (hugo/static/js), served at /js/.
  if (record && record.isEntry && record.name && record.file) {
    out[record.name] = `/js/${record.file}`;
  }
}

const count = Object.keys(out).length;
if (count === 0) {
  fail(`no entry bundles found in ${VITE_MANIFEST} — refusing to write an empty manifest`);
}

// Stable key order keeps the generated file diff-friendly. `\n` EOL matches
// the other generated hugo/data/*.json files.
const sorted = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];
writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

console.log(`[build-island-manifest] wrote ${count} entries to hugo/data/island_manifest.json`);

// scripts/check-ui5-single-copy.cjs
//
// Build assertion: exactly one copy of the @ui5/webcomponents-base Theme system
// must be reachable from the four ui5-* entry points after a Vite build (#1777).
//
// WHY: @ui5/webcomponents-base uses module-level singletons (Theme, Boot, etc.).
// If Vite's manualChunks rule that pins them into ui5-vendor is ever broken,
// two separate copies of those singletons end up in different chunks, causing
// subtle runtime failures (double-boot, theme conflicts, component registration
// races).
//
// HOW: Read hugo/static/js/.vite/manifest.json. Walk the import graph reachable
// from every manifest key matching ^src/ui5/ui5-.*\.ts$ (dynamically derived —
// adding a new ui5-* entry is automatically in-scope without editing this script),
// collect the set of chunk files in that subgraph, then count how many of them
// contain the Theme marker string. Assert exactly 1.
//
// MARKER: "sap-ui-webcomponents-theme" — the DOM attribute literal used by
// @ui5/webcomponents-base/dist/config/ThemeRoot.js (part of the Theme subsystem).
// This string is a quoted string literal in the source and survives Vite
// minification unchanged. It is also absent from every OTHER chunk reachable
// from the ui5-* entries (verified on the 2026-08-14 build: appears 2× in
// ui5-vendor-BbF3BeXC.js only, 0× in the other 47 reachable chunks).
//
// STALE-CHUNK SAFETY: hugo/static/js/chunks/ accumulates old hashed chunks via
// `retain:assets` so already-published HANA content doesn't 404. A disk-wide
// scan would count stale ui5-vendor-*.js files as extra copies (false positive
// on every retain deploy). Scoping to manifest-reachable chunks only avoids this.
//
// Exit codes (CLI mode):
//   0  exactly one ui5 Theme copy found — build is correct.
//   1  != 1 copies found — manualChunks split or vendor chunk missing.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// String literal from @ui5/webcomponents-base/dist/config/ThemeRoot.js.
// Survives minification; absent from non-vendor ui5 chunks (verified).
const THEME_MARKER = 'sap-ui-webcomponents-theme';

// Regex that identifies ui5-* entry keys in the Vite manifest.
// Manifest keys are source-file paths relative to the Vite root.
// Verified format: "src/ui5/ui5-core.ts", "src/ui5/ui5-tutorial.ts", etc.
// Using a regex means any future ui5-* entry is automatically in scope —
// no need to update this script when a new entry is added.
const UI5_ENTRY_KEY_RE = /^src\/ui5\/ui5-.*\.ts$/;

/**
 * Walk the manifest import graph starting from `key`, collecting all reachable
 * manifest keys (including transitive imports and dynamicImports).
 *
 * @param {string}               key      manifest key to start from
 * @param {Record<string,object>} manifest parsed manifest.json
 * @param {Set<string>}          visited  accumulator (modified in-place)
 * @returns {Set<string>}
 */
function collectReachable(key, manifest, visited = new Set()) {
  if (visited.has(key) || !(key in manifest)) return visited;
  visited.add(key);
  const entry = manifest[key];
  for (const imp of (entry.imports || [])) collectReachable(imp, manifest, visited);
  for (const dimp of (entry.dynamicImports || [])) collectReachable(dimp, manifest, visited);
  return visited;
}

/**
 * Pure function: count how many of the provided chunk text strings contain the
 * Theme marker. Useful for low-level unit testing without touching the filesystem.
 *
 * @param {string[]} chunkTexts  array of JS chunk file contents
 * @returns {number}
 */
function countThemeCopies(chunkTexts) {
  return chunkTexts.filter(text => text.includes(THEME_MARKER)).length;
}

/**
 * Manifest-scoped Theme copy count.
 *
 * Reads `<jsDir>/.vite/manifest.json`, derives ui5-* entry keys by filtering
 * manifest keys against UI5_ENTRY_KEY_RE (^src/ui5/ui5-.*\.ts$), resolves the
 * full import subgraph from those entries, reads each reachable chunk file, and
 * counts how many contain THEME_MARKER.
 *
 * New ui5-* entries added to the manifest are automatically in scope — no
 * changes to this script required.
 *
 * Stale chunks on disk that are NOT reachable from the current manifest are
 * not read and do not affect the count.
 *
 * @param {string} jsDir  path to hugo/static/js/ (the Vite outDir)
 * @returns {number}
 * @throws {Error} if the manifest is missing or unparseable
 */
function countThemeCopiesFromManifest(jsDir) {
  const manifestPath = path.join(jsDir, '.vite', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `[check-ui5-single-copy] Vite manifest not found at ${manifestPath}. ` +
      'Run npm run build:apps first.'
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`[check-ui5-single-copy] could not parse manifest at ${manifestPath}: ${err.message}`);
  }

  // Derive ui5-* entry keys from the manifest dynamically — any future
  // src/ui5/ui5-*.ts entry is picked up automatically.
  const ui5EntrySrcs = Object.keys(manifest).filter(k => UI5_ENTRY_KEY_RE.test(k));

  // Collect all manifest keys reachable from the ui5-* entries.
  const reachable = new Set();
  for (const src of ui5EntrySrcs) {
    collectReachable(src, manifest, reachable);
  }

  // Map each reachable key to its chunk file path, deduplicate by file.
  const chunkFiles = new Set();
  for (const key of reachable) {
    const entry = manifest[key];
    if (entry && entry.file && entry.file.endsWith('.js')) {
      chunkFiles.add(path.join(jsDir, entry.file));
    }
  }

  // Read each chunk file and count how many contain the Theme marker.
  const chunkTexts = [];
  for (const filePath of chunkFiles) {
    if (fs.existsSync(filePath)) {
      chunkTexts.push(fs.readFileSync(filePath, 'utf8'));
    }
  }

  return countThemeCopies(chunkTexts);
}

// ── CLI entry-point ──────────────────────────────────────────────────────────
if (require.main === module) {
  const jsDir = path.resolve(__dirname, '..', 'hugo', 'static', 'js');

  let n;
  try {
    n = countThemeCopiesFromManifest(jsDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (n !== 1) {
    console.error(
      `[check-ui5-single-copy] FAIL: expected exactly 1 @ui5 Theme copy in ui5-vendor, ` +
      `found ${n}. ` +
      (n === 0
        ? 'The ui5-vendor chunk may be missing or the marker may have changed.'
        : 'The manualChunks rule in vite.config.ts may have been broken — ' +
          '@ui5/webcomponents-base is split across multiple chunks.')
    );
    process.exit(1);
  }

  console.log(`[check-ui5-single-copy] OK — single UI5 Theme copy in ${n} chunk (ui5-vendor)`);
}

module.exports = { countThemeCopies, countThemeCopiesFromManifest };

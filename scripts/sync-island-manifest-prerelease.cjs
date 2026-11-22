// scripts/sync-island-manifest-prerelease.cjs
//
// Bridges the Vite island fingerprint manifest into the prerelease Hugo build.
// Mirrors scripts/sync-island-manifest-qa.cjs exactly, retargeted to the
// prerelease data/public dirs (hugo/data-prerelease/).
//
// The prerelease build (hugo.prerelease.toml) sets `dataDir = "data-prerelease"`,
// which *replaces* Hugo's data root rather than merging with `data/`. So during
// `build:prerelease`, hugo/data/island_manifest.json is invisible:
// `site.Data.island_manifest` is undefined and island-src.html falls back to
// the UNHASHED "/js/<name>.js" path. Vite emits only content-hashed files for
// the fingerprinted islands (validation, navigator, ...), so the unhashed URL
// 404s on the approuter and the island never mounts.
//
// Fix: copy hugo/data/island_manifest.json into hugo/data-prerelease/ right
// before the prerelease Hugo build, so prerelease bakes the same hashed paths
// as prod (both served from the shared approuter static/js/ tree).
//
// Soft by design: if the source manifest is absent (e.g. a bare
// `build:prerelease` without a prior `build:island-manifest`), this warns and
// continues rather than hard-failing — the real gate is scripts/verify-qa-build.ts
// (reused for prerelease), which fails the build if any page baked an unhashed
// island fallback.

const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const SRC = join(REPO_ROOT, 'hugo', 'data', 'island_manifest.json');
const DEST = join(REPO_ROOT, 'hugo', 'data-prerelease', 'island_manifest.json');

if (!existsSync(SRC)) {
  console.warn(
    `[sync-island-manifest-prerelease] source manifest not found at ${SRC}. ` +
      'Run `npm run build:island-manifest` (after building the islands) first. ' +
      'Prerelease HTML will bake unhashed island paths until then — verify-qa-build.ts will fail the build.',
  );
  process.exit(0);
}

mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(SRC, DEST);
console.log('[sync-island-manifest-prerelease] copied island_manifest.json -> hugo/data-prerelease/');

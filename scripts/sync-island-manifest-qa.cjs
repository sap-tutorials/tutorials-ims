// scripts/sync-island-manifest-qa.cjs
//
// Bridges the Vite island fingerprint manifest into the QA Hugo build (#1629).
//
// The prod Hugo build reads hugo/data/island_manifest.json (written by
// scripts/build-island-manifest.cjs) so hugo/layouts/partials/island-src.html
// can resolve an island name to its content-hashed public path
// (e.g. "validation" -> "/js/validation-K8FRraal.js").
//
// The QA build (hugo.qa.toml) sets `dataDir = "data-qa"`, which *replaces*
// Hugo's data root rather than merging with `data/`. So during `build:qa`,
// hugo/data/island_manifest.json is invisible: `site.Data.island_manifest` is
// undefined and island-src.html falls back to the UNHASHED "/js/<name>.js"
// path. Vite emits only content-hashed files for the fingerprinted islands
// (validation, navigator, ...), so the unhashed URL 404s on the approuter and
// the island never mounts. For the `validation` island that means tutorial
// questions never render and the "Done" button stays permanently disabled
// (exactly the #1629 symptom, QA-only — prod bakes the hashed path and works).
//
// Fix: copy hugo/data/island_manifest.json into hugo/data-qa/ right before the
// QA Hugo build, so QA bakes the same hashed paths as prod (both served from
// the shared approuter static/js/ tree).
//
// Soft by design: if the source manifest is absent (e.g. a bare `build:qa`
// without a prior `build:island-manifest`), this warns and continues rather
// than hard-failing — the real gate is scripts/verify-qa-build.ts, which fails
// the build if any QA page baked an unhashed island fallback.

const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const SRC = join(REPO_ROOT, 'hugo', 'data', 'island_manifest.json');
const DEST = join(REPO_ROOT, 'hugo', 'data-qa', 'island_manifest.json');

if (!existsSync(SRC)) {
  console.warn(
    `[sync-island-manifest-qa] source manifest not found at ${SRC}. ` +
      'Run `npm run build:island-manifest` (after building the islands) first. ' +
      'QA HTML will bake unhashed island paths until then — verify-qa-build.ts will fail the build.',
  );
  process.exit(0);
}

mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(SRC, DEST);
console.log('[sync-island-manifest-qa] copied island_manifest.json -> hugo/data-qa/');

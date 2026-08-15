// scripts/publish-island-manifest.cjs
//
// #1659 Phase C.3 — expose the DEPLOYED island name→hash manifest on a stable
// served path. `build-island-manifest.cjs` writes hugo/data/island_manifest.json
// (Hugo data, NOT copied into the published site). This step copies it to
// hugo/public/_island-manifest.json AFTER build:hugo so the approuter serves it
// at ${APPROUTER_URL}/_island-manifest.json (via the catch-all static route,
// like /_retained-assets.json). Content rebuilds (C.3 cutover) fetch this and
// render pages against the deployed hashes instead of rebuilding the islands —
// so HANA-published page HTML never references a hash the droplet lacks.
//
// Must run AFTER build:hugo (Hugo owns hugo/public); wired into build:all right
// after build:page-fallback / retain:assets. Fail-open: if the source manifest
// is absent (e.g. a preview/no-island build), warn and exit 0 so the rest of
// build:all still runs — a missing served manifest just means C.3 seeding
// fails-closed later, which is the intended safe behavior.

const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'hugo', 'data', 'island_manifest.json');
const DEST = join(ROOT, 'hugo', 'public', '_island-manifest.json');

if (!existsSync(SRC)) {
  console.warn(`[publish-island-manifest] ${SRC} absent — skipping (no islands built this run?).`);
  process.exit(0);
}
mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(SRC, DEST);
console.log('[publish-island-manifest] copied hugo/data/island_manifest.json → hugo/public/_island-manifest.json');

// scripts/lib/copy-island-manifest.cjs
//
// Issue #2733 — seed the island name→hash manifest BESIDE the server-side
// renderer bundle so live SSR of group/mission (and concept/puzzle/topic) pages
// resolves hashed island script paths instead of failing open to bare
// /js/<name>.js (which 404s against the hashed-only approuter).
//
// Background: /tutorials/mission-<slug> and /tutorials/group-<slug> are NOT
// Hugo-baked and NOT stored in HANA — the approuter proxies them to CAP
// /content/tutorials/* and the deployed tutorials-srv process renders them
// LIVE (X-Content-Source: rendered). The renderer is esbuild-bundled into
// srv/lib/_shared/content.bundle.mjs, and its islandSrc() reads
// `island-manifest.json` relative to that bundle's own dir. Nothing ever put
// the file there, so every island on those pages shipped the bare fallback
// path. build-island-manifest.cjs already writes srv/lib/island-manifest.json;
// this copies that same map into each _shared/ bundle dir (and the local
// packages/content/ source dir used by `cds watch` / unit tests).
//
// Fail-closed on a PRESENT-BUT-EMPTY/INVALID source (an empty {} manifest would
// bake bare paths just as surely as a missing file). Fail-OPEN (warn + skip)
// when the source is entirely absent: the CI deploy.yml path legitimately runs
// bundle-shared with no island build in the same job (islands are built out of
// band), and hard-failing there would break that deploy. The local
// build:deploy path always has the source present, and scripts/deploy-mta.cjs
// Step 2.5 guards that the seed actually landed.

const { copyFileSync, existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

// The filename the renderers read (hyphenated), distinct from the Hugo-side
// hugo/data/island_manifest.json (underscore).
const DEST_NAME = 'island-manifest.json';

/**
 * Copy the built island manifest into each bundle dir as island-manifest.json.
 * @param {string[]} outDirs  dirs that hold a *.bundle.mjs (e.g. srv/lib/_shared)
 * @param {string}   srcPath  path to the source manifest (srv/lib/island-manifest.json)
 * @returns {{copied: string[], skipped: boolean}}
 */
function copyIslandManifestBeside(outDirs, srcPath) {
  if (!existsSync(srcPath)) {
    console.warn(
      `[copy-island-manifest] source ${srcPath} absent — skipping (expected only in the CI ` +
      `deploy path, which builds islands out of band; the local build:deploy path always has it).`,
    );
    return { copied: [], skipped: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(srcPath, 'utf8'));
  } catch (err) {
    throw new Error(`[copy-island-manifest] ${srcPath} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error(
      `[copy-island-manifest] ${srcPath} is empty ({}) or not an object — refusing to seed a ` +
      `manifest that would bake bare unhashed island paths that 404 on the approuter.`,
    );
  }

  const copied = [];
  for (const dir of outDirs) {
    const dst = join(dir, DEST_NAME);
    copyFileSync(srcPath, dst);
    console.log('[copy-island-manifest] seeded', dst);
    copied.push(dst);
  }
  return { copied, skipped: false };
}

module.exports = { copyIslandManifestBeside, DEST_NAME };

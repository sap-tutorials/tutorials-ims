#!/usr/bin/env node
'use strict';

/**
 * check-hugo-island-fingerprint.cjs — fail if the rendered Hugo homepage carries
 * only UNHASHED (`/js/<name>.js`) JS-island paths while a Vite manifest exists.
 *
 * WHY THIS EXISTS
 *   The content-rebuild workflow (rebuild-content.yml, full/catalog-only) builds
 *   a static tarball and pushes it to the approuter's POST /admin/rebuild, which
 *   ATOMICALLY renames the tree over the live static/ (approuter/server.js). If
 *   the rendered index.html references bare /js/<name>.js paths, that clobbers
 *   the good droplet static with 404-ing refs — the PROD outage of 2026-08-10/11
 *   (#1604/#1628). Islands are content-hashed via hugo/data/island_manifest.json
 *   (built by scripts/build-island-manifest.cjs); island-src.html falls back to
 *   the bare path when that manifest is absent.
 *
 *   scripts/deploy-mta.cjs Step 2.5 already guards this on the DEPLOY path. This
 *   script is the equivalent guard for the runtime-push path (and the QA build),
 *   so a future reorder/rename that drops the manifest step fails the CI run
 *   LOUDLY instead of shipping a silent outage.
 *
 * BEHAVIOUR (mirrors Step 2.5)
 *   - Gates on the Vite manifest existing. No manifest → nothing was fingerprinted
 *     (e.g. build:apps did not run); we do not enforce hashing (inconclusive, exit 0)
 *     unless --require-manifest is passed.
 *   - Manifest present + homepage has >=1 hashed island ref  → OK (exit 0).
 *   - Manifest present + homepage has ONLY bare island refs   → FAIL (exit 1).
 *
 * USAGE
 *   node scripts/check-hugo-island-fingerprint.cjs [--hugo-dir hugo/public] \
 *        [--vite-manifest hugo/static/js/.vite/manifest.json] [--require-manifest]
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = {
    hugoDir: 'hugo/public',
    viteManifest: path.join('hugo', 'static', 'js', '.vite', 'manifest.json'),
    requireManifest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hugo-dir') out.hugoDir = argv[++i];
    else if (a === '--vite-manifest') out.viteManifest = argv[++i];
    else if (a === '--require-manifest') out.requireManifest = true;
  }
  return out;
}

// A correctly fingerprinted homepage references at least one hashed island
// bundle: /js/<name>-<8+hashish>.js. Same regex as deploy-mta.cjs Step 2.5.
const HASHED_ISLAND_RE = /\/js\/[a-zA-Z0-9-]+-[A-Za-z0-9_-]{8,}\.js/;

function ghError(title, msg) {
  console.error(`::error title=${title}::${msg}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const homepage = path.join(args.hugoDir, 'index.html');
  const manifestExists = fs.existsSync(args.viteManifest);

  if (!manifestExists) {
    if (args.requireManifest) {
      ghError(
        'island fingerprint',
        `Vite manifest missing (${args.viteManifest}). "Build Vue apps" did not run, so no ` +
          `island bundles were produced. Fix: run npm --prefix hugo-apps run build before the Hugo build.`
      );
      process.exit(1);
    }
    console.log(
      `[check-hugo-island-fingerprint] no Vite manifest at ${args.viteManifest} — nothing to fingerprint, skipping (inconclusive).`
    );
    process.exit(0);
  }

  if (!fs.existsSync(homepage)) {
    ghError('island fingerprint', `${homepage} missing — the Hugo build did not produce a homepage.`);
    process.exit(1);
  }

  const html = fs.readFileSync(homepage, 'utf8');
  if (!HASHED_ISLAND_RE.test(html)) {
    ghError(
      'island fingerprint',
      `${homepage} has ONLY unhashed /js/<name>.js island paths despite a Vite manifest existing. ` +
        `hugo/data/island_manifest.json was not built (island-src.html fell back to bare paths). The ` +
        `tarball pushed to /admin/rebuild would clobber the approuter with 404-ing bare refs (PROD ` +
        `outage 2026-08-10/11, #1604/#1628). Fix: ensure "Build island manifest" runs before "Build Hugo site".`
    );
    process.exit(1);
  }

  console.log(`[check-hugo-island-fingerprint] island bundles fingerprinted in ${homepage} (manifest took effect).`);
  process.exit(0);
}

main();

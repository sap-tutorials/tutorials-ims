// scripts/build-whats-new-snapshot.cjs
//
// Copies the committed What's New digest (hugo/data/whats_new.json) into
// srv/whats-new-data/whats_new.json so the CAP srv can read it at runtime.
// The deployed srv module never ships the hugo/ tree, so the getWhatsNew Joule
// tool (srv/lib/whats-new-joule-tool.js) reads this baked snapshot (issue #1859).
//
// Runs as an explicit step in build:all (package.json). It is deliberately NOT
// a pre*/post* lifecycle hook — the global npmrc has ignore-scripts=true which
// silences those. Mirrors scripts/build-page-fallback.cjs.
//
// Exit codes:
//   0  snapshot written.
//   0  source missing (warns; the tool fails open to the /whats-new/ page).
//   1  unexpected error.

const { copyFileSync, mkdirSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO_ROOT = process.env.BUILD_WHATS_NEW_ROOT
  ? resolve(process.env.BUILD_WHATS_NEW_ROOT)
  : resolve(__dirname, '..');

const SRC = join(REPO_ROOT, 'hugo', 'data', 'whats_new.json');
const DEST_DIR = join(REPO_ROOT, 'srv', 'whats-new-data');
const DEST = join(DEST_DIR, 'whats_new.json');

try {
  if (!existsSync(SRC)) {
    console.warn(`[build-whats-new-snapshot] SKIP — source not found: ${SRC}`);
    console.warn('[build-whats-new-snapshot] getWhatsNew will fail open to the /whats-new/ page link.');
    process.exit(0);
  }
  mkdirSync(DEST_DIR, { recursive: true });
  copyFileSync(SRC, DEST);
  console.log(`[build-whats-new-snapshot] wrote snapshot → srv/whats-new-data/whats_new.json`);
  process.exit(0);
} catch (err) {
  console.error('[build-whats-new-snapshot] ERROR:', err.message);
  process.exit(1);
}

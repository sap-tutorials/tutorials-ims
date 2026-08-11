// scripts/build-page-fallback.cjs
//
// Copies in-scope page HTML/XML/text from hugo/public into
// srv/page-fallback/<key>.<ext> so the serve tier has a baked snapshot
// fallback when the DB has no active version for a page.
//
// Uses the SAME IN_SCOPE_PAGES list from srv/lib/page-key-map.js (single
// source of truth). page-key-map.js is ESM, so we use dynamic import().
//
// Runs as an explicit step in build:all (package.json) AFTER build:hugo.
// It is deliberately NOT a pre*/post* lifecycle hook — the global npmrc has
// ignore-scripts=true which silences those here. Any build artifact that
// must ship must be an explicit step in build:all (mirrors the
// build:island-manifest pattern).
//
// Exit codes:
//   0  snapshots written (one per in-scope page found under hugo/public).
//   0  some pages missing from hugo/public (warns; partial snapshots ok).
//   1  unexpected error.

const { copyFileSync, mkdirSync, existsSync } = require('node:fs');
const { join, resolve, extname } = require('node:path');

const REPO_ROOT = process.env.BUILD_PAGE_FALLBACK_ROOT
  ? resolve(process.env.BUILD_PAGE_FALLBACK_ROOT)
  : resolve(__dirname, '..');

const HUGO_PUBLIC  = join(REPO_ROOT, 'hugo', 'public');
const FALLBACK_DIR = join(REPO_ROOT, 'srv', 'page-fallback');

const EXT = { 'text/html': 'html', 'application/xml': 'xml', 'text/plain': 'txt' };

(async () => {
  try {
    const { IN_SCOPE_PAGES } = await import('../srv/lib/page-key-map.js');

    mkdirSync(FALLBACK_DIR, { recursive: true });

    let copied = 0;
    let missing = 0;
    for (const p of IN_SCOPE_PAGES) {
      const src  = join(HUGO_PUBLIC, p.file);
      const ext  = EXT[p.mimeType] || extname(p.file).slice(1) || 'html';
      const dest = join(FALLBACK_DIR, `${p.key}.${ext}`);
      if (!existsSync(src)) {
        console.warn(`[build-page-fallback] SKIP ${p.key} — not found: ${p.file}`);
        missing++;
        continue;
      }
      copyFileSync(src, dest);
      copied++;
    }

    console.log(`[build-page-fallback] wrote ${copied} snapshot(s) to srv/page-fallback/ (${missing} missing from hugo/public)`);
  } catch (err) {
    console.error('[build-page-fallback] FATAL:', err.message);
    process.exit(1);
  }
})();

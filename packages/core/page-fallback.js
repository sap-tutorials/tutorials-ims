// srv/lib/page-fallback.js
//
// Fail-open baked snapshot fallback for in-scope pages.
// Called by servePageFallback (content-store.js) when the DB has no active
// version for a page key and we need a last-resort response before 503.
//
// Snapshots are written to srv/page-fallback/<key>.<ext> at build time by
// scripts/build-page-fallback.cjs (runs as an explicit step in build:all,
// AFTER build:hugo). This module reads them at serve time and caches in-process.
//
// Fail-open contract: loadPageFallback never throws. Missing file or any read
// error returns null; the call-site (pageServeHandler) then falls to 503.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mimeTypeForPageKey, extForMime } from './page-key-map.js';

// packages/core is 2 levels down from the project root (root/packages/core);
// when bundled into srv/lib/_shared/core.bundle.mjs, import.meta.url points to
// the bundle file which is 3 levels down from the project root (root/srv/lib/_shared).
// We probe both candidate locations and take whichever exists, falling back to
// the bundle-relative path (which covers the CF-deployed gen/srv layout).
const _here = path.dirname(fileURLToPath(import.meta.url));
const _candidates = [
  path.join(_here, '..', '..', 'srv', 'page-fallback'),  // packages/core -> root -> srv/page-fallback (local dev)
  path.join(_here, '..', '..', 'page-fallback'),          // srv/lib/_shared -> srv -> page-fallback (bundle/CF)
];
const DIR = _candidates.find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
  ?? _candidates[1]; // fail-open: default to bundle path; loadPageFallback already returns null on missing
const _cache = new Map();

/**
 * Load the baked snapshot for `key` from disk (once) and return it, or null.
 * @param {string} key - page key (e.g. 'page-index', 'page-browse')
 * @returns {{ buffer: Buffer, mimeType: string } | null}
 */
export function loadPageFallback(key) {
  if (_cache.has(key)) return _cache.get(key);
  const mimeType = mimeTypeForPageKey(key);
  const file = path.join(DIR, `${key}.${extForMime(mimeType)}`);
  let result = null;
  try {
    if (fs.existsSync(file)) result = { buffer: fs.readFileSync(file), mimeType };
  } catch { /* fail-open: no fallback */ }
  _cache.set(key, result);
  return result;
}

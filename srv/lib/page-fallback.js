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
import { mimeTypeForPageKey } from './page-key-map.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'page-fallback');
const EXT = { 'text/html': 'html', 'application/xml': 'xml', 'text/plain': 'txt' };
const _cache = new Map();

/**
 * Load the baked snapshot for `key` from disk (once) and return it, or null.
 * @param {string} key - page key (e.g. 'page-index', 'page-browse')
 * @returns {{ buffer: Buffer, mimeType: string } | null}
 */
export function loadPageFallback(key) {
  if (_cache.has(key)) return _cache.get(key);
  const mimeType = mimeTypeForPageKey(key);
  const file = path.join(DIR, `${key}.${EXT[mimeType] || 'html'}`);
  let result = null;
  try {
    if (fs.existsSync(file)) result = { buffer: fs.readFileSync(file), mimeType };
  } catch { /* fail-open: no fallback */ }
  _cache.set(key, result);
  return result;
}

import fs from 'node:fs';
import path from 'node:path';

export const PAGE_KEY_PREFIX = 'page-';

// Single authoritative MIME → extension map shared by build and serve.
const _EXT_MAP = { 'text/html': 'html', 'application/xml': 'xml', 'text/plain': 'txt' };

/**
 * Return the file extension for a MIME type recognised by IN_SCOPE_PAGES,
 * or 'html' for anything unknown.
 * @param {string} mimeType
 * @returns {string}
 */
export function extForMime(mimeType) {
  return _EXT_MAP[mimeType] || 'html';
}

// The fixed allow-list IS the validator: only these routes become page keys.
// `file` is relative to the Hugo output dir (hugo/public).
// Verb/landing pages are enumerated here explicitly — add new ones to this list.
export const IN_SCOPE_PAGES = [
  { route: '/',                      key: 'page-index',               file: 'index.html',                mimeType: 'text/html' },
  { route: '/browse/',               key: 'page-browse',              file: 'browse/index.html',         mimeType: 'text/html' },
  { route: '/topics/',               key: 'page-topics',              file: 'topics/index.html',         mimeType: 'text/html' },
  { route: '/tutorial-navigator/',   key: 'page-tutorial-navigator',  file: 'tutorial-navigator/index.html', mimeType: 'text/html' },
  { route: '/developer-advocates/',  key: 'page-developer-advocates', file: 'developer-advocates/index.html', mimeType: 'text/html' },
  { route: '/devtoberfest/',         key: 'page-devtoberfest',        file: 'devtoberfest/index.html',   mimeType: 'text/html' },
  { route: '/sitemap.xml',           key: 'page-sitemap.xml',         file: 'sitemap.xml',               mimeType: 'application/xml' },
  { route: '/index.xml',             key: 'page-index.xml',           file: 'index.xml',                 mimeType: 'application/xml' },
  { route: '/llms-full.txt',         key: 'page-llms-full.txt',       file: 'llms-full.txt',             mimeType: 'text/plain' },
];

const _byRoute = new Map(IN_SCOPE_PAGES.map((p) => [p.route, p]));
const _byKey = new Map(IN_SCOPE_PAGES.map((p) => [p.key, p]));

// Canonicalize an inbound path to the allow-list route form:
// lowercase; ensure a leading slash; for extensionless routes ensure a single
// trailing slash. Paths containing '..' or backslashes are rejected outright.
function canonicalizeRoute(input) {
  if (typeof input !== 'string' || !input) return null;
  if (input.includes('..') || input.includes('\\')) return null;
  let p = input.split('?')[0].split('#')[0].toLowerCase();
  if (!p.startsWith('/')) p = `/${p}`;
  const hasExt = /\.[a-z0-9]+$/.test(p);
  if (!hasExt && !p.endsWith('/')) p = `${p}/`;
  return p;
}

export function pageKeyForPath(input) {
  const route = canonicalizeRoute(input);
  if (route === null) return null;
  const hit = _byRoute.get(route);
  return hit ? hit.key : null;
}

export function pathForPageKey(key) {
  const hit = _byKey.get(key);
  return hit ? hit.route : null;
}

export function isPageKey(key) {
  return typeof key === 'string' && _byKey.has(key);
}

export function mimeTypeForPageKey(key) {
  const hit = _byKey.get(key);
  return hit ? hit.mimeType : 'text/html';
}

// Map each in-scope page that actually exists under hugoDir to its page key.
export function discoverPageFiles(hugoDir) {
  const out = new Map();
  for (const p of IN_SCOPE_PAGES) {
    const abs = path.join(hugoDir, p.file);
    if (fs.existsSync(abs)) out.set(p.key, abs);
  }
  return out;
}

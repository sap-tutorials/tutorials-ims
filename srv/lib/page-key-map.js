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
  // Verb hub landing pages (#1659 Phase 2) — each is a single Hugo page
  // rendered by layouts/verb/list.html at /<verb>/index.html.
  { route: '/ai/',        key: 'page-ai',        file: 'ai/index.html',        mimeType: 'text/html' },
  { route: '/build/',     key: 'page-build',     file: 'build/index.html',     mimeType: 'text/html' },
  { route: '/connect/',   key: 'page-connect',   file: 'connect/index.html',   mimeType: 'text/html' },
  { route: '/integrate/', key: 'page-integrate', file: 'integrate/index.html', mimeType: 'text/html' },
  { route: '/learn/',     key: 'page-learn',     file: 'learn/index.html',     mimeType: 'text/html' },
  { route: '/model/',     key: 'page-model',     file: 'model/index.html',     mimeType: 'text/html' },
  { route: '/operate/',   key: 'page-operate',   file: 'operate/index.html',   mimeType: 'text/html' },
  { route: '/sitemap.xml',           key: 'page-sitemap.xml',         file: 'sitemap.xml',               mimeType: 'application/xml' },
  { route: '/index.xml',             key: 'page-index.xml',           file: 'index.xml',                 mimeType: 'application/xml' },
  { route: '/llms.txt',              key: 'page-llms.txt',            file: 'llms.txt',                  mimeType: 'text/plain' },
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

// #1659 Phase C — author pages are UNBOUNDED dynamic slugs (one per contributor
// login), so they are NOT in the fixed IN_SCOPE_PAGES allow-list. Walk
// hugo/public/authors/<login>/index.html → `author-<login>` (like tutorials/
// concepts ride the dynamic-slug publish/serve path). `_index` and any
// non-slug-shaped dir names are skipped (the /authors/ index is render:never).
export const AUTHOR_KEY_PREFIX = 'author-';
export function isAuthorKey(key) {
  return typeof key === 'string' && key.startsWith(AUTHOR_KEY_PREFIX);
}
export function discoverAuthorPages(hugoDir) {
  const out = new Map();
  const authorsDir = path.join(hugoDir, 'authors');
  let entries;
  try {
    entries = fs.readdirSync(authorsDir, { withFileTypes: true });
  } catch {
    return out; // no authors dir → nothing to publish
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const login = e.name.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(login)) continue; // skip _index etc.
    const abs = path.join(authorsDir, e.name, 'index.html');
    if (fs.existsSync(abs)) out.set(`${AUTHOR_KEY_PREFIX}${login}`, abs);
  }
  return out;
}

// #1659 Phase C — per-advocate DETAIL pages (/developer-advocates/<slug>/) are
// likewise unbounded dynamic slugs (one per advocate), NOT in IN_SCOPE_PAGES
// (only the /developer-advocates/ INDEX is `page-developer-advocates`). Walk the
// SUBDIRS under developer-advocates/ → `advocate-<slug>`; the top-level
// index.html (the index page) is a file, so directory iteration skips it.
export const ADVOCATE_KEY_PREFIX = 'advocate-';
export function isAdvocateKey(key) {
  return typeof key === 'string' && key.startsWith(ADVOCATE_KEY_PREFIX);
}
export function discoverAdvocatePages(hugoDir) {
  const out = new Map();
  const advDir = path.join(hugoDir, 'developer-advocates');
  let entries;
  try {
    entries = fs.readdirSync(advDir, { withFileTypes: true });
  } catch {
    return out; // no advocates dir → nothing to publish
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = e.name.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue; // skip _index etc.
    const abs = path.join(advDir, e.name, 'index.html');
    if (fs.existsSync(abs)) out.set(`${ADVOCATE_KEY_PREFIX}${slug}`, abs);
  }
  return out;
}

// approuter/lib/sitemap-index-redirect.js
//
// 301-redirects the LEGACY (AEM) sitemap URLs to this platform's single
// canonical sitemap at /sitemap.xml.
//
// Background:
//   developers.sap.com (legacy AEM) published a sitemap *index* at
//   /sitemap_index.xml that referenced per-shard sitemaps /sitemap_1.xml,
//   /sitemap_2.xml, /sitemap_3.xml (see scripts/sync-published-flag-from-aem-
//   -sitemap.cjs, which reads exactly those URLs). External crawlers — notably
//   SAP Intelligent Search's weekly Data Crawling job — were pinned to
//   /sitemap_index.xml.
//
//   The current platform (Hugo) emits ONE flat <urlset> at /sitemap.xml
//   (hugo/hugo.toml `home = [... 'sitemap' ...]`), routed by xs-app.json to CAP
//   /content/pages/sitemap.xml. It has no /sitemap_index.xml, so after the AEM
//   cutover those legacy URLs began returning 404 and the crawler stopped
//   getting fresh data.
//
//   A 301 to /sitemap.xml is standards-correct: a sitemap submitted (or
//   referenced by robots.txt) may be either a <sitemapindex> or a <urlset>, and
//   our single sitemap (~1.6k URLs / ~290 KB) is far under the 50k-URL / 50 MB
//   single-file limits, so a sitemap index buys nothing.
//
// Why middleware, not an xs-app.json route:
//   @sap/approuter route config only rewrites+proxies or serves a localDir — it
//   has no native 3xx-redirect verb. A middleware in insertMiddleware.first is
//   the same deterministic pattern used by security-txt.js / well-known-oauth.js
//   and runs BEFORE xs-app.json route matching, so /sitemap.xml itself (which
//   does NOT match the legacy shape) still proxies to CAP untouched.
//
// Pure matcher + handler, both exported for the unit test. Approuter-native CJS
// (like catalog-legacy-redirects.js) — NOT copied from srv/lib.

'use strict'

// Legacy sitemap shapes at the site root: /sitemap_index.xml and the numbered
// shards /sitemap_<n>.xml (case-insensitive). Deliberately does NOT match the
// current /sitemap.xml (dot, not underscore) so that keeps proxying to CAP.
const LEGACY_SITEMAP_RE = /^\/sitemap_(?:index|\d+)\.xml$/i

const CANONICAL_SITEMAP = '/sitemap.xml'

/**
 * Map a legacy AEM sitemap URL to the canonical /sitemap.xml.
 *
 * /sitemap_index.xml → /sitemap.xml
 * /sitemap_1.xml     → /sitemap.xml   (2, 3, … likewise)
 *
 * Sitemaps take no meaningful query string, so any query is dropped (the target
 * is always the bare canonical path). Returns null for anything else — notably
 * the live /sitemap.xml, which must not be touched.
 *
 * @param {string} url - path-or-path+query URL, e.g. '/sitemap_index.xml'
 * @returns {string | null} '/sitemap.xml' for a legacy sitemap URL, else null
 */
function matchLegacySitemapUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  const pathname = url.split('?')[0]
  if (!LEGACY_SITEMAP_RE.test(pathname)) return null
  return CANONICAL_SITEMAP
}

// Express-style middleware. Mount at path '/' in insertMiddleware.first, BEFORE
// the static/proxy handlers so the legacy URL is answered here and never falls
// through to the xs-app.json catch-all (which 404s it).
function sitemapIndexRedirectHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()

  const target = matchLegacySitemapUrl(req.url || '')
  if (!target) return next()

  res.writeHead(301, {
    Location: target,
    'Cache-Control': 'public, max-age=86400',
  })
  res.end()
}

module.exports = {
  sitemapIndexRedirectHandler,
  // exported for the unit test
  matchLegacySitemapUrl,
  CANONICAL_SITEMAP,
}

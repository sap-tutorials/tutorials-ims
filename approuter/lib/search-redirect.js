// approuter/lib/search-redirect.js
//
// 301-redirects the legacy `/search` entry point to this platform's canonical
// tutorial finder at /tutorial-navigator/, preserving any query string.
//
// Background:
//   The old site exposed a top-level /search page. That has been replaced by
//   /tutorial-navigator/ (an SSR page served from HANA via CAP). External links
//   and bookmarks to /search (and /search?q=…) must land on the navigator, with
//   the user's query carried across so the navigator can pre-seed its filter.
//
//   Only the EXACT /search entry point redirects here — deeper /search/<path>
//   URLs (e.g. the search JSON API) still proxy to srv-api via xs-app.json.
//
// Why middleware, not an xs-app.json route:
//   @sap/approuter route config only rewrites+proxies or serves a localDir — it
//   has no native 3xx-redirect verb. A prior attempt added `"status": 301` to an
//   xs-app.json route; @sap/approuter v16 rejects that unknown property at boot
//   (`xs-app.json/routes/<n>/status: Additional properties not allowed`), which
//   crash-loops the approuter. A middleware in insertMiddleware.first is the same
//   deterministic pattern used by sitemap-index-redirect.js / security-txt.js and
//   runs BEFORE xs-app.json route matching, so /search/<path> (which this does
//   NOT match) still proxies to srv-api untouched.
//
// Pure matcher + handler, both exported for the unit test. Approuter-native CJS
// (like sitemap-index-redirect.js) — NOT copied from srv/lib.

'use strict'

// The exact legacy search entry point at the site root: /search or /search/,
// optionally followed by a query string. Deliberately does NOT match deeper
// /search/<path> URLs so those keep proxying to srv-api.
const SEARCH_ENTRY_RE = /^\/search\/?$/

const NAVIGATOR_PATH = '/tutorial-navigator/'

/**
 * Map the legacy /search entry point to /tutorial-navigator/, preserving the
 * query string.
 *
 * /search            → /tutorial-navigator/
 * /search/           → /tutorial-navigator/
 * /search?q=cap      → /tutorial-navigator/?q=cap
 * /search/?q=cap     → /tutorial-navigator/?q=cap
 *
 * Returns null for anything else — notably /search/<path> (the search API),
 * which must keep proxying to srv-api.
 *
 * @param {string} url - path-or-path+query URL, e.g. '/search?q=cap'
 * @returns {string | null} the navigator target for the /search entry point, else null
 */
function matchSearchUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  const qIdx = url.indexOf('?')
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx)
  if (!SEARCH_ENTRY_RE.test(pathname)) return null
  const query = qIdx === -1 ? '' : url.slice(qIdx) // includes the leading '?'
  return NAVIGATOR_PATH + query
}

// Express-style middleware. Mount at path '/' in insertMiddleware.first, BEFORE
// the static/proxy handlers so /search is answered here and never falls through
// to the xs-app.json /search/<path> proxy route.
function searchRedirectHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()

  const target = matchSearchUrl(req.url || '')
  if (!target) return next()

  res.writeHead(301, {
    Location: target,
    'Cache-Control': 'public, max-age=86400',
  })
  res.end()
}

module.exports = {
  searchRedirectHandler,
  // exported for the unit test
  matchSearchUrl,
  NAVIGATOR_PATH,
}

// Legacy AEM catalog-URL normalization (group / mission item pages).
//
// developers.sap.com (AEM) served group and mission item pages at the site
// ROOT using a dot-delimited shape:
//
//   /group.<slug>.html      e.g. /group.deploy-full-stack-cap-kyma-runtime.html
//   /mission.<slug>.html
//
// The current app serves those pages DB-rendered under the hyphen-prefixed
// path /tutorials/group-<slug> and /tutorials/mission-<slug> (see
// content-store.js serveHandler, which also owns slug rename-redirects and the
// published-page 404). No Hugo static folder exists for them, so the generic
// `*.html → */` catch-all in server.js never fires — hence the need to
// translate the legacy shape into the canonical path here and let serveHandler
// resolve the slug the rest of the way.
//
// Pure function, no I/O — unit-tested in test/unit. Approuter-native CJS
// (like bearer-auth.js / safe-fetch.js); NOT copied from srv/lib.

'use strict'

// Site-root dot-form: /(group|mission).<slug>.html  (case-insensitive).
// The slug capture stops at the trailing `.html`, and rejects `/ ? #` so a
// deeper path or query can't leak into the slug.
const LEGACY_CATALOG_RE = /^\/(group|mission)\.([^/?#]+)\.html$/i

// Canonical slug shape enforced by content-store.js VALID_SLUG. Guard here so
// a legacy slug that can't be canonical (e.g. an embedded dot) is left for the
// normal 404 path instead of 301-ing into a guaranteed miss.
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/

/**
 * Normalize a legacy dot-form catalog URL to its canonical app path.
 *
 * `/group.<slug>.html`   → `/tutorials/group-<slug>`
 * `/mission.<slug>.html` → `/tutorials/mission-<slug>`
 *
 * The slug is lowercased to match the canonical lowercase keys; serveHandler
 * would 301 a mixed-case slug to lowercase anyway, so collapsing that hop here
 * avoids a redirect chain. The query string is preserved.
 *
 * @param {string} url - path-only URL, e.g. '/group.foo.html?utm=x'
 * @returns {string | null} canonical path, or null if not a legacy catalog URL
 */
function normalizeLegacyCatalogUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null

  const qIdx = url.indexOf('?')
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx)
  const query = qIdx === -1 ? '' : url.slice(qIdx)

  const m = pathname.match(LEGACY_CATALOG_RE)
  if (!m) return null

  const kind = m[1].toLowerCase() // 'group' | 'mission'
  const slug = m[2].toLowerCase()
  if (!VALID_SLUG.test(slug)) return null

  return `/tutorials/${kind}-${slug}${query}`
}

module.exports = { normalizeLegacyCatalogUrl }

/**
 * Pure-function legacy redirect resolver.
 * No I/O, no module-singleton state, no caching.
 *
 * MIRROR of srv/lib/legacy-redirects-resolver.js — the approuter cannot
 * `import('../srv/lib/...')` at runtime on Cloud Foundry (approuter and srv
 * are separate app containers with separate filesystems). Source of truth
 * lives at srv/lib/legacy-redirects-resolver.js; mta.yaml's before-all
 * copies it here at build time. Keep these two files in sync — if you edit
 * the srv copy, re-run the cp (or just `mbt build`) before committing.
 *
 * @module legacy-redirects-resolver
 */

/**
 * Build an opaque index from a list of redirect rows.
 * Inactive rows are filtered out at build time.
 *
 * @param {Array} rows - Redirect records with fields:
 *   id, fromPath, toPath, statusCode, isPattern, isActive
 * @returns {{ exactMap: Map, patterns: Array }}
 */
export function buildIndex(rows) {
  const exactMap = new Map();
  const patterns = [];
  for (const row of rows || []) {
    if (!row?.isActive) continue;
    if (row.isPattern) {
      patterns.push({ regex: new RegExp(row.fromPath), redirect: row });
    } else {
      exactMap.set(row.fromPath.toLowerCase(), row);
    }
  }
  return { exactMap, patterns };
}

/**
 * Split a path-only URL into pathname and query suffix.
 * Does not use new URL() because bare paths (no host) would throw.
 *
 * @param {string} url
 * @returns {{ pathname: string, query: string }}
 */
function splitUrl(url) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return { pathname: url, query: '' };
  return { pathname: url.slice(0, qIdx), query: url.slice(qIdx) };
}

/**
 * Append a query string to a target path, unless the target already has one.
 *
 * @param {string} toPath
 * @param {string} query - e.g. '?utm=foo' or ''
 * @returns {string}
 */
function appendQuery(toPath, query) {
  if (!query) return toPath;
  if (toPath.includes('?')) return toPath;
  return toPath + query;
}

/**
 * Resolve an inbound URL against the pre-built index.
 * Exact matches are case-insensitive; patterns run against the original pathname.
 * Capture group substitution: $1, $2, … ($0 = whole match).
 *
 * @param {{ exactMap: Map, patterns: Array }} index
 * @param {string} url - path-only URL, e.g. '/foo/bar?q=1'
 * @returns {{ id: string, toPath: string, statusCode: number } | null}
 */
export function resolveRedirect(index, url) {
  if (!index || !url) return null;
  const { pathname, query } = splitUrl(url);

  // O(1) exact lookup (case-insensitive)
  const exact = index.exactMap.get(pathname.toLowerCase());
  if (exact) {
    return {
      id: exact.id,
      toPath: appendQuery(exact.toPath, query),
      statusCode: exact.statusCode || 301,
    };
  }

  // O(n) pattern walk — first match wins
  for (const { regex, redirect } of index.patterns) {
    const m = pathname.match(regex);
    if (m) {
      const resolved = redirect.toPath.replace(
        /\$(\d+)/g,
        (_, n) => m[Number(n)] ?? ''
      );
      return {
        id: redirect.id,
        toPath: appendQuery(resolved, query),
        statusCode: redirect.statusCode || 301,
      };
    }
  }

  return null;
}

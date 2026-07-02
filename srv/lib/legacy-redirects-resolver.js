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
 * #891: rows with a non-same-origin toPath are rejected at build time so
 * the resolver hot path is guaranteed to only emit relative Location
 * targets. Admins can only edit redirects to point at paths under this
 * origin — no external redirects.
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
    if (!isSameOriginPath(row.toPath)) {
      // Drop external redirects rather than serving them. This preserves the
      // rest of the redirect index if a single row is malformed.
      // (approuter/server.js emits a warning above; keep the resolver silent.)
      continue;
    }
    if (row.isPattern) {
      patterns.push({ regex: new RegExp(row.fromPath), redirect: row });
    } else {
      exactMap.set(row.fromPath.toLowerCase(), row);
    }
  }
  return { exactMap, patterns };
}

/**
 * #891 — return true if `toPath` is a same-origin absolute path.
 *
 * Rejects:
 *   - undefined / null / empty string
 *   - protocol-relative URLs (//attacker.com)
 *   - URLs with an explicit scheme (http:, https:, javascript:, data:, mailto:, etc.)
 *   - paths that don't start with `/`
 *
 * Accepts anything that starts with a single `/` and can also validate the
 * resulting URL parses as a same-origin URL (belt-and-suspenders).
 *
 * @param {string} toPath
 * @returns {boolean}
 */
export function isSameOriginPath(toPath) {
  if (typeof toPath !== 'string' || toPath.length === 0) return false;
  // Protocol-relative: //evil.com or //evil.com/x — browser treats as external
  if (toPath.startsWith('//')) return false;
  // Any scheme: <letter><letter/digit/+/-/.>*:
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(toPath)) return false;
  // Must be an absolute path
  if (!toPath.startsWith('/')) return false;
  return true;
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
      // #891: capture-group substitution could turn a benign toPath like
      // '/new-$1' into '/new-http://attacker.example' if the URL provided
      // '$1' evilly. Re-validate the substituted result.
      if (!isSameOriginPath(resolved)) continue;
      return {
        id: redirect.id,
        toPath: appendQuery(resolved, query),
        statusCode: redirect.statusCode || 301,
      };
    }
  }

  return null;
}

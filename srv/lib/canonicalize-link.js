// srv/lib/canonicalize-link.js
//
// Canonicalize a URL for use as a stable identifier when an RSS feed omits <guid>.
// Lowercases scheme/host/path; strips tracking params (utm_*, sc_camp, mc_cid, mc_eid).
// Returns the input unchanged if URL construction fails. (#1034)

const STRIP_EXACT = new Set(['sc_camp', 'mc_cid', 'mc_eid']);
const STRIP_PREFIX = ['utm_'];

/** @param {string} url */
export function canonicalizeLink(url) {
  if (!url) return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const kept = [];
  for (const [k, v] of u.searchParams) {
    if (STRIP_EXACT.has(k)) continue;
    if (STRIP_PREFIX.some(p => k.startsWith(p))) continue;
    kept.push([k, v]);
  }
  const qs = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const path = u.pathname.toLowerCase();
  const host = u.host.toLowerCase();
  const scheme = u.protocol.toLowerCase();
  const suffix = qs ? `?${qs}` : '';
  const hash = u.hash;
  return `${scheme}//${host}${path}${suffix}${hash}`;
}

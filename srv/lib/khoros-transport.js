//
// (#1144) Khoros LiQL JSON transport for community blog fetches — the durable
// successor to the curl transport (#1145). community.sap.com runs on Khoros
// (Lithium) and exposes an UNAUTHENTICATED LiQL JSON API at
// /api/2.0/search?q=<LiQL>. We hit that instead of the Cloudflare-403'd RSS
// feeds, then synthesize RSS-compatible XML from the JSON so the existing
// parseRss() chain is untouched.
//
// SECURITY: like curl-transport.js, this is a `fetch`-shaped TRANSPORT only —
// it performs NO SSRF validation of its own. It is injected into safeFetch()
// (srv/lib/safe-fetch.js) as `fetchImpl`, with allowedHosts pinned to
// community.sap.com, so the host allowlist + private-IP rejection + per-hop
// redirect re-validation all still run in safeFetch.
//
// TEST NOTE: unlike curl-transport.js (which shells out and bypasses
// vi.stubGlobal('fetch')), THIS transport uses native fetch — so khoros-mode
// tests CAN stub global.fetch. Contrast memory curl-transport-bypasses-fetch-stub.

const KHOROS_API_BASE = 'https://community.sap.com/api/2.0/search';
const SELECT_CLAUSE = 'SELECT subject,post_time,view_href,teaser,author.login FROM messages';
const FIXED_TAIL = 'AND depth=0 ORDER BY post_time DESC LIMIT 20';

// Allowlist: a LiQL WHERE predicate is field comparisons joined by AND/OR.
// Permit letters, digits, underscore, dot, single-quote, equals, spaces, hyphen.
// Reject anything that could break out of the WHERE clause we build: we add
// our own SELECT/ORDER/LIMIT and parens, so those keywords in admin input are
// rejected outright.
const ALLOWED_CHARS = /^[A-Za-z0-9_.'= -]+$/;
const FORBIDDEN_WORDS = /\b(SELECT|LIMIT|ORDER|FROM|DELETE|INSERT|UPDATE)\b/i;

export function validateApiQuery(apiQuery) {
  if (!apiQuery || typeof apiQuery !== 'string') return false;
  if (!ALLOWED_CHARS.test(apiQuery)) return false;
  if (FORBIDDEN_WORDS.test(apiQuery)) return false;
  return true;
}

export function buildKhorosUrl(apiQuery) {
  const liql = `${SELECT_CLAUSE} WHERE (${apiQuery}) ${FIXED_TAIL}`;
  return `${KHOROS_API_BASE}?q=${encodeURIComponent(liql)}`;
}

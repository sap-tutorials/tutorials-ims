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

const MAX_BODY_BYTES = 1 << 20; // 1 MiB cap on the JSON response

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

/**
 * Adapt Khoros JSON `data.items` into RSS 2.0 XML that parseRss() consumes.
 * We emit channel-level <language>en so isEnglish() short-circuits to accept
 * (the Khoros query is already board/category-scoped to English content).
 * subject/teaser/author are wrapped in CDATA to preserve literal content (no
 * entity escaping needed); view_href is the permalink used as both <link> and
 * (downstream) sourceUrl.
 */
export function itemsToRssXml(items) {
  const list = Array.isArray(items) ? items : [];
  const body = list.map((it) => {
    const title = it.subject ?? '';
    const link = xmlEscape(it.view_href);
    const pubDate = it.post_time ? new Date(it.post_time).toISOString() : '';
    const desc = it.teaser ?? '';
    const author = it.author?.login ?? '';
    return (
      `<item>` +
      `<title><![CDATA[${title}]]></title>` +
      `<link>${link}</link>` +
      (pubDate ? `<pubDate>${pubDate}</pubDate>` : '') +
      `<description><![CDATA[${desc}]]></description>` +
      (author ? `<dc:creator><![CDATA[${author}]]></dc:creator>` : '') +
      `</item>`
    );
  }).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<channel><language>en</language>${body}</channel></rss>`
  );
}

/**
 * fetch-shaped transport backed by the Khoros JSON API. `url` is the fully
 * built /api/2.0/search URL (see buildKhorosUrl). Returns a Response-shaped
 * object whose text() yields synthesized RSS XML.
 */
export function khorosFetch(url, init = {}) {
  return (async () => {
    const res = await fetch(url, {
      ...init,
      redirect: 'manual', // safeFetch re-validates each hop
    });
    if (res.status < 200 || res.status >= 300) {
      // Non-2xx (e.g. CF egress 403) — surface status; body irrelevant.
      return {
        ok: false, status: res.status,
        headers: { get: (n) => res.headers?.get?.(n) ?? null },
        async text() { return ''; },
      };
    }
    let xml = '';
    try {
      const raw = await res.text();
      if (raw.length > MAX_BODY_BYTES) throw new Error('khoros body too large');
      const json = JSON.parse(raw);
      xml = itemsToRssXml(json?.data?.items);
    } catch {
      xml = itemsToRssXml([]); // fail-open → empty <rss>
    }
    return {
      ok: true, status: 200,
      headers: { get: (n) => res.headers?.get?.(n) ?? null },
      async text() { return xml; },
    };
  })();
}

import cds from '@sap/cds';

const LOG = cds.log('mcp-news-detail');

// Only SAP-owned news hosts may be fetched. This is an SSRF guard: `url` is a
// caller-supplied value on an anonymous MCP surface and we fetch it server-side.
const ALLOWED_HOSTS = new Set(['news.sap.com', 'community.sap.com', 'blogs.sap.com']);
const MAX_CONTENT_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h read-through cache (matches the CLI)

const _cache = new Map(); // url -> { at, value }

/** Test-only: clear the read-through cache. */
export function _resetCacheForTest() { _cache.clear(); }

/** True iff `url` is http(s) and its host is an allowed SAP news host (or subdomain). */
export function isAllowedNewsHost(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.has(host) || [...ALLOWED_HOSTS].some((h) => host.endsWith('.' + h));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Strip HTML to readable plain text: drop script/style/comments, prefer the
 * <article>/<main> body when present, remove remaining tags, decode entities,
 * collapse whitespace, and cap length.
 */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const main = s.match(/<article[\s\S]*?<\/article>/i) || s.match(/<main[\s\S]*?<\/main>/i);
  if (main) s = main[0];
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return s.slice(0, MAX_CONTENT_CHARS);
}

function matchMetaContent(html, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function extractTitle(html) {
  const og = matchMetaContent(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og;
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decodeEntities(t[1]).replace(/\s+/g, ' ').trim() : '';
}

function extractDescription(html) {
  return matchMetaContent(
    html,
    /<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]+content=["']([^"']*)["']/i,
  );
}

function extractPublished(html) {
  const m = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/**
 * Fetch and extract the full body of one SAP news article.
 *
 * @param url   Article link (must pass isAllowedNewsHost).
 * @param opts  { fetchImpl, now } — injectable for tests.
 * @throws Error with .code 'DISALLOWED_HOST' | 'UPSTREAM_ERROR'
 */
export async function fetchNewsDetail(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now();

  if (!isAllowedNewsHost(url)) {
    const e = new Error(`Refusing to fetch non-SAP-news host: ${url}`);
    e.code = 'DISALLOWED_HOST';
    throw e;
  }

  const cached = _cache.get(url);
  if (cached && (now - cached.at) < CACHE_TTL_MS) return cached.value;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let html;
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      const e = new Error(`Upstream ${res.status} fetching ${url}`);
      e.code = 'UPSTREAM_ERROR';
      throw e;
    }
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const value = {
    title:       extractTitle(html),
    url,
    publishedAt: extractPublished(html),
    summary:     extractDescription(html),
    content:     htmlToText(html),
    fetchedAt:   new Date(now).toISOString(),
  };
  _cache.set(url, { at: now, value });
  return value;
}

/**
 * MCP curated tool handler: full article body for one SAP Developer News item.
 * Bound in homepage-service.js. Rejects non-SAP hosts (400) and upstream
 * failures (502); never leaks an unexpected stack to the MCP client.
 */
export async function handleGetNewsDetail(req) {
  const url = typeof req.data?.url === 'string' ? req.data.url.trim() : '';
  if (!url) return req.reject(400, 'url is required');
  try {
    return await fetchNewsDetail(url);
  } catch (err) {
    if (err.code === 'DISALLOWED_HOST') return req.reject(400, err.message);
    LOG.warn('get_news_detail failed:', err.message);
    return req.reject(502, `Could not fetch news detail: ${err.message}`);
  }
}

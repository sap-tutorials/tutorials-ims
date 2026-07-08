// srv/lib/homepage-rss-fetcher.js
//
// Minimal RSS fetcher for the homepage Community lane (Row 6). (#639)
//
// Exposes:
//   fetchRssItems(url, { limit })
//     -> Promise<Array<{ title, link, publishedAt, description }>>
//
// Cache: 30-min TTL keyed on url (URL is the cache key).
// Failures are NOT cached -- RSS feeds recover faster than YouTube quota resets.
// Module-singleton via globalThis Symbol per feedback_module_singletons_in_vitest_cds.

import cds from '@sap/cds';
import { safeFetch } from './safe-fetch.js';
import { parseRss, RSS_FETCH_HEADERS } from './rss-parse.js';

const log = cds.log('homepage-rss-fetcher');

const TTL_MS     = 30 * 60 * 1000;  // 30 minutes
const TIMEOUT_MS = 5000;             // 5 seconds

// --- Module-singleton state (#639) -----------------------------------------

const STATE_KEY = Symbol.for('com.sap.developers.ims:homepage-rss-fetcher');
const _state = (globalThis[STATE_KEY] ??= {
  // Map<url, { value: Array<item>, expiresAt: number }>
  cache: new Map(),
});

/** Test-only: clear all cached values. */
export function _resetForTests() {
  _state.cache.clear();
}

// --- Internal helpers -------------------------------------------------------

// (#1033) parseRss extracted into srv/lib/rss-parse.js so the Community Blog
// Posts fetcher can reuse it. Original semantics preserved; the shared helper
// also exposes item-level language which we ignore here.

// --- Public API -------------------------------------------------------------

/**
 * Fetch and parse RSS items from `url`. (#639)
 *
 * @param {string} url          -- RSS feed URL (used as cache key)
 * @param {object} [opts]
 * @param {number} [opts.limit] -- max items to return (default 5)
 * @returns {Promise<Array<{ title: string, link: string, publishedAt: string|null, description: string|null }>>}
 */
export async function fetchRssItems(url, { limit = 5 } = {}) {
  // Cache hit
  const cached = _state.cache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value.slice(0, limit);
  }

  let res;
  try {
    // #895: safeFetch validates protocol, rejects private/link-local
    // addresses, and re-checks the guard on every 3xx hop. Prevents any
    // future admin-editable RSS URL from pivoting to IMDS or internal CF.
    // #1033: browser-shaped UA + Accept header. Cloudflare returns 403 to
    // the default Node fetch UA on community.sap.com feeds; this fixes
    // the silently-empty Community lane the site has been running with.
    res = await safeFetch(url, {
      allowedProtocols: ['https:'],
      timeoutMs: TIMEOUT_MS,
      maxRedirects: 3,
      fetchInit: { headers: RSS_FETCH_HEADERS },
    });
  } catch (err) {
    // Network error / timeout / SSRF_BLOCKED -- do NOT cache; next call will retry
    log.warn(`homepage-rss-fetcher: fetch failed for ${url}: ${err.code || ''} ${err.message}`);
    return [];
  }

  if (!res.ok) {
    // Non-2xx -- do NOT cache; next call will retry
    log.warn(`homepage-rss-fetcher: non-2xx ${res.status} for ${url}`);
    return [];
  }

  // Successful response -- parse, sort, cache (even if zero items)
  let xml;
  try {
    xml = await res.text();
  } catch (err) {
    log.warn(`homepage-rss-fetcher: failed to read response body for ${url}: ${err.message}`);
    return [];
  }

  const items = parseRss(xml, { log }).sort(
    (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0),
  );

  // Cache the full sorted array (not the slice) so different limit values share the cache
  _state.cache.set(url, { value: items, expiresAt: Date.now() + TTL_MS });

  return items.slice(0, limit);
}

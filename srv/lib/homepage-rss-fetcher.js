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
import { curlFetch } from './curl-transport.js';
import { buildKhorosUrl, khorosFetch } from './khoros-transport.js';

const log = cds.log('homepage-rss-fetcher');

// (#1144) Tri-state transport — see community-blogs-fetcher.js. Default khoros.
function rssMode() {
  const m = process.env.RSS_TRANSPORT;
  return m === 'curl' || m === 'fetch' ? m : 'khoros';
}

// Derive a Khoros LiQL predicate from a community.sap.com RSS feed URL.
// board feeds carry ?board.id=<id>; returns null if not derivable.
function apiQueryFromFeedUrl(url) {
  try {
    const boardId = new URL(url).searchParams.get('board.id');
    if (boardId && /^[A-Za-z0-9_-]+$/.test(boardId)) return `board.id='${boardId}'`;
  } catch { /* fall through */ }
  return null;
}

const TTL_MS     = 30 * 60 * 1000;  // 30 minutes
const TIMEOUT_MS = 5000;             // 5 seconds

// --- Shared caching service (#1181) ----------------------------------------
//
// Replaces the former hand-rolled globalThis-singleton Map (30-min TTL keyed
// on url) with the shared `caching` service (cds-caching plugin), following
// the #1177/#1180 migration pattern: async get/set, tag-based invalidation,
// fail-open. In prod a shared store gives cross-instance coherence for free.
//
// Cache key: `rss:<url>` — the feed URL is the identity, namespaced with an
// `rss:` prefix so this source's keys never collide with the other consumers
// of the shared store (`slice:`, `pat:`, `yt:`, `khoros:`, kg-neighborhood).
// Every entry is tagged RSS_TAG so all RSS entries can be busted together.
//
// TTL/failure policy preserved from the LRU version: successful responses are
// cached 30 min; failures (network/timeout/SSRF-block/non-2xx) are NOT cached
// so the next call retries immediately — RSS feeds recover faster than a TTL.
const RSS_TAG = 'homepage-rss';

function rssKey(url) {
  return `rss:${url}`;
}

// Memoized connection to the caching service (same pattern as
// kg-neighborhood-cache.js / tutorial-step-slicer.js, #1177/#1180).
let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/**
 * Test-only: reset the memoized caching connection and clear the shared store
 * so a test booting a fresh cds runtime doesn't reuse a stale service handle
 * or see entries left by a previous test. (The former in-process Map is gone;
 * the caching store owns entry lifetime now.) Fail-open — a store not yet
 * connected just no-ops.
 */
export async function _resetForTests() {
  try {
    // Connect-and-clear unconditionally (cds caches the connection). Must NOT
    // gate on `_cachePromise` — the store entries survive across tests even
    // when this module hasn't re-connected yet, so gating would skip the clear
    // and leak a prior test's cached feed under the same URL key.
    await (await cds.connect.to('caching')).clear();
  } catch { /* store not configured in this test — ignore */ }
  _cachePromise = undefined;
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
  // Cache hit. Fail-open: any caching-service fault → treat as miss and fall
  // through to the live fetch rather than erroring the page render.
  try {
    const hit = await (await cache()).get(rssKey(url));
    if (hit) return hit.slice(0, limit);
  } catch (err) {
    log.warn(`homepage-rss-fetcher: cache get failed for ${url}, treating as miss: ${err.message}`);
  }

  let res;
  try {
    // #895: safeFetch validates protocol, rejects private/link-local
    // addresses, and re-checks the guard on every 3xx hop. Prevents any
    // future admin-editable RSS URL from pivoting to IMDS or internal CF.
    // #1033: browser-shaped UA + Accept header. Cloudflare returns 403 to
    // the default Node fetch UA on community.sap.com feeds; this fixes
    // the silently-empty Community lane the site has been running with.
    const mode = rssMode();
    let target = url;
    let fetchImpl;
    let allowedHosts;
    const apiQuery = mode === 'khoros' ? apiQueryFromFeedUrl(url) : null;
    if (mode === 'khoros' && apiQuery) {
      target = buildKhorosUrl(apiQuery);
      fetchImpl = khorosFetch;
      allowedHosts = new Set(['community.sap.com']);
    } else if (mode === 'khoros' || mode === 'curl') {
      fetchImpl = curlFetch;
    }
    res = await safeFetch(target, {
      allowedProtocols: ['https:'],
      allowedHosts,
      timeoutMs: TIMEOUT_MS,
      maxRedirects: 3,
      fetchInit: { headers: RSS_FETCH_HEADERS },
      fetchImpl,
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

  // Cache the full sorted array (not the slice) so different limit values
  // share the cache. Failures were already returned above without caching, so
  // only successful responses reach here. Fail-open: a store fault just means
  // the next call misses and re-fetches.
  try {
    await (await cache()).set(rssKey(url), items, {
      ttl: TTL_MS,
      tags: [{ value: RSS_TAG }],
    });
  } catch (err) {
    log.warn(`homepage-rss-fetcher: cache set failed for ${url}, entry not cached: ${err.message}`);
  }

  return items.slice(0, limit);
}

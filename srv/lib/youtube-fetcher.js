// srv/lib/youtube-fetcher.js
//
// YouTube Data API v3 fetcher for the SAPDevs band on the homepage (Row 4). (#639)
//
// Exposes:
//   fetchSapDevsVideos({ apiKey, playlistId, channelHandle })
//     → { featured, recent, error }
//
// featured: { videoId, title, thumbnail, publishedAt } | null
// recent:   Array<{ videoId, title, thumbnail, publishedAt }>  (up to 3)
// error:    string | null
//
// Three HTTP calls per cache miss:
//   1) GET /channels?forHandle=   — resolve channel ID (cached forever in module scope)
//   2) GET /playlistItems?...     — single "featured" entry from a playlist (if playlistId set)
//   3) GET /search?...            — 3 most-recent uploads from the channel
//
// Cache (#740): 15-min TTL on success, 1-min TTL on failure. Failures still
// get cached briefly to throttle retry storms on real quota exhaustion, but
// the user-visible damage of a transient 4xx/5xx is capped at 1 minute
// instead of 15. Keyed on "${channelHandle}|${playlistId||''}".
// Module-singleton via globalThis Symbol per feedback_module_singletons_in_vitest_cds.

import cds from '@sap/cds';

const log = cds.log('youtube-fetcher');

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const TTL_MS         = 15 * 60 * 1000;  // 15 minutes for successful results
const FAILURE_TTL_MS = 60 * 1000;       // 1 minute for failed results (#740)
const TIMEOUT_MS = 5000;

// --- Shared caching service (#1181) ----------------------------------------
//
// Replaces the former hand-rolled globalThis-singleton Maps (result cache +
// channel-ID cache) with the shared `caching` service (cds-caching plugin),
// following the #1177/#1180 migration pattern: async get/set, tag-based
// invalidation, fail-open. In prod a shared store gives cross-instance
// coherence for free (all CF instances warm the same entries).
//
// Two key families, both namespaced with a `yt:` prefix so they never collide
// with the other consumers of the shared store, and both tagged YT_TAG so a
// single deleteByTag wipes everything YouTube-related:
//   `yt:videos:<handle>|<playlistId>`  — the { featured, recent, error } result
//   `yt:channel-id:<handle>`           — the resolved channel ID
//
// TTL policy preserved from the LRU version (#740):
//   - result success → 15 min; result failure → 1 min (caps a transient
//     4xx/5xx blip at 1 min instead of poisoning the rail for 15).
//   - channel ID → CHANNEL_ID_TTL_MS (effectively "forever" for a render
//     cycle; a handle→id mapping is stable). The old code cached it for the
//     process lifetime; a long TTL is the serializing-store equivalent.
const YT_TAG = 'homepage-youtube';
const CHANNEL_ID_TTL_MS = 24 * 60 * 60 * 1000;  // 24h — handle→id is stable

function videosKey(channelHandle, playlistId) {
  return `yt:videos:${channelHandle}|${playlistId || ''}`;
}
function channelIdKey(handle) {
  return `yt:channel-id:${handle}`;
}

// Memoized connection to the caching service (same pattern as
// kg-neighborhood-cache.js / homepage-rss-fetcher.js, #1177/#1180/#1181).
let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/**
 * Test-only: reset the memoized caching connection and clear the shared store
 * so a test booting a fresh cds runtime doesn't reuse a stale service handle
 * or entries from a previous test. Fail-open — an unconnected store no-ops.
 */
export async function _resetForTests() {
  try {
    // Connect-and-clear unconditionally (cds caches the connection). Gating on
    // `_cachePromise` would leak a prior test's entries when this module hasn't
    // re-connected yet — see homepage-rss-fetcher.js for the failure mode.
    await (await cds.connect.to('caching')).clear();
  } catch { /* store not configured in this test — ignore */ }
  _cachePromise = undefined;
}

// --- Internal helpers -------------------------------------------------------

/**
 * Fetch a URL with a 5 s timeout; parse and return JSON body.
 * Throws an error (with `.status` set) on non-2xx responses.
 */
async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) {
    const err = new Error(`YouTube API ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * Resolve a @handle to a YouTube channel ID.
 * Result is cached in the shared store under `yt:channel-id:<handle>` (24h TTL;
 * a handle→id mapping is stable, 1 quota unit per cold call). Fail-open on
 * cache faults: fall through to a live resolve.
 */
async function resolveChannelId(handle, apiKey) {
  try {
    const hit = await (await cache()).get(channelIdKey(handle));
    if (hit) return hit;
  } catch (err) {
    log.warn(`channel-id cache get failed for ${handle}, treating as miss: ${err.message}`);
  }
  const url = `${API_BASE}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  const id = data.items?.[0]?.id;
  if (id) {
    try {
      await (await cache()).set(channelIdKey(handle), id, {
        ttl: CHANNEL_ID_TTL_MS,
        tags: [{ value: YT_TAG }],
      });
    } catch (err) {
      log.warn(`channel-id cache set failed for ${handle}, not cached: ${err.message}`);
    }
  }
  return id;
}

// --- Public API -------------------------------------------------------------

/**
 * Fetch featured + recent SAPDevs videos from YouTube Data API v3. (#639)
 *
 * @param {object} opts
 * @param {string}      opts.apiKey         — YouTube Data API key
 * @param {string|null} opts.playlistId     — playlist ID for the "featured" slot (or null)
 * @param {string}      opts.channelHandle  — e.g. '@sapdevs'
 * @returns {Promise<{ featured: object|null, recent: object[], error: string|null }>}
 */
export async function fetchSapDevsVideos({ apiKey, playlistId, channelHandle }) {
  // Guard: no key → skip HTTP entirely
  if (!apiKey) return { featured: null, recent: [], error: 'no-api-key' };

  // Cache hit. Fail-open: any caching-service fault → treat as miss and fall
  // through to the live YouTube calls rather than erroring the video band.
  try {
    const hit = await (await cache()).get(videosKey(channelHandle, playlistId));
    if (hit) return hit;
  } catch (err) {
    log.warn(`youtube-fetcher: cache get failed for ${channelHandle}, treating as miss: ${err.message}`);
  }

  let featured = null;
  let recent   = [];
  let error    = null;

  // 1) Featured video from playlist (if playlistId supplied)
  if (playlistId) {
    try {
      const url = `${API_BASE}/playlistItems?part=snippet&maxResults=1&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}`;
      const data = await fetchJson(url);
      const item = data.items?.[0]?.snippet;
      if (item) {
        featured = {
          videoId:     item.resourceId?.videoId ?? null,
          title:       item.title ?? null,
          // Featured tile is displayed at ~720px wide (3fr column in
          // VideoBand.vue's 3fr/2fr grid); `high` is only 480×360 AND
          // 4:3 so it letterboxes inside the 16:9 aspect-ratio frame.
          // Prefer maxres (1280×720, native 16:9) → standard (640×480)
          // → high. All tiers come back in the same playlistItems
          // response, so no extra HTTP call or quota cost. The `recent`
          // tiles below stay on `high` since they render at 96×54 CSS px.
          thumbnail:   item.thumbnails?.maxres?.url
                    ?? item.thumbnails?.standard?.url
                    ?? item.thumbnails?.high?.url
                    ?? null,
          publishedAt: item.publishedAt ?? null,
        };
      }
    } catch (err) {
      log.warn(`playlistItems call failed: ${err.message}`);
      error = `YouTube API ${err.status ?? err.message}`;
    }
  }

  // 2) Resolve channel ID + fetch recent uploads
  try {
    const channelId = await resolveChannelId(channelHandle, apiKey);
    const url = `${API_BASE}/search?part=snippet&channelId=${encodeURIComponent(channelId)}&order=date&type=video&maxResults=3&key=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url);
    recent = (data.items ?? [])
      .map(it => ({
        videoId:     it.id?.videoId ?? null,
        title:       it.snippet?.title ?? null,
        thumbnail:   it.snippet?.thumbnails?.high?.url ?? null,
        publishedAt: it.snippet?.publishedAt ?? null,
      }))
      .filter(v => v.videoId);
  } catch (err) {
    log.warn(`channel/search call failed: ${err.message}`);
    if (!error) error = `YouTube API ${err.status ?? err.message}`;
  }

  // Cache policy (#740):
  //   - Success: 15 min. Keeps quota use sane (~96 calls/day vs the 10 000
  //     unit limit; /search is 100 units/call).
  //   - Failure: 1 min. The cache still throttles retry storms on real
  //     quota exhaustion (60 calls/hr instead of unbounded) but recovers
  //     from transient 403 / 5xx / network blips in one minute. Was 15 min
  //     for both, which poisoned the rail for 14 min on any one-shot
  //     YouTube hiccup — see commit message for the live diagnosis.
  // Note (#1181): unlike the RSS fetcher, failures ARE cached (1 min) — this
  // is deliberate quota protection, so the differential TTL is passed through
  // to the caching service's `ttl` rather than skipping the write on error.
  const cacheTtlMs = error ? FAILURE_TTL_MS : TTL_MS;
  const value = { featured, recent, error };
  try {
    await (await cache()).set(videosKey(channelHandle, playlistId), value, {
      ttl: cacheTtlMs,
      tags: [{ value: YT_TAG }],
    });
  } catch (err) {
    log.warn(`youtube-fetcher: cache set failed for ${channelHandle}, entry not cached: ${err.message}`);
  }
  return value;
}

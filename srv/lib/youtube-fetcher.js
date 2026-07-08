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

// --- Module-singleton state (#639) -----------------------------------------

const STATE_KEY = Symbol.for('com.sap.developers.ims:youtube-fetcher');
const _state = (globalThis[STATE_KEY] ??= {
  // Map<cacheKey, { value: { featured, recent, error }, expiresAt: number }>
  cache: new Map(),
  // Map<channelHandle, channelId>  — never expires within process lifetime
  channelIdFor: {},
});

/** Test-only: clear all cached values and channel-ID mappings. */
export function _resetForTests() {
  _state.cache.clear();
  _state.channelIdFor = {};
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
 * Result is cached forever in `_state.channelIdFor` (1 quota unit per cold call).
 */
async function resolveChannelId(handle, apiKey) {
  if (_state.channelIdFor[handle]) return _state.channelIdFor[handle];
  const url = `${API_BASE}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  const id = data.items?.[0]?.id;
  if (id) _state.channelIdFor[handle] = id;
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

  const cacheKey = `${channelHandle}|${playlistId || ''}`;

  // Cache hit
  const cached = _state.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

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
  const cacheTtlMs = error ? FAILURE_TTL_MS : TTL_MS;
  const value = { featured, recent, error };
  _state.cache.set(cacheKey, { value, expiresAt: Date.now() + cacheTtlMs });
  return value;
}

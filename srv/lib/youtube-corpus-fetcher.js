// srv/lib/youtube-corpus-fetcher.js
//
// Phase 4.4 (#447): full-channel paginated fetcher for SAP Developers YouTube.
//
// Sibling to srv/lib/youtube-fetcher.js (which targets the homepage band's
// 3-recent-videos shape). Corpus fetcher does full-channel paginated iteration
// for the cron's delta + the backfill script's seed run.
//
// Pattern mirrors srv/lib/khoros-blogs-client.js (Phase 4.2) and
// srv/lib/sap-devs-client.js (Phase 4.1/4.3): module-singleton state,
// _setMockFetcher / _resetForTests hooks, validator throws loudly.

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS = 5000;
const MAX_PAGES = 200;

// Module-singleton state
const STATE_KEY = Symbol.for('com.sap.developers.ims:youtube-corpus-fetcher');
const _state = (globalThis[STATE_KEY] ??= {
  channelIdFor: {},   // Map<channelHandle, uploads-playlist-id>
});

let mockFetcher = null;

export function _setMockFetcher(fn) { mockFetcher = fn; }
export function _resetForTests() {
  _state.channelIdFor = {};
  mockFetcher = null;
}

async function fetchJson(url) {
  if (mockFetcher) return mockFetcher(url);
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) {
    const err = new Error(`YouTube API ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function resolveUploadsPlaylistId(handle, apiKey) {
  if (_state.channelIdFor[handle]) return _state.channelIdFor[handle];
  const url = `${API_BASE}/channels?forHandle=${encodeURIComponent(handle)}&part=contentDetails&key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  const id = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (id) _state.channelIdFor[handle] = id;
  return id;
}

function validateVideoRow(row) {
  for (const field of ['videoId', 'title', 'description', 'publishedAt', 'channelTitle']) {
    if (typeof row?.[field] !== 'string') {
      throw new Error(`youtube-corpus-fetcher: row missing ${field} — ${JSON.stringify(row).slice(0, 200)}`);
    }
  }
  // videoId, title, publishedAt, channelTitle MUST be non-empty. description and
  // thumbnailUrl MAY be empty strings (some Tech Bytes have empty descriptions).
  for (const field of ['videoId', 'title', 'publishedAt', 'channelTitle']) {
    if (row[field] === '') {
      throw new Error(`youtube-corpus-fetcher: row missing ${field} — ${JSON.stringify(row).slice(0, 200)}`);
    }
  }
}

function normaliseRow(item) {
  const s = item.snippet ?? {};
  return {
    videoId:      s.resourceId?.videoId ?? '',
    title:        s.title ?? '',
    description:  s.description ?? '',
    publishedAt:  s.publishedAt ?? '',
    channelTitle: s.channelTitle ?? '',
    thumbnailUrl: s.thumbnails?.high?.url ?? s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url ?? '',
  };
}

/**
 * @param {object} opts
 * @param {string}       opts.apiKey
 * @param {string}       opts.channelHandle    — '@sapdevs' (default)
 * @param {string|null}  opts.sinceIso         — ISO timestamp; null = backfill
 * @param {number}       opts.pageSize         — items per page (default 50; max 50)
 * @param {number|null}  opts.limit            — hard cap on total returned
 * @returns {Promise<Array<object>>} array of video rows
 */
export async function fetchSapDevsVideoCorpus({
  apiKey,
  channelHandle = '@sapdevs',
  sinceIso = null,
  pageSize = 50,
  limit = null,
} = {}) {
  if (!apiKey) throw new Error('youtube-corpus-fetcher: apiKey required');

  const uploadsId = await resolveUploadsPlaylistId(channelHandle, apiKey);
  if (!uploadsId) {
    throw new Error(`youtube-corpus-fetcher: could not resolve uploads playlist for ${channelHandle}`);
  }

  const allVideos = [];
  let pageToken = null;
  let pagesFetched = 0;
  let stopEarly = false;

  while (!stopEarly && pagesFetched < MAX_PAGES) {
    let url = `${API_BASE}/playlistItems?playlistId=${encodeURIComponent(uploadsId)}&part=snippet&maxResults=${pageSize}&key=${encodeURIComponent(apiKey)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const data = await fetchJson(url);
    pagesFetched++;

    for (const item of data.items ?? []) {
      const row = normaliseRow(item);
      validateVideoRow(row);

      // sinceIso filter: stop early when we hit a video older than sinceIso.
      if (sinceIso && row.publishedAt < sinceIso) {
        stopEarly = true;
        break;
      }
      allVideos.push(row);

      if (limit !== null && allVideos.length >= limit) {
        stopEarly = true;
        break;
      }
    }

    pageToken = data.nextPageToken ?? null;
    if (!pageToken) break;
  }

  return allVideos;
}

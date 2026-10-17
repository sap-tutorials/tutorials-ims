import { resolveSecret } from './secret-resolver.js';

// Module-level cache for access token
let cachedAccessToken = null;

/**
 * Gets a Google OAuth access token using the refresh token grant.
 * Caches the token in-module for the process lifetime.
 *
 * @param {Object} deps - Optional dependencies for testing
 * @param {string} deps.clientId - OAuth client ID (defaults to credstore YOUTUBE_OAUTH_CLIENT_ID)
 * @param {string} deps.clientSecret - OAuth client secret (defaults to credstore YOUTUBE_OAUTH_CLIENT_SECRET)
 * @param {string} deps.refreshToken - Refresh token (defaults to credstore YOUTUBE_OAUTH_REFRESH_TOKEN)
 * @param {Function} deps.fetchImpl - Fetch implementation (defaults to globalThis.fetch)
 * @returns {Promise<string>} Access token
 * @throws On non-ok token response or resolution failure
 */
export async function getAccessToken(deps = {}) {
  // Return cached token if available
  if (cachedAccessToken) {
    return cachedAccessToken;
  }

  // Resolve credentials from deps or credstore
  let clientId = deps.clientId;
  let clientSecret = deps.clientSecret;
  let refreshToken = deps.refreshToken;

  if (!clientId) {
    clientId = await resolveSecret('YOUTUBE_OAUTH_CLIENT_ID', { logTag: '[youtube-oauth]' });
  }
  if (!clientSecret) {
    clientSecret = await resolveSecret('YOUTUBE_OAUTH_CLIENT_SECRET', { logTag: '[youtube-oauth]' });
  }
  if (!refreshToken) {
    refreshToken = await resolveSecret('YOUTUBE_OAUTH_REFRESH_TOKEN', { logTag: '[youtube-oauth]' });
  }

  // Use provided fetchImpl or globalThis.fetch
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  // Build URL-encoded body
  const body = new URLSearchParams();
  body.append('grant_type', 'refresh_token');
  body.append('client_id', clientId);
  body.append('client_secret', clientSecret);
  body.append('refresh_token', refreshToken);

  // Make token request
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `YouTube OAuth token request failed: ${response.status} ${response.statusText} - ${text}`
    );
  }

  const data = await response.json();
  cachedAccessToken = data.access_token;

  return cachedAccessToken;
}

/**
 * Resets the cached token (test-only).
 */
export function _resetTokenCache() {
  cachedAccessToken = null;
}

/**
 * Fetches video snippet from YouTube API.
 * Gets the channelId, title, and description for a video.
 *
 * @param {string} videoId - YouTube video ID
 * @param {Object} deps - Optional dependencies for testing
 * @param {string} deps.apiKey - YouTube API key (defaults to credstore YOUTUBE_API_KEY)
 * @param {Function} deps.fetchImpl - Fetch implementation (defaults to globalThis.fetch)
 * @returns {Promise<{channelId: string, title: string, description: string} | null>}
 *          Returns snippet object or null if video not found
 */
export async function getVideoSnippet(videoId, deps = {}) {
  let apiKey = deps.apiKey;

  if (!apiKey) {
    apiKey = await resolveSecret('YOUTUBE_API_KEY', { logTag: '[youtube-oauth]' });
  }

  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;

  const response = await fetchImpl(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`YouTube videos API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();

  // Return null if no items found
  if (!data.items || data.items.length === 0) {
    return null;
  }

  const snippet = data.items[0].snippet;

  return {
    channelId: snippet.channelId,
    title: snippet.title,
    description: snippet.description || '',
  };
}

/**
 * Checks if a channel ID is the SAP Developers channel.
 *
 * @param {string} channelId - Channel ID to check
 * @returns {boolean} True if the channel is the SAP Developers channel
 */
export function isSapDevelopersChannel(channelId) {
  const sapDevChannelId = process.env.SAP_DEV_CHANNEL_ID || 'UCNfmelKDrvRmjYwSi9yvrMg';
  return channelId === sapDevChannelId;
}

/**
 * Lists available captions for a video.
 *
 * @param {string} videoId - YouTube video ID
 * @param {string} accessToken - OAuth access token
 * @param {Object} deps - Optional dependencies for testing
 * @param {Function} deps.fetchImpl - Fetch implementation (defaults to globalThis.fetch)
 * @returns {Promise<Array<{id, language, trackKind}>>} Array of caption track objects
 * @throws On non-ok response
 */
export async function listCaptions(videoId, accessToken, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  const url = `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}`;

  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `YouTube captions API request failed: ${response.status} ${response.statusText} - ${text}`
    );
  }

  const data = await response.json();

  if (!data.items || data.items.length === 0) {
    return [];
  }

  return data.items.map((item) => ({
    id: item.id,
    language: item.snippet.language,
    trackKind: item.snippet.trackKind,
  }));
}

/**
 * Picks the best caption track from a list.
 * Language-first across both kinds: prefers en, then en-*, then first.
 *
 * @param {Array<{language, trackKind, ...}>} tracks - Caption track objects
 * @returns {Object|null} The chosen track or null if no tracks available
 */
export function pickCaptionTrack(tracks) {
  if (!tracks || tracks.length === 0) {
    return null;
  }

  // First, look for exact language === 'en'
  const exactEn = tracks.find((t) => t.language === 'en');
  if (exactEn) {
    return exactEn;
  }

  // Second, look for language starting with 'en-'
  const enVariant = tracks.find((t) => t.language.startsWith('en-'));
  if (enVariant) {
    return enVariant;
  }

  // Fall back to first track
  return tracks[0];
}

/**
 * Downloads a caption track in SBV format.
 *
 * @param {string} captionId - Caption ID
 * @param {string} accessToken - OAuth access token
 * @param {Object} deps - Optional dependencies for testing
 * @param {Function} deps.fetchImpl - Fetch implementation (defaults to globalThis.fetch)
 * @returns {Promise<string>} SBV-formatted text
 * @throws On non-ok response
 */
export async function downloadCaption(captionId, accessToken, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  const url = `https://www.googleapis.com/youtube/v3/captions/${captionId}?tfmt=sbv`;

  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `YouTube caption download failed: ${response.status} ${response.statusText} - ${text}`
    );
  }

  return response.text();
}

/**
 * Parses SBV (SubViewer) caption format.
 * SBV blocks are separated by blank lines; each block starts with a timestamp line (H:MM:SS.mmm,H:MM:SS.mmm)
 * followed by text lines. Converts first timestamp to seconds and joins multi-line text with spaces.
 *
 * @param {string} text - SBV-formatted text
 * @returns {Array<{start:number, text:string}>} Parsed caption entries
 */
export function parseSbv(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const result = [];
  // Split by double newlines to get blocks
  const blocks = text.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length === 0) continue;

    // First line should be timestamp
    const firstLine = lines[0];
    const timestampMatch = firstLine.match(/^(\d+):(\d+):(\d+)\.(\d+),/);

    if (!timestampMatch) {
      // No valid timestamp, skip this block
      continue;
    }

    const hours = parseInt(timestampMatch[1], 10);
    const minutes = parseInt(timestampMatch[2], 10);
    const seconds = parseInt(timestampMatch[3], 10);
    const millis = timestampMatch[4];

    // Build start time: hours*3600 + minutes*60 + seconds + milliseconds as decimal
    const start = parseFloat(`${hours * 3600 + minutes * 60 + seconds}.${millis}`);

    // Text lines are everything after the first line
    const textLines = lines.slice(1);
    const text = textLines.join(' ');

    result.push({ start, text });
  }

  return result;
}

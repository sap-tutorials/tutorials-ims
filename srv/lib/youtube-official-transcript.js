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

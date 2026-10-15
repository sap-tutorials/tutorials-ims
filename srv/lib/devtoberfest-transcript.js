// srv/lib/devtoberfest-transcript.js
// Fetch + parse YouTube captions. Uploaded preferred, auto (asr) fallback.
//
// Track discovery uses YouTube's InnerTube `player` API with the ANDROID_VR
// client. The legacy `timedtext?type=list` endpoint was gutted by YouTube
// (returns HTTP 200 with an empty body — see issue #1485), and the WEB player
// now requires a proof-of-origin (PO) token to fetch caption content. The
// ANDROID_VR client needs neither a PO token nor a JS player, so it is the one
// InnerTube client that still returns usable `captionTracks[]` + fetchable
// `baseUrl`s from a plain server egress (verified against yt-dlp's behaviour).
//
// The whole strategy stays behind this one module so it can be swapped again
// without touching the route/table/UI. Uses native fetch.

// ANDROID_VR InnerTube client (mirrors yt-dlp's config). No PO token / JS player.
const IT_CLIENT_VERSION = '1.65.10';
const IT_CLIENT_NAME_ID = '28';
const IT_USER_AGENT =
  'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
const IT_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const IT_VISITOR_URL = 'https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false';

// Build the ANDROID_VR client context. A `visitorData` session id is required
// for many videos (SAP/Devtoberfest talks + livestreams return playability
// LOGIN_REQUIRED without one); it is bootstrapped once per fetch via the
// visitor_id endpoint. Matches the shape yt-dlp sends.
function itClient(visitorData) {
  return {
    clientName: 'ANDROID_VR',
    clientVersion: IT_CLIENT_VERSION,
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    androidSdkVersion: 32,
    userAgent: IT_USER_AGENT,
    osName: 'Android',
    osVersion: '12L',
    hl: 'en',
    timeZone: 'UTC',
    utcOffsetMinutes: 0,
    ...(visitorData ? { visitorData } : {}),
  };
}

function itHeaders(visitorData) {
  return {
    'content-type': 'application/json',
    'user-agent': IT_USER_AGENT,
    'x-youtube-client-name': IT_CLIENT_NAME_ID,
    'x-youtube-client-version': IT_CLIENT_VERSION,
    origin: 'https://www.youtube.com',
    ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
  };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// Strip inner markup (e.g. asr word-level <s> spans), decode entities, trim.
function cleanText(inner) {
  return decodeEntities(String(inner).replace(/<[^>]+>/g, '')).trim();
}

// Parses both caption formats into normalized [{ start (seconds), text }]:
//   - modern srv3:  <p t="MS" d="MS">...<s>word</s>...</p>   (t is milliseconds)
//   - legacy list:  <text start="SEC" dur="SEC">...</text>   (start is seconds)
function parseTimedText(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];

  // Modern srv3 <p t=".."> — milliseconds. Word timings live in nested <s>.
  // A cue may omit t when its start is 0 (`<p d="..">`); treat missing as 0.
  const pre = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pre.exec(xml))) {
    const attrs = m[1];
    // Only treat as srv3 when the <p> carries a timing attribute (t or d);
    // a bare <p> in some other markup must not be misread as a cue.
    const tm = /\bt="(\d+)"/.exec(attrs);
    const dm = /\bd="(\d+)"/.exec(attrs);
    if (!tm && !dm) continue;
    const text = cleanText(m[2]);
    if (text) out.push({ start: (tm ? parseInt(tm[1], 10) : 0) / 1000, text });
  }
  if (out.length) return out;

  // Legacy timedtext <text start=".."> — seconds.
  const tre = /<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = tre.exec(xml))) {
    const text = cleanText(m[2]);
    if (text) out.push({ start: parseFloat(m[1]), text });
  }
  return out;
}

// Pick a caption track from the InnerTube list. Preference order:
//   1. a track whose language is in `preferLangs` (exact match, e.g. 'en'),
//   2. a track whose language starts with a preferred prefix (e.g. 'en-GB'),
//   3. an uploaded (non-asr) track when `preferUploaded`,
//   4. the first track.
// #2345: YouTube returns ~20 auto-translated asr tracks for SAP/DevRel talks and
// the English one is rarely first; without a language preference we fed the LLM a
// machine translation (Arabic/Bengali). `preferLangs` defaults to English because
// these are English-spoken talks, but a non-English-only video still falls through
// to the uploaded/first-track behaviour, so no language is ever hard-required.
function pickCaptionTrack(list, { preferUploaded = true, preferLangs = ['en'] } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  const langOf = (t) => (t.lang || '').toLowerCase();
  const wanted = preferLangs.map((l) => l.toLowerCase());
  if (wanted.length) {
    const exact = list.find((t) => wanted.includes(langOf(t)));
    if (exact) return exact;
    const prefixed = list.find((t) => wanted.some((l) => langOf(t).startsWith(`${l}-`)));
    if (prefixed) return prefixed;
  }
  if (preferUploaded) {
    const uploaded = list.find((t) => t.kind !== 'asr');
    if (uploaded) return uploaded;
  }
  return list[0];
}

// Pure: map an InnerTube player response to [{ url, kind, lang }].
function extractCaptionTracks(playerJson) {
  const arr = playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((t) => t && t.baseUrl)
    .map((t) => ({ url: t.baseUrl, kind: t.kind || '', lang: t.languageCode || '' }));
}

// Bootstrap a visitorData session id (lifts LOGIN_REQUIRED on gated videos).
// Returns null on any failure — the player call still works for many videos.
async function fetchVisitorData() {
  try {
    const res = await fetch(IT_VISITOR_URL, {
      method: 'POST',
      headers: itHeaders(),
      body: JSON.stringify({ context: { client: itClient() } }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.responseContext?.visitorData || null;
  } catch {
    return null;
  }
}

// Call the ANDROID_VR InnerTube player API and return its parsed JSON (or null).
async function fetchPlayerResponse(videoId, visitorData) {
  try {
    const res = await fetch(IT_PLAYER_URL, {
      method: 'POST',
      headers: itHeaders(visitorData),
      body: JSON.stringify({
        videoId,
        context: { client: itClient(visitorData) },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Network throw, DNS, non-JSON body — fail soft; caller treats as no tracks.
    return null;
  }
}

// Returns [{ url, kind, lang }] for the video, via the modern player API.
async function listCaptionTracks(videoId) {
  const visitorData = await fetchVisitorData();
  const player = await fetchPlayerResponse(videoId, visitorData);
  return extractCaptionTracks(player);
}

// Fetch one track's caption content and return normalized segments ([] on fail).
async function fetchTrackSegments(track) {
  try {
    // baseUrl already carries `?v=...`; request the srv3 timed-text format.
    const res = await fetch(`${track.url}&fmt=srv3`, { headers: { 'user-agent': IT_USER_AGENT } });
    if (!res.ok) return [];
    return parseTimedText(await res.text());
  } catch {
    return [];
  }
}

async function fetchTranscript(videoId) {
  const tracks = await listCaptionTracks(videoId);
  if (!tracks.length) return { source: 'none', lang: '', segments: [] };

  // Build an ordered, de-duplicated candidate list. Within both the uploaded and
  // the auto (asr) pools we prefer an English track (#2345) before falling back
  // to the first available track, so a multi-language auto-translated list no
  // longer hands the LLM a machine translation. Uploaded is tried before auto
  // because livestreams often only have auto captions.
  const uploadedPool = tracks.filter((t) => t.kind !== 'asr');
  const autoPool = tracks.filter((t) => t.kind === 'asr');
  const candidates = [];
  const add = (t) => { if (t && !candidates.includes(t)) candidates.push(t); };
  add(pickCaptionTrack(uploadedPool, { preferUploaded: false }));
  add(pickCaptionTrack(autoPool, { preferUploaded: false }));
  // Last-resort: anything we have not already queued (non-English uploaded/auto).
  for (const t of tracks) add(t);

  for (const track of candidates) {
    const segments = await fetchTrackSegments(track);
    if (segments.length) {
      return {
        source: track.kind === 'asr' ? 'auto' : 'uploaded',
        lang: track.lang || '',
        segments,
      };
    }
  }
  return { source: 'none', lang: '', segments: [] };
}

export {
  parseTimedText,
  pickCaptionTrack,
  extractCaptionTracks,
  listCaptionTracks,
  fetchTranscript,
};

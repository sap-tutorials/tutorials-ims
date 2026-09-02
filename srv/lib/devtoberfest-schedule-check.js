// srv/lib/devtoberfest-schedule-check.js
//
// Schedule-consistency check for Devtoberfest sessions (issue #2103).
//
// The planner's `Session.SCHEDULEDSTART` is the source of truth for when a
// session runs. The *actual* scheduled times on the external assets — the
// YouTube livestream and the community.sap.com event — are set separately by
// humans and can drift. This module reconciles them: for each session it reads
// the external start times and flags any that disagree with SCHEDULEDSTART.
//
// Two external legs are readable deterministically (verified against live data,
// issue #2103):
//   - YouTube:   videos?part=liveStreamingDetails → scheduledStartTime, keyed by
//                the video id parsed from Session.YOUTUBEURL. Needs YOUTUBE_API_KEY.
//   - community: the Khoros LiQL API (community.sap.com/api/2.0/search) exposes
//                occasion_data.start_time keyed by the message id in
//                Session.COMMUNITYEVENTURL.
//
// Zoom is intentionally NOT checked: the planner has no readable Zoom start time
// (ZOOMURL is a bare join link, CALENDARINVITE is empty across all rows, and
// ZOOMINVITEDETAILS is free-text notes — see the #2103 probe).
//
// Pure helpers (parsing + comparison + assembly) carry no cds/db/network access
// so they are trivially unit-testable; the two fetchers take an injectable
// `fetchImpl` seam. Everything fails soft — a leg we cannot read reports
// 'unknown', never a spurious 'drift'.

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const KHOROS_API = 'https://community.sap.com/api/2.0/search';
const YT_BATCH = 50;        // videos?id= accepts up to 50 comma-separated ids
const KHOROS_BATCH = 50;
const DEFAULT_TOLERANCE_MIN = 5;
const FETCH_TIMEOUT_MS = 8000;

// --- Pure parsers -----------------------------------------------------------

// Extract the 11-char YouTube video id from any of the URL shapes the planner
// stores: watch?v=ID, youtu.be/ID, /live/ID, /embed/ID, /shorts/ID. Returns the
// id or null (unparseable / not a YouTube URL).
export function extractYouTubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const s = url.trim();
  // watch?v=... (also catches &v= and generic v= query param)
  const q = /[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/.exec(s);
  if (q) return q[1];
  // youtu.be/ID , /live/ID , /embed/ID , /shorts/ID , /v/ID
  const p = /(?:youtu\.be\/|\/live\/|\/embed\/|\/shorts\/|\/v\/)([A-Za-z0-9_-]{11})(?:[?&#/]|$)/.exec(s);
  if (p) return p[1];
  return null;
}

// Extract the numeric Khoros message id from a community.sap.com event URL.
// Event pages end in `.../ev-p/<id>` (or occasionally a bare trailing numeric
// segment). Returns the id string or null.
export function extractCommunityMessageId(url) {
  if (!url || typeof url !== 'string') return null;
  const s = url.trim().split(/[?#]/)[0];
  const m = /(?:ev-p|td-p|m-p|bc-p)\/(\d+)\b/.exec(s);
  if (m) return m[1];
  const tail = /\/(\d{4,})\/?$/.exec(s);
  return tail ? tail[1] : null;
}

// --- Pure comparison --------------------------------------------------------

// Compare a planner time to an external time. Returns { status, deltaMinutes,
// externalStart }. Statuses:
//   'no-url'      — the session has no URL for this asset (not applicable)
//   'unknown'     — URL present but the external time could not be read
//   'no-planner'  — external time read, but SCHEDULEDSTART is missing
//   'ok'          — both known and within tolerance
//   'drift'       — both known and further apart than tolerance
// `hasUrl` distinguishes 'no-url' from 'unknown' (a present-but-unreadable URL).
export function classifyLeg(plannedStart, externalStart, { hasUrl = true, toleranceMinutes = DEFAULT_TOLERANCE_MIN } = {}) {
  if (!hasUrl) return { status: 'no-url', deltaMinutes: null, externalStart: null };
  const extMs = toMs(externalStart);
  if (extMs == null) return { status: 'unknown', deltaMinutes: null, externalStart: null };
  const plMs = toMs(plannedStart);
  if (plMs == null) return { status: 'no-planner', deltaMinutes: null, externalStart: isoOrNull(externalStart) };
  const deltaMinutes = Math.round((extMs - plMs) / 60000);
  const status = Math.abs(deltaMinutes) <= toleranceMinutes ? 'ok' : 'drift';
  return { status, deltaMinutes, externalStart: isoOrNull(externalStart) };
}

function toMs(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function isoOrNull(value) {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

// --- Pure assembly ----------------------------------------------------------

// Build the report from planner sessions plus already-fetched external time
// maps. Keeps zero I/O so the whole comparison is unit-testable.
//
//   sessions           : [{ ID, SESSIONCODE, TITLE, SCHEDULEDSTART, YOUTUBEURL, COMMUNITYEVENTURL }]
//   youtubeStartById   : Map<videoId, isoString|null>
//   communityStartById : Map<messageId, isoString|null>
//
// Returns { toleranceMinutes, sessions: [...rows], summary: {...counts} }.
export function assembleScheduleCheck({ sessions = [], youtubeStartById = new Map(), communityStartById = new Map(), toleranceMinutes = DEFAULT_TOLERANCE_MIN } = {}) {
  const rows = sessions.map((s) => {
    const planned = s.SCHEDULEDSTART ?? null;

    const ytId = extractYouTubeVideoId(s.YOUTUBEURL);
    const ytExternal = ytId ? (youtubeStartById.get(ytId) ?? null) : null;
    const youtube = {
      ...classifyLeg(planned, ytExternal, { hasUrl: !!s.YOUTUBEURL, toleranceMinutes }),
      videoId: ytId,
      url: s.YOUTUBEURL || null,
    };

    const commId = extractCommunityMessageId(s.COMMUNITYEVENTURL);
    const commExternal = commId ? (communityStartById.get(commId) ?? null) : null;
    const community = {
      ...classifyLeg(planned, commExternal, { hasUrl: !!s.COMMUNITYEVENTURL, toleranceMinutes }),
      messageId: commId,
      url: s.COMMUNITYEVENTURL || null,
    };

    const hasDrift = youtube.status === 'drift' || community.status === 'drift';
    return {
      id: s.ID,
      sessionCode: s.SESSIONCODE || null,
      title: s.TITLE || null,
      scheduledStart: isoOrNull(planned),
      hasDrift,
      youtube,
      community,
    };
  });

  const summary = {
    total: rows.length,
    withDrift: rows.filter((r) => r.hasDrift).length,
    youtube: countStatuses(rows.map((r) => r.youtube.status)),
    community: countStatuses(rows.map((r) => r.community.status)),
  };
  return { toleranceMinutes, sessions: rows, summary };
}

function countStatuses(statuses) {
  const out = { ok: 0, drift: 0, unknown: 0, 'no-url': 0, 'no-planner': 0 };
  for (const s of statuses) out[s] = (out[s] || 0) + 1;
  return out;
}

// --- Fetchers (I/O, injectable seam) ---------------------------------------

async function fetchJson(url, { fetchImpl, timeoutMs = FETCH_TIMEOUT_MS, headers } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Resolve YouTube livestream scheduled start times for the given video ids.
// Returns Map<videoId, isoString|null>. Every requested id is present in the
// map (null when the video has no live-streaming details, is private, or was
// not returned). Fails soft: an API/network error yields null for that batch.
export async function fetchYouTubeScheduledStarts(videoIds, { apiKey, fetchImpl, timeoutMs } = {}) {
  const ids = [...new Set((videoIds || []).filter(Boolean))];
  const map = new Map(ids.map((id) => [id, null]));
  if (!ids.length || !apiKey) return map;
  for (const batch of chunk(ids, YT_BATCH)) {
    const url = `${YT_API_BASE}/videos?part=liveStreamingDetails&id=${encodeURIComponent(batch.join(','))}&key=${encodeURIComponent(apiKey)}`;
    const json = await fetchJson(url, { fetchImpl, timeoutMs });
    for (const item of json?.items || []) {
      const start = item?.liveStreamingDetails?.scheduledStartTime || null;
      if (item?.id) map.set(item.id, start ? isoOrNull(start) : null);
    }
  }
  return map;
}

// Resolve community.sap.com event start times for the given Khoros message ids
// via the LiQL search API. Returns Map<messageId, isoString|null>. Fails soft.
export async function fetchCommunityStartTimes(messageIds, { fetchImpl, timeoutMs } = {}) {
  const ids = [...new Set((messageIds || []).filter(Boolean).map(String))];
  const map = new Map(ids.map((id) => [id, null]));
  if (!ids.length) return map;
  for (const batch of chunk(ids, KHOROS_BATCH)) {
    const inList = batch.map((id) => `'${id}'`).join(',');
    const liql = `SELECT id,occasion_data.start_time FROM messages WHERE id IN (${inList})`;
    const url = `${KHOROS_API}?q=${encodeURIComponent(liql)}`;
    const json = await fetchJson(url, {
      fetchImpl,
      timeoutMs,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; sap-tutorials/1.0)' },
    });
    if (json?.status !== 'success') continue;
    for (const item of json?.data?.items || []) {
      const start = item?.occasion_data?.start_time || null;
      if (item?.id != null) map.set(String(item.id), start ? isoOrNull(start) : null);
    }
  }
  return map;
}

// --- Orchestrator -----------------------------------------------------------

// Fetch both external legs for the given planner sessions and assemble the
// report. Pure-assembly + I/O split so the route stays thin.
export async function buildScheduleCheckReport(sessions, { apiKey, fetchImpl, toleranceMinutes = DEFAULT_TOLERANCE_MIN } = {}) {
  const videoIds = sessions.map((s) => extractYouTubeVideoId(s.YOUTUBEURL)).filter(Boolean);
  const messageIds = sessions.map((s) => extractCommunityMessageId(s.COMMUNITYEVENTURL)).filter(Boolean);
  const [youtubeStartById, communityStartById] = await Promise.all([
    fetchYouTubeScheduledStarts(videoIds, { apiKey, fetchImpl }),
    fetchCommunityStartTimes(messageIds, { fetchImpl }),
  ]);
  return assembleScheduleCheck({ sessions, youtubeStartById, communityStartById, toleranceMinutes });
}

export const _internals = { DEFAULT_TOLERANCE_MIN, YT_BATCH, KHOROS_BATCH };

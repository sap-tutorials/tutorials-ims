// srv/lib/teched/rainfocus-fetcher.js
//
// Fetches the SAP TechEd 2026 session catalog (Berlin + Virtual) from the
// RainFocus JSON API that backs the catalog SPA (issue #2312).
//
//   Endpoint : POST https://events.rainfocus.com/api/sessions
//   Auth     : rfapiprofileid + rfwidgetid request headers (per-venue), NO
//              cookie / bearer token required (proven live 2026-09-15).
//   Body     : application/x-www-form-urlencoded; charset=UTF-8 —
//              type=session&browserTimezone=Europe%2FBerlin&catalogDisplay=list
//              plus offset pagination from=<n>&size=<n>.
//   Response : { responseCode:"0", responseMessage:"Success",
//                totalSearchItems, sectionList:[{ total, from, size, items:[…] }] }
//              responseCode !== "0" (e.g. "Invalid API Profile") ⇒ failure.
//
// Speakers are EMBEDDED per session in `participants[]` (no separate speaker
// endpoint). Tracks come from `attributevalues[]` entries whose
// `attribute === "Track"`. See srv/lib/teched/README.md for the full contract.
//
// The per-venue profile/widget ids are static for the event lifetime but MAY
// rotate; they are configurable via env (RAINFOCUS_TE26_PROFILE/…_WIDGET,
// RAINFOCUS_TEV26_PROFILE/…_WIDGET) and default to the live 2026 values.
//
// Resilience: the outbound POST is routed through srv/lib/safe-fetch.js
// `safeFetch` (SSRF/private-IP guard + redirect handling + AbortSignal timeout,
// #895). Retry/backoff reuses srv/lib/img-cdn-retry.cjs (429+5xx retryable,
// equal-jitter exponential backoff, Retry-After parsing). A server-advised
// Retry-After is honored up to RETRY_AFTER_CAP_MS (60 s) — parseRetryAfterMs
// already caps its own parse at 300 s, and we cap tighter so a hostile value
// can't stall the cron, while still backing off meaningfully on a real
// throttle (NOT the ~2 s that backoffMs's internal cap would clamp it to).
// A streaming MAX_BODY_BYTES cap (below) guards against a hung/huge upstream —
// that part is TechEd-specific and kept local. `_fetch` is a swappable
// transport seam passed through to safeFetch's fetchImpl so tests inject
// fixtures. A venue that returns a non-"0" responseCode (or otherwise throws)
// fails SOFTLY via Promise.allSettled — the other venue still ingests. But if
// EVERY venue fails or returns 0 sessions, fetchAllTechEdSessions escalates:
// it THROWS a tagged (`code:'TECHED_TOTAL_FETCH_FAILURE'`) error instead of
// returning an empty result, so the cron marks the run FAILED and alerts rather
// than silently freezing /teched behind the stale content-hash delta gate.

import { safeFetch } from '../safe-fetch.js';
import { isRetryableStatus, backoffMs, parseRetryAfterMs } from '../img-cdn-retry.cjs';

const SESSIONS_URL = 'https://events.rainfocus.com/api/sessions';
const ALLOWED_HOSTS = new Set(['events.rainfocus.com']);
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_AFTER_CAP_MS = 60_000; // honor Retry-After up to 60 s (guard vs. hostile values)
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MiB hard cap per response
// RainFocus hard-caps a page at 50 items (size>50 is clamped server-side;
// omitting size defaults to 20). We request 50 and page by `from`, advancing
// `from` by the number of items ACTUALLY returned (not the requested size)
// until `from >= totalSearchItems`. Proven live 2026-09-15: this retrieves the
// full catalog (~297 Berlin + 49 Virtual). NB: hammering the endpoint with many
// rapid requests can trip a soft throttle that returns SHORT offset pages —
// either empty (handled by the empty-page break below) or a non-empty PARTIAL
// page (e.g. 20 items when 50 were requested). Advancing by items.length rather
// than PAGE_SIZE keeps the next offset aligned to the un-returned rows so a
// partial page never causes us to skip past sessions; the retry/backoff also
// spaces requests out.
const PAGE_SIZE = 50;
const PAGINATION_MAX = 10000; // RainFocus paginationMax — runaway-paging guard

// Live 2026 defaults (see the module header). BERLIN = te26, VIRTUAL = tev26.
const DEFAULT_TE26_PROFILE = 'e8GkmAN9xTm5w6ZMi76B5wL0V9uhHEl1';
const DEFAULT_TE26_WIDGET = 'WO1M8ZqF9INWQDVqfJueEsSg3eT4veku';
const DEFAULT_TEV26_PROFILE = 'KHfXyIUaP8kwISNUh32sNyjJAYKBXYYv';
const DEFAULT_TEV26_WIDGET = 'Zk0wC45uzrCrfscqh7YqpcF26iUuP9Rf';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a response body under a hard byte cap. Enforces the cap BEFORE
// buffering the whole payload: a Content-Length pre-check rejects oversized
// advertised bodies, and (on the real fetch path) the body stream is consumed
// incrementally and aborted the moment it crosses the cap — so a huge/hung
// upstream can't OOM us. Falls back to arrayBuffer/text for test fakes that
// don't expose a readable stream.
async function readCappedBody(res, label) {
  const clen = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(clen) && clen > MAX_BODY_BYTES) {
    throw new Error(`[${label}] Content-Length ${clen}B exceeds cap ${MAX_BODY_BYTES}B`);
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`[${label}] response body exceeds cap ${MAX_BODY_BYTES}B`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof res.arrayBuffer === 'function') {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) throw new Error(`[${label}] response body ${buf.byteLength}B exceeds cap ${MAX_BODY_BYTES}B`);
    return Buffer.from(buf).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error(`[${label}] response body exceeds cap ${MAX_BODY_BYTES}B`);
  return text;
}

// POST one RainFocus sessions page through safeFetch (SSRF guard + timeout).
// Retries transient failures (429/5xx/network) with jittered backoff; caps
// body size. Returns the parsed JSON body. Throws on a non-"0" responseCode so
// the caller can fail the venue softly. `fetchImpl` is the test transport seam
// passed through to safeFetch.
async function postSessions({ fetchImpl, profileId, widgetId, from, size, label, retries }) {
  const body = new URLSearchParams({
    type: 'session',
    browserTimezone: 'Europe/Berlin',
    catalogDisplay: 'list',
    from: String(from),
    size: String(size),
  });
  const fetchInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      rfapiprofileid: profileId ?? '',
      rfwidgetid: widgetId ?? '',
    },
    body: body.toString(),
  };
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    let res;
    try {
      res = await safeFetch(SESSIONS_URL, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        allowedHosts: ALLOWED_HOSTS,
        fetchInit,
        fetchImpl, // undefined in prod → safeFetch uses global fetch
      });
    } catch (err) {
      // SSRF/redirect verdicts are terminal — never retry, fail the venue.
      if (err?.code === 'SSRF_BLOCKED' || err?.code === 'TOO_MANY_REDIRECTS') throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) { await sleep(backoffMs(attempt)); continue; }
      break;
    }

    if (isRetryableStatus(res.status) && attempt < retries - 1) {
      const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
      // Honor a real Retry-After up to 60 s; else jittered exponential backoff.
      // (backoffMs would otherwise clamp Retry-After to its ~2 s internal cap.)
      const wait = retryAfterMs > 0 ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS) : backoffMs(attempt);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`[${label}] RainFocus returned ${res.status}`);

    const text = await readCappedBody(res, label);
    const json = JSON.parse(text);
    if (String(json?.responseCode ?? '') !== '0') {
      throw new Error(`[${label}] RainFocus error responseCode=${json?.responseCode}: ${json?.responseMessage ?? 'unknown'}`);
    }
    return json;
  }
  throw new Error(`[${label}] request failed after ${retries} attempts${lastError ? `: ${lastError.message}` : ''}`);
}

// Flatten sectionList[].items from a RainFocus sessions response.
function itemsOf(json) {
  const sections = Array.isArray(json?.sectionList) ? json.sectionList : [];
  const out = [];
  for (const s of sections) if (Array.isArray(s?.items)) out.push(...s.items);
  if (out.length === 0 && Array.isArray(json?.items)) out.push(...json.items);
  return out;
}

// Offset-paginate one venue: loop `from`, advancing by the number of items
// actually returned each page, until `from >= totalSearchItems` (or the
// empty/PAGINATION_MAX guards trip). Advancing by items.length (not the
// requested PAGE_SIZE) means a soft-throttled PARTIAL page never skips rows.
async function paginate({ fetchImpl, profileId, widgetId, label }) {
  const all = [];
  let from = 0;
  let total = Infinity;
  while (from < total && from < PAGINATION_MAX) {
    const json = await postSessions({
      fetchImpl, profileId, widgetId, from, size: PAGE_SIZE, label, retries: MAX_RETRIES,
    });
    const t = Number(json?.totalSearchItems);
    if (Number.isFinite(t)) total = t;
    const items = itemsOf(json);
    all.push(...items);
    if (items.length === 0) break; // defensive: upstream stopped returning rows
    from += items.length; // advance by ACTUAL count — a partial page must not skip un-returned offsets
  }
  return all;
}

// ── raw-item → normalized-lite parsers ──────────────────────────────────────
// RainFocus field names vary per deployment; read common aliases defensively.

function pick(obj, ...keys) {
  for (const k of keys) if (obj?.[k] != null && obj[k] !== '') return obj[k];
  return null;
}

function firstTime(item) {
  const times = Array.isArray(item?.times) ? item.times : [];
  return times[0] ?? {};
}

// RainFocus utc* timestamps come as "YYYY/MM/DD HH:MM:SS" and denote UTC.
// JS Date.parse() would treat that (slash, no zone) as LOCAL time, so we
// normalize it to an explicit "…TZ" ISO string. ISO inputs pass through.
function toIso(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function parseTrack(item, venue) {
  const attrs = Array.isArray(item?.attributevalues) ? item.attributevalues : [];
  // Only the "Track" facet maps to TechEdTracks (other facets exist:
  // "Products (offerings)", "Session level", "Subtrack", … — none of those are
  // a track). Prefer an exact `attribute === 'Track'`, else fall back to an
  // exact case-insensitive match on 'Track' (tolerates casing/whitespace only).
  // A substring test would wrongly match siblings like "Subtrack" or "Session
  // Track Level", so we do NOT guess — no exact Track facet ⇒ track stays unset.
  const trackAttr = attrs.find((a) => a?.attribute === 'Track')
    ?? attrs.find((a) => a?.attribute?.trim().toLowerCase() === 'track');
  const name = trackAttr?.value ?? (Array.isArray(item?.tracks) ? item.tracks[0] : null);
  if (!name) return null;
  // rf_attributevalue_id is the stable, cross-venue opaque id; fall back to the
  // code, then the (human) attributevalue_id, then a name-derived synthetic id.
  const sourceId = pick(trackAttr, 'rf_attributevalue_id', 'attributevalue_code', 'attributevalue_id', 'id')
    ?? `track:${name}`;
  return { sourceId: String(sourceId), name: String(name), venue, description: null };
}

function parseSpeakers(item) {
  const parts = Array.isArray(item?.participants) ? item.participants
    : Array.isArray(item?.speakers) ? item.speakers : [];
  const out = [];
  for (const sp of parts) {
    const sourceId = pick(sp, 'speakerId', 'id', 'participantId');
    if (!sourceId) continue; // no stable id — cannot dedup/link, skip
    const name = pick(sp, 'fullName', 'globalFullName', 'name')
      ?? ([pick(sp, 'firstName'), pick(sp, 'lastName')].filter(Boolean).join(' ').trim() || null);
    out.push({
      sourceId: String(sourceId),
      name,
      title: pick(sp, 'globalJobtitle', 'jobtitle', 'jobTitle', 'title'),
      company: pick(sp, 'companyName', 'globalCompany', 'company'),
      bio: pick(sp, 'bio', 'globalBio', 'biography'),
      photoUrl: pick(sp, 'photoURL', 'photoUrl', 'imageUrl'),
    });
  }
  return out;
}

function parseSession(item, venue) {
  const sourceId = pick(item, 'sessionID', 'sessionId', 'id', 'code');
  const title = pick(item, 'title', 'name');
  const sessionCode = pick(item, 'code', 'sessionCode');
  if (!sourceId || !title || !sessionCode) return null; // invalid row — drop
  const t = firstTime(item);
  const start = toIso(pick(t, 'utcStartTime', 'startTimestamp') ?? pick(item, 'utcStartTime'));
  const end = toIso(pick(t, 'utcEndTime', 'endTimestamp') ?? pick(item, 'utcEndTime'));
  const track = parseTrack(item, venue);
  const speakers = parseSpeakers(item);
  return {
    session: {
      sourceId: String(sourceId),
      venue,
      sessionCode: String(sessionCode),
      title: String(title),
      abstract: pick(item, 'abstract', 'description'),
      scheduledStart: start,
      scheduledEnd: end,
      room: pick(t, 'room', 'roomName') ?? pick(item, 'room'),
      youtubeUrl: pick(item, 'youtubeUrl', 'videoURL', 'videoUrl', 'webcastUrl'),
      url: pick(item, 'url', 'sessionUrl'),
      trackSourceId: track?.sourceId ?? null,
      speakerSourceIds: speakers.map((s) => s.sourceId),
    },
    track,
    speakers,
  };
}

/**
 * Parse a full venue payload (session items) into normalized-lite
 * session/speaker/track arrays. Speakers and tracks are embedded per session
 * and deduped by sourceId within the venue. `speakerItems` is accepted for
 * backward compatibility (a standalone speaker catalog is no longer fetched)
 * and is merged first if a caller supplies one.
 */
export function parseVenuePayload({ venue, sessionItems = [], speakerItems = [] }) {
  const sessions = [];
  const speakerById = new Map();
  const trackById = new Map();

  for (const raw of speakerItems) {
    const sid = pick(raw, 'speakerId', 'id', 'participantId');
    if (!sid) continue;
    const name = pick(raw, 'fullName', 'globalFullName', 'name')
      ?? ([pick(raw, 'firstName'), pick(raw, 'lastName')].filter(Boolean).join(' ').trim() || null);
    speakerById.set(String(sid), {
      sourceId: String(sid),
      name,
      title: pick(raw, 'globalJobtitle', 'jobtitle', 'jobTitle', 'title'),
      company: pick(raw, 'companyName', 'globalCompany', 'company'),
      bio: pick(raw, 'bio', 'globalBio', 'biography'),
      photoUrl: pick(raw, 'photoURL', 'photoUrl', 'imageUrl'),
    });
  }

  for (const item of sessionItems) {
    const parsed = parseSession(item, venue);
    if (!parsed) continue;
    sessions.push(parsed.session);
    if (parsed.track && !trackById.has(parsed.track.sourceId)) trackById.set(parsed.track.sourceId, parsed.track);
    // speakers embedded on the session are the source of truth
    for (const sp of parsed.speakers) if (!speakerById.has(sp.sourceId)) speakerById.set(sp.sourceId, sp);
  }

  return { sessions, speakers: [...speakerById.values()], tracks: [...trackById.values()] };
}

// Resolve the per-venue { profileId, widgetId } config from opts.venues or env,
// defaulting to the live 2026 values.
function resolveVenues(opts) {
  if (opts.venues) return opts.venues;
  const env = opts.env ?? process.env;
  return {
    BERLIN: {
      profileId: env.RAINFOCUS_TE26_PROFILE || DEFAULT_TE26_PROFILE,
      widgetId: env.RAINFOCUS_TE26_WIDGET || DEFAULT_TE26_WIDGET,
    },
    VIRTUAL: {
      profileId: env.RAINFOCUS_TEV26_PROFILE || DEFAULT_TEV26_PROFILE,
      widgetId: env.RAINFOCUS_TEV26_WIDGET || DEFAULT_TEV26_WIDGET,
    },
  };
}

/**
 * Fetch + parse the TechEd catalog for BOTH venues.
 *
 * @param {object}   opts
 * @param {Function} [opts._fetch]  fetch seam (default globalThis.fetch)
 * @param {object}   [opts.venues]  { BERLIN:{profileId,widgetId}, VIRTUAL:{…} }
 * @param {object}   opts
 * @param {Function} [opts._fetch]  transport seam passed to safeFetch's fetchImpl
 *                                  (default: safeFetch uses global fetch)
 * @param {object}   [opts.venues]  { BERLIN:{profileId,widgetId}, VIRTUAL:{…} }
 * @param {object}   [opts.env]     env source for the default ids (default process.env)
 * @param {number}   [opts.now]     epoch ms used for past-session filtering
 * @param {boolean}  [opts.dropPast=true] drop sessions whose scheduledEnd is in the past
 * @returns {Promise<{sessions:Array, speakers:Array, tracks:Array}>}
 */
export async function fetchAllTechEdSessions(opts = {}) {
  const fetchImpl = opts._fetch; // undefined in prod → safeFetch uses global fetch
  const now = opts.now ?? Date.now();
  const dropPast = opts.dropPast !== false;
  const venues = resolveVenues(opts);

  const settled = await Promise.allSettled(
    Object.entries(venues).map(async ([venue, cfg]) => {
      const sessionItems = await paginate({
        fetchImpl, profileId: cfg.profileId, widgetId: cfg.widgetId, label: `${venue}/session`,
      });
      return parseVenuePayload({ venue, sessionItems });
    }),
  );

  // Merge venues; dedup by sourceId (first-writer-wins). Track per-venue
  // outcomes so a TOTAL failure (every venue rejected or returned 0 sessions)
  // can be escalated LOUDLY below — a SINGLE venue failing still succeeds
  // SOFTLY (partial ingest), preserving the existing allSettled semantics.
  const venueNames = Object.keys(venues);
  const sessions = new Map();
  const speakers = new Map();
  const tracks = new Map();
  let venuesWithSessions = 0;
  const venueFailures = [];
  for (const [i, r] of settled.entries()) {
    const venue = venueNames[i] ?? `venue#${i}`;
    if (r.status !== 'fulfilled') {
      venueFailures.push(`${venue}: ${r.reason?.message ?? r.reason}`);
      console.warn('[teched-fetcher] venue failed:', r.reason?.message ?? r.reason);
      continue;
    }
    if (r.value.sessions.length === 0) {
      venueFailures.push(`${venue}: returned 0 sessions`);
      continue;
    }
    venuesWithSessions++;
    for (const s of r.value.sessions) if (!sessions.has(s.sourceId)) sessions.set(s.sourceId, s);
    for (const sp of r.value.speakers) if (!speakers.has(sp.sourceId)) speakers.set(sp.sourceId, sp);
    for (const t of r.value.tracks) if (!tracks.has(t.sourceId)) tracks.set(t.sourceId, t);
  }

  // TOTAL failure escalation: NO venue produced any sessions (all venues either
  // rejected or returned 0). Throw LOUD instead of returning an empty result —
  // otherwise the weekly cron ingests nothing, the content-hash/lastSeen delta
  // gate carries stale rows forward, and /teched silently freezes for weeks
  // until a human notices. The most likely root cause is rotated/stale
  // RainFocus profile/widget IDs; override them via the RAINFOCUS_TE26_PROFILE /
  // RAINFOCUS_TE26_WIDGET and RAINFOCUS_TEV26_PROFILE / RAINFOCUS_TEV26_WIDGET
  // env vars. (Sourcing these IDs from ImsConfig/credstore would further reduce
  // the rotation risk — a deliberate follow-up, intentionally NOT done here.)
  // The tagged `err.code` lets the cron job re-throw this past its fail-open
  // catches so the scheduler records the run FAILED and fires alerting.raise.
  // Detection is on the per-venue FETCH outcome, NOT the post-dropPast list, so
  // an event that is simply over (the API still returns PAST sessions, later
  // emptied by dropPast) stays a legitimate empty result rather than a hard
  // failure. NB: once TechEd 2026 is over and RainFocus empties/decommissions
  // the catalog outright (0 raw items), this guard WILL fire every run — retire
  // or flag-gate the weekly job post-event so it stops raising recurring alerts.
  if (venuesWithSessions === 0) {
    const err = new Error(
      `[teched-fetcher] TOTAL fetch failure — all ${settled.length} venue(s) failed or returned 0 sessions ` +
        `[${venueFailures.join('; ')}]. Likely rotated/stale RainFocus profile/widget IDs; override via ` +
        `RAINFOCUS_TE26_PROFILE/RAINFOCUS_TE26_WIDGET and RAINFOCUS_TEV26_PROFILE/RAINFOCUS_TEV26_WIDGET.`,
    );
    err.code = 'TECHED_TOTAL_FETCH_FAILURE';
    throw err;
  }

  let sessionList = [...sessions.values()];
  if (dropPast) {
    sessionList = sessionList.filter((s) => {
      if (!s.scheduledEnd) return true; // keep undated — can't prove it's past
      const end = Date.parse(s.scheduledEnd);
      return !Number.isFinite(end) || end >= now;
    });
  }

  return { sessions: sessionList, speakers: [...speakers.values()], tracks: [...tracks.values()] };
}

export default { fetchAllTechEdSessions, parseVenuePayload };

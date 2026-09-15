// srv/lib/teched/rainfocus-fetcher.js
//
// Fetches the SAP TechEd 2026 session + speaker catalog from the RainFocus
// JSON search API that backs the catalog SPA (issue #2312, Unit F).
//
//   Endpoint : POST https://events.rainfocus.com/api/search
//   Auth     : rfWidgetId + rfApiProfileId request headers (per-venue)
//   Body     : application/x-www-form-urlencoded — type=session|speaker,
//              size, from (offset pagination)
//   Response : { responseCode, responseMessage, sectionList:[{ items:[…] }] }
//
// Contract confirmed live (see srv/lib/teched/README.md). The per-venue
// widget/apiProfile IDs are Akamai-gated in the catalog page JS; supply them
// via opts.venues or env. Berlin flow = `te26`, Virtual flow = `tev26`.
//
// Resilience mirrors scripts/parsers/github.ts `fetchWithRetry`: exponential
// backoff + jitter, retry on 5xx/429/network, honor Retry-After, fail fast on
// other 4xx. AbortController timeout + MAX_BODY_BYTES cap guard against a
// hung/huge upstream. `_fetch` is a swappable seam so tests inject fixtures.

const SEARCH_URL = 'https://events.rainfocus.com/api/search';
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MiB hard cap per response
const PAGE_SIZE = 50;
const MAX_PAGES = 60; // 3000 rows/venue ceiling — defends against runaway paging

const DEFAULT_VENUES = {
  VIRTUAL: { flow: 'tev26' },
  BERLIN: { flow: 'te26' },
};

function backoffDelay(attempt) {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return exp / 2 + Math.random() * (exp / 2); // full-ish jitter
}

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

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

// POST one RainFocus search page. Retries transient failures; caps body size;
// aborts on timeout. Returns the parsed JSON body.
async function postSearch({ fetchImpl, widgetId, apiProfileId, type, from, label, retries }) {
  const body = new URLSearchParams({ type, size: String(PAGE_SIZE), from: String(from) });
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          rfWidgetId: widgetId ?? '',
          rfApiProfileId: apiProfileId ?? '',
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      clearTimeout(timer);
      if (attempt < retries) { await sleep(backoffDelay(attempt)); continue; }
      break;
    }
    clearTimeout(timer);

    const retryable = res.status >= 500 || res.status === 429;
    if (retryable && attempt < retries) {
      const wait = parseRetryAfter(res.headers?.get?.('retry-after')) ?? backoffDelay(attempt);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`[${label}] RainFocus returned ${res.status}`);

    const text = await readCappedBody(res, label);
    const json = JSON.parse(text);
    if (json && json.responseCode && String(json.responseCode) !== '0') {
      throw new Error(`[${label}] RainFocus error ${json.responseCode}: ${json.responseMessage ?? 'unknown'}`);
    }
    return json;
  }
  throw new Error(`[${label}] request failed after ${retries} attempts${lastError ? `: ${lastError.message}` : ''}`);
}

// Flatten sectionList[].items from a RainFocus search response.
function itemsOf(json) {
  const sections = Array.isArray(json?.sectionList) ? json.sectionList : [];
  const out = [];
  for (const s of sections) if (Array.isArray(s?.items)) out.push(...s.items);
  // Some deployments also return a flat `items` array.
  if (out.length === 0 && Array.isArray(json?.items)) out.push(...json.items);
  return out;
}

async function paginate({ fetchImpl, widgetId, apiProfileId, type, label }) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await postSearch({
      fetchImpl, widgetId, apiProfileId, type, from: page * PAGE_SIZE, label, retries: MAX_RETRIES,
    });
    const items = itemsOf(json);
    all.push(...items);
    if (items.length < PAGE_SIZE) break; // last page
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

function toIso(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function parseTrack(item, venue) {
  // Prefer an explicit track attribute; fall back to tracks[]/trackIds[].
  const attrs = Array.isArray(item?.attributevalues) ? item.attributevalues : [];
  const trackAttr = attrs.find((a) => /track/i.test(a?.attribute ?? ''));
  const name = trackAttr?.value ?? (Array.isArray(item?.tracks) ? item.tracks[0] : null);
  if (!name) return null;
  const sourceId = trackAttr?.id ?? (Array.isArray(item?.trackIds) ? item.trackIds[0] : null) ?? `track:${name}`;
  return { sourceId: String(sourceId), name: String(name), venue, description: null };
}

function parseSpeakers(item) {
  const parts = Array.isArray(item?.participants) ? item.participants
    : Array.isArray(item?.speakers) ? item.speakers : [];
  const out = [];
  for (const sp of parts) {
    const sourceId = pick(sp, 'speakerId', 'id', 'participantId');
    if (!sourceId) continue;
    const name = pick(sp, 'fullName', 'name')
      ?? ([pick(sp, 'firstName'), pick(sp, 'lastName')].filter(Boolean).join(' ').trim() || null);
    out.push({
      sourceId: String(sourceId),
      name,
      title: pick(sp, 'jobtitle', 'jobTitle', 'title'),
      company: pick(sp, 'companyName', 'company'),
      bio: pick(sp, 'bio', 'biography'),
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
  const start = toIso(pick(t, 'utcStartTime', 'startTimestamp', 'startTime') ?? pick(item, 'startTime'));
  const end = toIso(pick(t, 'utcEndTime', 'endTimestamp', 'endTime') ?? pick(item, 'endTime'));
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

// Parse a full venue payload (session items + optional standalone speaker items)
// into normalized-lite session/speaker/track arrays.
export function parseVenuePayload({ venue, sessionItems = [], speakerItems = [] }) {
  const sessions = [];
  const speakerById = new Map();
  const trackById = new Map();

  for (const raw of speakerItems) {
    const sid = pick(raw, 'speakerId', 'id', 'participantId');
    if (!sid) continue;
    const name = pick(raw, 'fullName', 'name')
      ?? ([pick(raw, 'firstName'), pick(raw, 'lastName')].filter(Boolean).join(' ').trim() || null);
    speakerById.set(String(sid), {
      sourceId: String(sid),
      name,
      title: pick(raw, 'jobtitle', 'jobTitle', 'title'),
      company: pick(raw, 'companyName', 'company'),
      bio: pick(raw, 'bio', 'biography'),
      photoUrl: pick(raw, 'photoURL', 'photoUrl', 'imageUrl'),
    });
  }

  for (const item of sessionItems) {
    const parsed = parseSession(item, venue);
    if (!parsed) continue;
    sessions.push(parsed.session);
    if (parsed.track && !trackById.has(parsed.track.sourceId)) trackById.set(parsed.track.sourceId, parsed.track);
    // speakers embedded on the session fill gaps the speaker catalog missed
    for (const sp of parsed.speakers) if (!speakerById.has(sp.sourceId)) speakerById.set(sp.sourceId, sp);
  }

  return { sessions, speakers: [...speakerById.values()], tracks: [...trackById.values()] };
}

/**
 * Fetch + parse the TechEd catalog for BOTH venues.
 *
 * @param {object}   opts
 * @param {Function} [opts._fetch]  fetch seam (default globalThis.fetch)
 * @param {object}   [opts.venues]  { VIRTUAL:{flow,widgetId,apiProfileId}, BERLIN:{…} }
 * @param {number}   [opts.now]     epoch ms used for past-session filtering
 * @param {boolean}  [opts.dropPast=true] drop sessions whose scheduledEnd is in the past
 * @returns {Promise<{sessions:Array, speakers:Array, tracks:Array}>}
 */
export async function fetchAllTechEdSessions(opts = {}) {
  const fetchImpl = opts._fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetchAllTechEdSessions: no fetch implementation available');
  const now = opts.now ?? Date.now();
  const dropPast = opts.dropPast !== false;
  const env = opts.env ?? process.env;

  const venues = opts.venues ?? {
    VIRTUAL: {
      ...DEFAULT_VENUES.VIRTUAL,
      widgetId: env.TECHED_RF_TEV26_WIDGET_ID,
      apiProfileId: env.TECHED_RF_TEV26_API_PROFILE,
    },
    BERLIN: {
      ...DEFAULT_VENUES.BERLIN,
      widgetId: env.TECHED_RF_TE26_WIDGET_ID,
      apiProfileId: env.TECHED_RF_TE26_API_PROFILE,
    },
  };

  const settled = await Promise.allSettled(
    Object.entries(venues).map(async ([venue, cfg]) => {
      const [sessionItems, speakerItems] = await Promise.all([
        paginate({ fetchImpl, widgetId: cfg.widgetId, apiProfileId: cfg.apiProfileId, type: 'session', label: `${venue}/session` }),
        paginate({ fetchImpl, widgetId: cfg.widgetId, apiProfileId: cfg.apiProfileId, type: 'speaker', label: `${venue}/speaker` }).catch(() => []),
      ]);
      return parseVenuePayload({ venue, sessionItems, speakerItems });
    }),
  );

  // Merge venues; dedup by sourceId (first-writer-wins).
  const sessions = new Map();
  const speakers = new Map();
  const tracks = new Map();
  for (const r of settled) {
    if (r.status !== 'fulfilled') { console.warn('[teched-fetcher] venue failed:', r.reason?.message ?? r.reason); continue; }
    for (const s of r.value.sessions) if (!sessions.has(s.sourceId)) sessions.set(s.sourceId, s);
    for (const sp of r.value.speakers) if (!speakers.has(sp.sourceId)) speakers.set(sp.sourceId, sp);
    for (const t of r.value.tracks) if (!tracks.has(t.sourceId)) tracks.set(t.sourceId, t);
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

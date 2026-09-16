// srv/lib/teched-feed.js
//
// Loader for the public SAP TechEd session feed (issue #2312), factored out of
// the GET /build/teched handler in srv/server.js so it can be reused server-side
// (e.g. attaching a speaker's sessions to /api/advocates/:slug — issue #2354)
// without an HTTP round-trip. The returned shape is IDENTICAL to /build/teched's
// body minus `buildAt` (the route adds cache headers + buildAt around this).
//
// LOB rule (CLAUDE.md): `abstract`/`bio`/`description` are LargeString (NCLOB on
// HANA). We NEVER select a LOB alongside metadata in one query — each LOB is
// fetched in its own key+LOB-only pass (fetchLobColumnByIds) so locators cannot
// expire mid-map. The passes move here verbatim with the query.

import cds from '@sap/cds';
import { computeRelatedDevtoberfestByTechEd } from './teched-devtoberfest-crosslink.js';

const { SELECT } = cds.ql;
const NS = 'com.sap.developers.ims.external';

// The real catalog is ~300 sessions/venue; 1000 sits well above that (nothing
// dropped) but bounds the sessions query + its derived abstract LOB pass.
const MAX_SESSIONS = 1000;

// Batched key+LOB-only fetch, keyed by ID. LOB-safe by design (selects ONLY the
// key + the LOB column). Skips empty input (avoids a degenerate `IN ()`).
async function fetchLobColumnByIds(db, entity, lobColumn, ids) {
  const byId = new Map();
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    if (!chunk.length) continue;
    const rows = await db.run(
      SELECT.from(entity).columns('ID', lobColumn).where({ ID: { in: chunk } }),
    );
    for (const r of rows) byId.set(r.ID, r[lobColumn]);
  }
  return byId;
}

/**
 * Load the TechEd feed as { sessions, speakers, tracks }.
 * @param db a connected `cds.connect.to('db')` handle
 * @param opts.venue    optional 'BERLIN' | 'VIRTUAL' — narrows to one venue
 * @param opts.upcoming optional true — drops sessions that have already ended
 *
 * EXPLICIT public projection — never spreads the full row (drops sourceId,
 * contentHash, lastExtractedHash, firstSeenAt/lastSeenAt/pinUntil, audit fields).
 */
export async function loadTechEdFeed(db, opts = {}) {
  const sessionWhere = {};
  const venue = String(opts.venue || '').trim().toUpperCase();
  if (venue === 'BERLIN' || venue === 'VIRTUAL') sessionWhere.venue = venue;
  if (opts.upcoming === true) {
    sessionWhere.scheduledEnd = { '>=': new Date().toISOString() };
  }

  let sessionQuery = SELECT.from(`${NS}.TechEdSessions`)
    .columns('ID', 'slug', 'venue', 'sessionCode', 'title', 'scheduledStart', 'scheduledEnd', 'room', 'youtubeUrl', 'url', 'track_ID');
  if (Object.keys(sessionWhere).length) sessionQuery = sessionQuery.where(sessionWhere);
  sessionQuery = sessionQuery.orderBy('scheduledStart', 'sessionCode').limit(MAX_SESSIONS);
  const sessionRows = await db.run(sessionQuery);

  // Dedicated LOB-only passes (see file header). The abstract pass is scoped to
  // the emitted (bounded) sessions; track/speaker LOB passes match their full
  // metadata fetch so no referenced row loses its text.
  const abstractById = await fetchLobColumnByIds(
    db, `${NS}.TechEdSessions`, 'abstract', sessionRows.map((r) => r.ID),
  );
  const trackRows = await db.run(
    SELECT.from(`${NS}.TechEdTracks`).columns('ID', 'slug', 'name', 'venue'),
  );
  const trackDescById = await fetchLobColumnByIds(
    db, `${NS}.TechEdTracks`, 'description', trackRows.map((t) => t.ID),
  );
  const speakerRows = await db.run(
    SELECT.from(`${NS}.TechEdSpeakers`).columns('ID', 'slug', 'name', 'title', 'company', 'photoUrl'),
  );
  const speakerBioById = await fetchLobColumnByIds(
    db, `${NS}.TechEdSpeakers`, 'bio', speakerRows.map((s) => s.ID),
  );

  // Only the junction rows for the emitted sessions are consumed below — scope
  // + batch the IN list (bounded & correct when venue/upcoming-filtered).
  const sessionIds = sessionRows.map((r) => r.ID);
  const linkRows = [];
  const LINK_BATCH = 500;
  for (let i = 0; i < sessionIds.length; i += LINK_BATCH) {
    const chunk = sessionIds.slice(i, i + LINK_BATCH);
    if (!chunk.length) continue;
    const batch = await db.run(
      SELECT.from(`${NS}.TechEdSessionSpeakers`).columns('session_ID', 'speaker_ID').where({ session_ID: { in: chunk } }),
    );
    for (const l of batch) linkRows.push(l);
  }

  const trackSlugById = new Map(trackRows.map((t) => [t.ID, t.slug]));
  const speakerSlugById = new Map(speakerRows.map((s) => [s.ID, s.slug]));
  const speakerSlugsBySession = new Map();
  for (const l of linkRows) {
    const slug = speakerSlugById.get(l.speaker_ID);
    if (!slug) continue;
    if (!speakerSlugsBySession.has(l.session_ID)) speakerSlugsBySession.set(l.session_ID, []);
    speakerSlugsBySession.get(l.session_ID).push(slug);
  }

  // TechEd → Devtoberfest related-session cross-links (issue #2312). Flag-gated
  // + fail-open inside the helper — never blanks the feed.
  let relatedDtfByTechEd = new Map();
  try {
    relatedDtfByTechEd = await computeRelatedDevtoberfestByTechEd();
  } catch (e) {
    console.warn('[teched-feed] cross-link skipped:', e.message);
    relatedDtfByTechEd = new Map();
  }

  const sessions = sessionRows.map((r) => ({
    slug: r.slug,
    venue: r.venue,
    sessionCode: r.sessionCode,
    title: r.title,
    abstract: abstractById.get(r.ID) ?? null,
    scheduledStart: r.scheduledStart,
    scheduledEnd: r.scheduledEnd,
    room: r.room,
    youtubeUrl: r.youtubeUrl,
    url: r.url,
    track: r.track_ID ? trackSlugById.get(r.track_ID) ?? null : null,
    speakers: (speakerSlugsBySession.get(r.ID) ?? []).sort(),
    relatedDevtoberfestSessions: relatedDtfByTechEd.get(r.slug) ?? [],
  }));
  const speakers = speakerRows.map((s) => ({
    slug: s.slug, name: s.name, title: s.title, company: s.company, bio: speakerBioById.get(s.ID) ?? null, photoUrl: s.photoUrl,
  }));
  const tracks = trackRows.map((t) => ({
    slug: t.slug, name: t.name, venue: t.venue, description: trackDescById.get(t.ID) ?? null,
  }));

  return { sessions, speakers, tracks };
}

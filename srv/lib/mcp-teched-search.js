import cds from '@sap/cds';
import { clampLimit } from './mcp-arg-validators.js';

const LOG = cds.log('mcp-teched-search');

// Entities live under the external namespace (db/external/teched.cds).
const NS = 'com.sap.developers.ims.external';

// TechEdSessions.venue is @assert.range enum { BERLIN; VIRTUAL }.
const VALID_VENUES = new Set(['BERLIN', 'VIRTUAL']);

/**
 * Map a TechEdSessions row (+ merged side data) to the MCP `search_teched`
 * wire shape. `abstract`/`track`/`speakers` are resolved from separate
 * queries (LOB rule + associations), passed in via `ctx`.
 */
export function mapRow(r, ctx = {}) {
  const { abstractById, trackSlugById, speakerNamesBySession } = ctx;
  return {
    slug:           r.slug || '',
    title:          r.title || '',
    abstract:       (abstractById && abstractById.get(r.ID)) ?? null,
    venue:          r.venue || '',
    track:          r.track_ID ? ((trackSlugById && trackSlugById.get(r.track_ID)) ?? null) : null,
    scheduledStart: r.scheduledStart ?? null,
    room:           r.room ?? null,
    url:            r.url ?? null,
    speakers:       (speakerNamesBySession && speakerNamesBySession.get(r.ID)) ?? [],
  };
}

/**
 * MCP curated tool handler: search the public SAP TechEd 2026 session catalog.
 *
 * Anonymous surface — every caller-controlled input is validated/clamped, and
 * the whole thing fails open (returns []) so a DB hiccup never 500s an MCP
 * client. Modeled on mcp-events-search.js `handleSearchEvents`.
 *
 * The `abstract` LargeString (NCLOB on HANA) is NEVER referenced in a SQL
 * query alongside — or as a predicate on — metadata: LOB locators can expire,
 * and string-function/LIKE support over NCLOB is not something we rely on
 * (CLAUDE.md LOB rule; mirrors srv/server.js `/build/teched`). It is read in a
 * dedicated LOB-only query; the free-text `query` match (title + abstract) is
 * applied in JS against that result so it works identically on SQLite + HANA.
 */
export async function handleSearchTechEd(req) {
  const d = req.data ?? {};
  const query = typeof d.query === 'string' ? d.query.trim().toLowerCase() : '';
  const venue = typeof d.venue === 'string' ? d.venue.trim().toUpperCase() : '';
  const track = typeof d.track === 'string' ? d.track.trim() : '';
  const limit = clampLimit(d.limit, 20, 50);

  try {
    const db = cds.db;

    // Track metadata (small, no LOB) — used both to resolve the optional track
    // filter and to render `track` (slug) on each result row.
    const trackRows = await db.run(
      SELECT.from(`${NS}.TechEdTracks`).columns('ID', 'slug', 'name'),
    );
    const trackSlugById = new Map(trackRows.map((t) => [t.ID, t.slug]));

    let trackIds = null;
    if (track) {
      const t = track.toLowerCase();
      trackIds = trackRows
        .filter((r) => (r.slug || '').toLowerCase() === t || (r.name || '').toLowerCase().includes(t))
        .map((r) => r.ID);
      // A named-but-unknown track matches nothing — fail open with [].
      if (trackIds.length === 0) return [];
    }

    // `1 = 1` seed lets every subsequent predicate use `.and` uniformly, so the
    // "no filters at all" path still produces a valid WHERE. Works on SQLite + HANA.
    // NB: no LOB column here, and no abstract predicate — see the JS match below.
    let q = SELECT.from(`${NS}.TechEdSessions`)
      .columns('ID', 'slug', 'title', 'venue', 'track_ID', 'scheduledStart', 'room', 'url')
      .where`1 = 1`;

    if (venue && VALID_VENUES.has(venue)) {
      q = q.and`venue = ${venue}`;
    }
    if (trackIds) {
      q = q.and`track_ID in ${trackIds}`;
    }
    q = q.orderBy('scheduledStart asc');
    // When there's no free-text query the DB limit is exact; with a query we
    // must first pull the venue/track-filtered set, match title+abstract in JS,
    // then slice — so the SQL limit is deferred to after the JS filter.
    if (!query) q = q.limit(limit);

    const candidates = await db.run(q);
    if (!candidates || candidates.length === 0) return [];

    const candidateIds = candidates.map((r) => r.ID);

    // `abstract` (LargeString/NCLOB) — dedicated LOB-only query, merged by ID.
    // Needed both for the free-text match and the returned wire shape.
    const abstractRows = await db.run(
      SELECT.from(`${NS}.TechEdSessions`).columns('ID', 'abstract').where({ ID: { in: candidateIds } }),
    );
    const abstractById = new Map(abstractRows.map((r) => [r.ID, r.abstract]));

    // Free-text match (title + abstract), case-insensitive, applied in JS so the
    // NCLOB `abstract` is never used in a SQL predicate. Order (scheduledStart)
    // is preserved from the SQL orderBy; slice to the limit after filtering.
    let rows = candidates;
    if (query) {
      rows = candidates.filter((r) => {
        const title = (r.title || '').toLowerCase();
        const abstract = (abstractById.get(r.ID) || '').toLowerCase();
        return title.includes(query) || abstract.includes(query);
      }).slice(0, limit);
      if (rows.length === 0) return [];
    }

    const ids = rows.map((r) => r.ID);

    // Speakers via the session↔speaker junction; resolve to speaker names.
    const linkRows = await db.run(
      SELECT.from(`${NS}.TechEdSessionSpeakers`)
        .columns('session_ID', 'speaker_ID')
        .where({ session_ID: { in: ids } }),
    );
    const speakerNamesBySession = new Map();
    const speakerIds = [...new Set(linkRows.map((l) => l.speaker_ID).filter(Boolean))];
    if (speakerIds.length) {
      const speakerRows = await db.run(
        SELECT.from(`${NS}.TechEdSpeakers`).columns('ID', 'name').where({ ID: { in: speakerIds } }),
      );
      const speakerNameById = new Map(speakerRows.map((s) => [s.ID, s.name]));
      for (const l of linkRows) {
        const name = speakerNameById.get(l.speaker_ID);
        if (!name) continue;
        if (!speakerNamesBySession.has(l.session_ID)) speakerNamesBySession.set(l.session_ID, []);
        speakerNamesBySession.get(l.session_ID).push(name);
      }
      for (const arr of speakerNamesBySession.values()) arr.sort();
    }

    return rows.map((r) => mapRow(r, { abstractById, trackSlugById, speakerNamesBySession }));
  } catch (err) {
    LOG.warn('search_teched failed:', err.message);
    return [];
  }
}

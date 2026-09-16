// hugo-apps/src/teched-sessions-grid/filter.ts
//
// Pure, DOM-free filtering layer for the TechEd sessions grid (issue #2312).
// Mirrors the channels-directory filter.ts pattern: a single `filterSessions`
// that ANDs every active facet together, extracted so the unit tests can drive
// it without a jsdom/happy-dom setup.
//
// Facets:
//   venue    — 'BERLIN' | 'VIRTUAL' (exact match on session.venue)
//   track    — track slug (exact match on session.track)
//   speaker  — speaker slug (membership test against session.speakers)
//   query    — free text over title, abstract, resolved speaker names,
//              speaker slugs, the resolved track name, the session code,
//              and related Devtoberfest session titles.

export interface RelatedDevtoberfestSession {
  sessionId: string;
  title: string;
  sessionCode?: string;
  taskSlug?: string;
  sharedConceptCount?: number;
}

export interface TechEdSession {
  slug: string;
  title: string;
  abstract?: string | null;
  venue?: string | null;            // 'BERLIN' | 'VIRTUAL'
  track?: string | null;            // track slug
  trackName?: string | null;        // resolved track name (enriched by App for display/search)
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  room?: string | null;
  url?: string | null;
  youtubeUrl?: string | null;
  sessionCode?: string | null;
  speakers?: string[];              // speaker slugs
  speakerNames?: string[];          // resolved speaker names (enriched by App)
  /** Cross-linked Devtoberfest sessions. Emitted by /build/teched when
   *  TECHED_DEVTOBERFEST_CROSSLINK_ENABLED DB flag is ON. Empty array (or
   *  absent) when the flag is OFF — components must treat both as "nothing
   *  to show" (fail-open). */
  relatedDevtoberfestSessions?: RelatedDevtoberfestSession[];
}

export interface TechEdFilterState {
  venue?: string | null;            // '' | 'BERLIN' | 'VIRTUAL'
  track?: string | null;            // track slug
  speaker?: string | null;          // speaker slug
  query?: string | null;
}

/** Build the lowercase search haystack for one session. */
function haystack(s: TechEdSession): string {
  return [
    s.title || '',
    s.abstract || '',
    (s.speakerNames || []).join(' '),
    (s.speakers || []).join(' '),
    s.trackName || '',
    s.sessionCode || '',
    // Index related Devtoberfest session titles so keyword search finds TechEd
    // sessions whose cross-linked sessions match the query (e.g. "CAP Basics").
    (s.relatedDevtoberfestSessions || []).map((r) => r.title || '').join(' '),
  ].join(' ').toLowerCase();
}

/**
 * Return the subset of `sessions` matching EVERY active facet in `state`.
 * Empty/absent facets are ignored. Never mutates its inputs.
 */
export function filterSessions(
  sessions: TechEdSession[],
  state: TechEdFilterState = {},
): TechEdSession[] {
  const q = (state.query || '').trim().toLowerCase();
  return sessions.filter((s) => {
    if (state.venue && s.venue !== state.venue) return false;
    if (state.track && s.track !== state.track) return false;
    if (state.speaker && !(s.speakers || []).includes(state.speaker)) return false;
    if (q && !haystack(s).includes(q)) return false;
    return true;
  });
}

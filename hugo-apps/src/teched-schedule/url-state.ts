// hugo-apps/src/teched-schedule/url-state.ts
//
// Pure, DOM-free parse/serialize layer for the TechEd schedule's deep-link
// query string (issue #2461). Same shape/convention as the TechEd sessions
// grid's url-state.ts (parseTechEdUrl / toTechEdQuery) — schedule has no
// speaker facet; row id = session slug.
//
// URL params on /teched/schedule (or wherever the schedule island is mounted):
//   q=<text>          free-text search (title, abstract, track…)
//   venue=<value>     venue filter (BERLIN | VIRTUAL)
//   track=<slug>      track filter (by track slug)
//   clubhouse=1       Community Clubhouse filter (room "Community Theater")
//   fav=1             favorites-only (auth-gated)
//   row=<slug>        opens that session's detail panel
//
// Every value is validated/trimmed; empty/unrecognised values fall back to
// null so a hand-typed or stale URL never throws.

export interface TechEdScheduleUrlState {
  readonly q: string | null;
  readonly venue: string | null; // 'BERLIN' | 'VIRTUAL'
  readonly track: string | null;
  readonly clubhouse: boolean;
  readonly favorites: boolean;
  readonly row: string | null; // session slug
}

export const DEFAULT_URL_STATE: TechEdScheduleUrlState = Object.freeze({
  q: null,
  venue: null,
  track: null,
  clubhouse: false,
  favorites: false,
  row: null,
});

function nonEmpty(v: string | null): string | null {
  return v && v.trim() ? v.trim() : null;
}

/** Normalise the venue param to the canonical BERLIN|VIRTUAL, or null. */
function normVenue(v: string | null): string | null {
  const t = (v || '').trim().toUpperCase();
  return t === 'BERLIN' || t === 'VIRTUAL' ? t : null;
}

/**
 * Parse a URL query string (or URLSearchParams) into TechEd schedule state.
 * Empty/malformed values become null; the function never throws.
 */
export function parseTechEdScheduleUrl(search: string | URLSearchParams): TechEdScheduleUrlState {
  const p = typeof search === 'string'
    ? new URLSearchParams(search.replace(/^\?/, ''))
    : search;

  return {
    q: nonEmpty(p.get('q')),
    venue: normVenue(p.get('venue')),
    track: nonEmpty(p.get('track')),
    clubhouse: p.get('clubhouse') === '1',
    favorites: p.get('fav') === '1',
    row: nonEmpty(p.get('row')),
  };
}

/**
 * Serialize TechEd schedule state to a query string. Default/empty values are
 * omitted so the URL for the default (unfiltered) state is clean (empty string).
 */
export function toTechEdScheduleQuery(state: TechEdScheduleUrlState): string {
  const p = new URLSearchParams();
  if (nonEmpty(state.q)) p.set('q', state.q!);
  if (normVenue(state.venue)) p.set('venue', normVenue(state.venue)!);
  if (nonEmpty(state.track)) p.set('track', state.track!);
  if (state.clubhouse) p.set('clubhouse', '1');
  if (state.favorites) p.set('fav', '1');
  if (nonEmpty(state.row)) p.set('row', state.row!);
  const s = p.toString();
  return s ? `?${s}` : '';
}

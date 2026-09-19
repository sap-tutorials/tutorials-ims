// hugo-apps/src/teched-sessions-grid/url-state.ts
//
// Pure, DOM-free parse/serialize layer for the TechEd sessions grid's
// deep-link query string (issue #2312). Extracted so the unit tests can drive
// it without a jsdom setup — same shape/convention as the Devtoberfest sessions
// grid's url-state.ts (parse* / to*Query).
//
// URL params on /teched/ :
//   q=<text>          free-text search (title, abstract, speaker, track…)
//   venue=<value>     venue filter (BERLIN | VIRTUAL)
//   track=<slug>      track filter (by track slug)
//   speaker=<slug>    speaker filter (by speaker slug)
//   clubhouse=1       Community Clubhouse filter (room "Community Theater")
//   session=<slug>    opens that session's detail panel
//
// Every value is validated/trimmed; empty/unrecognised values fall back to
// null so a hand-typed or stale URL never throws.

export interface TechEdUrlState {
  readonly q: string | null;
  readonly venue: string | null;
  readonly track: string | null;
  readonly speaker: string | null;
  readonly clubhouse: boolean;
  readonly fav: boolean;
  readonly session: string | null;
}

export const DEFAULT_URL_STATE: TechEdUrlState = Object.freeze({
  q: null,
  venue: null,
  track: null,
  speaker: null,
  clubhouse: false,
  fav: false,
  session: null,
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
 * Parse a URL query string (or URLSearchParams) into grid state.
 * Empty/malformed values become null; the function never throws.
 */
export function parseTechEdUrl(search: string | URLSearchParams): TechEdUrlState {
  const p = typeof search === 'string'
    ? new URLSearchParams(search.replace(/^\?/, ''))
    : search;

  return {
    q: nonEmpty(p.get('q')),
    venue: normVenue(p.get('venue')),
    track: nonEmpty(p.get('track')),
    speaker: nonEmpty(p.get('speaker')),
    clubhouse: p.get('clubhouse') === '1',
    fav: p.get('fav') === '1',
    session: nonEmpty(p.get('session')),
  };
}

/**
 * Serialize grid state to a query string. Default/empty values are omitted so
 * the URL for the default (unfiltered) state is clean (empty string).
 */
export function toTechEdQuery(state: TechEdUrlState): string {
  const p = new URLSearchParams();
  if (nonEmpty(state.q)) p.set('q', state.q!);
  if (normVenue(state.venue)) p.set('venue', normVenue(state.venue)!);
  if (nonEmpty(state.track)) p.set('track', state.track!);
  if (nonEmpty(state.speaker)) p.set('speaker', state.speaker!);
  if (state.clubhouse) p.set('clubhouse', '1');
  if (state.fav) p.set('fav', '1');
  if (nonEmpty(state.session)) p.set('session', state.session!);
  const s = p.toString();
  return s ? `?${s}` : '';
}

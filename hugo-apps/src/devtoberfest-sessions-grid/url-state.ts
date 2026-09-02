// hugo-apps/src/devtoberfest-sessions-grid/url-state.ts
//
// Pure, DOM-free parse/serialize layer for the Devtoberfest sessions grid's
// deep-link query string (issue #2030). Extracted so the unit tests can drive
// it without a jsdom setup — same shape as the calendar's url-state.ts
// (parse* / to*Query) and the concepts-filter precedent.
//
// URL params on /devtoberfest/sessions/ :
//   q=<text>        free-text search (title, abstract, speaker, bio…)
//   week=<week>     week filter (matches ScheduleRow.week)
//   track=<name>    track filter (matches trackName — by name, not id)
//   format=<value>  broadcasting format filter (Live | PreRecorded)
//   edition=<id>    edition selection
//   session=<id>    opens that session's detail panel
//
// Every value is validated/trimmed; empty or unrecognised values fall back to
// null so a hand-typed or stale URL never throws.

export interface SessionsUrlState {
  readonly q: string | null;
  readonly week: string | null;
  readonly track: string | null;
  readonly format: string | null;
  readonly edition: string | null;
  readonly session: string | null;
}

export const DEFAULT_URL_STATE: SessionsUrlState = Object.freeze({
  q: null,
  week: null,
  track: null,
  format: null,
  edition: null,
  session: null,
});

function nonEmpty(v: string | null): string | null {
  return v && v.trim() ? v : null;
}

/**
 * Parse a URL query string (or a URLSearchParams) into sessions-grid state.
 * Empty/malformed values become null; the function never throws.
 */
export function parseSessionsUrl(search: string | URLSearchParams): SessionsUrlState {
  const p = typeof search === 'string'
    ? new URLSearchParams(search.replace(/^\?/, ''))
    : search;

  return {
    q: nonEmpty(p.get('q')),
    week: nonEmpty(p.get('week')),
    track: nonEmpty(p.get('track')),
    format: nonEmpty(p.get('format')),
    edition: nonEmpty(p.get('edition')),
    session: nonEmpty(p.get('session')),
  };
}

/**
 * Serialize sessions-grid state to a query string. Default/empty values are
 * omitted so the URL for the default (unfiltered) state is clean (empty
 * string). Matches the calendar / concepts-filter convention.
 */
export function toSessionsQuery(state: SessionsUrlState): string {
  const p = new URLSearchParams();
  if (nonEmpty(state.q)) p.set('q', state.q!);
  if (nonEmpty(state.week)) p.set('week', state.week!);
  if (nonEmpty(state.track)) p.set('track', state.track!);
  if (nonEmpty(state.format)) p.set('format', state.format!);
  if (nonEmpty(state.edition)) p.set('edition', state.edition!);
  if (nonEmpty(state.session)) p.set('session', state.session!);
  const s = p.toString();
  return s ? `?${s}` : '';
}

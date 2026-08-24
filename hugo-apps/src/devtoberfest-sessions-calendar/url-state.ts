// hugo-apps/src/devtoberfest-sessions-calendar/url-state.ts
//
// Pure, DOM-free parse/serialize layer for the Devtoberfest calendar's
// deep-link query string (issue #2006). Extracted so the unit tests can
// drive it without a jsdom setup — same shape as concepts-filter's
// filter-logic.ts (fromQueryString / toQueryString).
//
// URL params on /devtoberfest/calendar/ :
//   view=month|week|day   the calendar view (week/month = a date range)
//   date=YYYY-MM-DD        cursor anchor (viewer-local day for a session link)
//   session=<id>           opens that session's detail panel
//   track=<trackName>      track filter (the toolbar filters by name, not id)
//   edition=<editionId>    edition selection
//
// Every value is validated; anything unrecognised falls back to null so a
// hand-typed or stale URL never throws.

export type ViewMode = 'month' | 'week' | 'day';

export interface CalendarUrlState {
  readonly view: ViewMode | null; // null → default (month)
  readonly date: string | null;   // YYYY-MM-DD (validated real calendar date)
  readonly session: string | null;
  readonly track: string | null;
  readonly edition: string | null;
}

export const DEFAULT_URL_STATE: CalendarUrlState = Object.freeze({
  view: null,
  date: null,
  session: null,
  track: null,
  edition: null,
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a real calendar date in YYYY-MM-DD form. Rejects wrong
 * shapes (10-05-2026) and impossible days (2026-13-40, 2026-02-30) by
 * round-tripping through UTC and checking the parts survived unchanged.
 */
export function isValidDate(s: string | null | undefined): s is string {
  if (!s || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function nonEmpty(v: string | null): string | null {
  return v && v.trim() ? v : null;
}

/**
 * Parse a URL query string (or a URLSearchParams) into calendar state.
 * Unknown/malformed values become null; the function never throws.
 */
export function parseCalendarUrl(search: string | URLSearchParams): CalendarUrlState {
  const p = typeof search === 'string'
    ? new URLSearchParams(search.replace(/^\?/, ''))
    : search;

  const viewRaw = p.get('view');
  const view: ViewMode | null =
    viewRaw === 'month' || viewRaw === 'week' || viewRaw === 'day' ? viewRaw : null;

  const dateRaw = p.get('date');
  const date = isValidDate(dateRaw) ? dateRaw : null;

  return {
    view,
    date,
    session: nonEmpty(p.get('session')),
    track: nonEmpty(p.get('track')),
    edition: nonEmpty(p.get('edition')),
  };
}

/**
 * Serialize calendar state to a query string. Default/empty values are
 * omitted so the URL for the default state is clean (empty string).
 * Matches the concepts-filter / navigator convention.
 */
export function toCalendarQuery(state: CalendarUrlState): string {
  const p = new URLSearchParams();
  if (state.view && state.view !== 'month') p.set('view', state.view);
  if (isValidDate(state.date)) p.set('date', state.date);
  if (state.session) p.set('session', state.session);
  if (state.track) p.set('track', state.track);
  if (state.edition) p.set('edition', state.edition);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// hugo-apps/src/teched-calendar/url-state.ts
//
// Pure, DOM-free parse/serialize layer for the TechEd calendar's
// deep-link query string. Mirrors the devtoberfest-sessions-calendar/url-state.ts
// pattern but with `venue` instead of `format`/`edition`.
//
// URL params on /teched/calendar/ :
//   view=week|day          the calendar view (week or day only — no month)
//   date=YYYY-MM-DD        cursor anchor (viewer-local day)
//   session=<slug>         opens that session's detail panel
//   track=<trackSlug>      track filter (track slug)
//   venue=BERLIN|VIRTUAL   venue filter
//   clubhouse=1            Community Clubhouse filter (room "Community Theater")
//
// Every value is validated; anything unrecognised falls back to null.

export type TechEdCalViewMode = 'week' | 'day';

export interface TechEdCalUrlState {
  readonly view: TechEdCalViewMode | null; // null → default (week)
  readonly date: string | null;            // YYYY-MM-DD (validated)
  readonly session: string | null;
  readonly track: string | null;
  readonly venue: string | null;
  readonly clubhouse: boolean;
  readonly fav: boolean;
}

export const DEFAULT_TECHED_CAL_URL_STATE: TechEdCalUrlState = Object.freeze({
  view: null,
  date: null,
  session: null,
  track: null,
  venue: null,
  clubhouse: false,
  fav: false,
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

export function parseTechEdCalUrl(search: string | URLSearchParams): TechEdCalUrlState {
  const p = typeof search === 'string'
    ? new URLSearchParams(search.replace(/^\?/, ''))
    : search;

  const viewRaw = p.get('view');
  const view: TechEdCalViewMode | null =
    viewRaw === 'week' || viewRaw === 'day' ? viewRaw : null;

  const dateRaw = p.get('date');
  const date = isValidDate(dateRaw) ? dateRaw : null;

  const venueRaw = nonEmpty(p.get('venue'));
  const venue = venueRaw === 'BERLIN' || venueRaw === 'VIRTUAL' ? venueRaw : null;

  return {
    view,
    date,
    session: nonEmpty(p.get('session')),
    track: nonEmpty(p.get('track')),
    venue,
    clubhouse: p.get('clubhouse') === '1',
    fav: p.get('fav') === '1',
  };
}

export function toTechEdCalQuery(state: TechEdCalUrlState): string {
  const p = new URLSearchParams();
  if (state.view && state.view !== 'week') p.set('view', state.view);
  if (isValidDate(state.date)) p.set('date', state.date);
  if (state.session) p.set('session', state.session);
  if (state.track) p.set('track', state.track);
  if (state.venue) p.set('venue', state.venue);
  if (state.clubhouse) p.set('clubhouse', '1');
  if (state.fav) p.set('fav', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

// hugo-apps/src/devtoberfest-schedule/url-state.ts
//
// Pure, DOM-free parse/serialize layer for the Devtoberfest schedule's
// deep-link query string (issue #2461). Extracted so the unit tests can drive
// it without a jsdom setup — same shape/convention as the sessions grid's
// url-state.ts (parse* / to*Query) and the calendar precedent.
//
// URL params on /devtoberfest/schedule :
//   q=<text>        free-text search (title)
//   week=<week>     week filter (matches ScheduleRow.week)
//   type=<kind>     Session/Activity selector (session | activity)
//   track=<name>    track filter (matches trackName — by name, not id)
//   format=<value>  broadcasting format filter (Live | PreRecorded)
//   fav=1           favorites-only (auth-gated; sessions only)
//   edition=<id>    edition selection (omitted when it's the active edition)
//   row=<kind:id>   opens that row's detail panel (session OR activity)
//
// Every value is validated/trimmed; empty or unrecognised values fall back to
// null so a hand-typed or stale URL never throws.

export interface DevtScheduleUrlState {
  readonly q: string | null;
  readonly week: string | null;
  readonly type: string | null; // 'session' | 'activity'
  readonly track: string | null;
  readonly format: string | null;
  readonly favorites: boolean;
  readonly edition: string | null;
  readonly row: string | null; // `${kind}:${id}`
}

export const DEFAULT_URL_STATE: DevtScheduleUrlState = Object.freeze({
  q: null,
  week: null,
  type: null,
  track: null,
  format: null,
  favorites: false,
  edition: null,
  row: null,
});

function nonEmpty(v: string | null): string | null {
  return v && v.trim() ? v.trim() : null;
}

/** Normalise the type param to the canonical session|activity, or null. */
function normType(v: string | null): string | null {
  const t = (v || '').trim().toLowerCase();
  return t === 'session' || t === 'activity' ? t : null;
}

/**
 * Parse a URL query string (or a URLSearchParams) into schedule state.
 * Empty/malformed values become null; the function never throws.
 */
export function parseDevtScheduleUrl(search: string | URLSearchParams): DevtScheduleUrlState {
  const p = typeof search === 'string'
    ? new URLSearchParams(search.replace(/^\?/, ''))
    : search;

  return {
    q: nonEmpty(p.get('q')),
    week: nonEmpty(p.get('week')),
    type: normType(p.get('type')),
    track: nonEmpty(p.get('track')),
    format: nonEmpty(p.get('format')),
    favorites: p.get('fav') === '1',
    edition: nonEmpty(p.get('edition')),
    row: nonEmpty(p.get('row')),
  };
}

/**
 * Serialize schedule state to a query string. Default/empty values are omitted
 * so the URL for the default (unfiltered) state is clean (empty string).
 * Matches the calendar / sessions-grid convention.
 */
export function toDevtScheduleQuery(state: DevtScheduleUrlState): string {
  const p = new URLSearchParams();
  if (nonEmpty(state.q)) p.set('q', state.q!);
  if (nonEmpty(state.week)) p.set('week', state.week!);
  if (normType(state.type)) p.set('type', normType(state.type)!);
  if (nonEmpty(state.track)) p.set('track', state.track!);
  if (nonEmpty(state.format)) p.set('format', state.format!);
  if (state.favorites) p.set('fav', '1');
  if (nonEmpty(state.edition)) p.set('edition', state.edition!);
  if (nonEmpty(state.row)) p.set('row', state.row!);
  const s = p.toString();
  return s ? `?${s}` : '';
}

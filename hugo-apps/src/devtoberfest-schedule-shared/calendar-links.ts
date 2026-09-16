// Client-side href builders for the Devtoberfest calendar/RSS feeds. These are
// pure string builders — all iCal/RSS rendering and the Google/Outlook
// add-to-calendar URL construction live server-side (srv/lib/devtoberfest-ical.js
// + the /session/:file route), so the client never duplicates date/duration
// logic. The add-to-calendar links point at the server redirect endpoint
// (?to=google|outlook), keeping a single source of truth.

const FEED_BASE = '/api/devtoberfest';

function withEdition(path: string, editionId?: string | null): string {
  return editionId ? `${path}?edition=${encodeURIComponent(editionId)}` : path;
}

export function sessionIcsHref(id: string, editionId?: string | null): string {
  return withEdition(`${FEED_BASE}/session/${encodeURIComponent(id)}.ics`, editionId);
}

export function sessionCalendarHref(id: string, to: 'google' | 'outlook', editionId?: string | null): string {
  let href = `${FEED_BASE}/session/${encodeURIComponent(id)}.ics?to=${to}`;
  if (editionId) href += `&edition=${encodeURIComponent(editionId)}`;
  return href;
}

export function feedIcsHref(editionId?: string | null): string {
  return withEdition(`${FEED_BASE}/feed.ics`, editionId);
}

export function feedRssHref(editionId?: string | null): string {
  return withEdition(`${FEED_BASE}/feed.xml`, editionId);
}

export function subscribeWebcalHref(host: string, editionId?: string | null): string {
  return withEdition(`webcal://${host}${FEED_BASE}/feed.ics`, editionId);
}

// --- TechEd variants ------------------------------------------------------
// TechEd sessions are served by a separate endpoint (/api/teched/session/:slug.ics)
// and are keyed by slug, with no edition concept. Same server-side redirect
// pattern for ?to=google|outlook (single source of truth for date logic).
const TECHED_FEED_BASE = '/api/teched';

export function techedSessionIcsHref(slug: string): string {
  return `${TECHED_FEED_BASE}/session/${encodeURIComponent(slug)}.ics`;
}

export function techedSessionCalendarHref(slug: string, to: 'google' | 'outlook'): string {
  return `${TECHED_FEED_BASE}/session/${encodeURIComponent(slug)}.ics?to=${to}`;
}

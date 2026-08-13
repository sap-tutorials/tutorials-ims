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

// Pure helpers that render TechEd sessions as RFC 5545 iCalendar. Consume the
// /build/teched feed session shape (see teched-feed.js loadTechEdFeed) — no
// cds/db access, so trivially unit-testable, matching this repo's pure-helper +
// thin-route split (mirrors srv/lib/devtoberfest-ical.js).
//
// Time model: TechEd sessions carry BOTH scheduledStart and scheduledEnd as UTC
// Timestamps, so — unlike Devtoberfest, which has only a free-text sessionLength
// and derives the end — we use scheduledEnd directly (falling back to a +60min
// default only if it is missing). Times are emitted in UTC "Z" form
// (YYYYMMDDTHHMMSSZ); every calendar client localizes it for the viewer, so we
// avoid hand-authoring VTIMEZONE/DST blocks.

const PRODID = '-//SAP Developers//TechEd//EN';
const UID_DOMAIN = 'developers.sap.com';
const DEFAULT_MINUTES = 60;

// RFC 5545 text escaping (3.3.11): backslash first, then ; , and newlines.
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Format a Date/ISO string as UTC iCal date-time: YYYYMMDDTHHMMSSZ.
// new Date(null) is the epoch (not Invalid Date), so reject falsy first.
function toICSDateUTC(value) {
  if (!(value instanceof Date) && !value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Content-line folding (RFC 5545 3.1): max 75 octets/line, continuation lines
// begin with a space. Count by UTF-8 bytes; never split a multi-byte char.
function foldLine(line) {
  const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
  if (bytesOf(line) <= 75) return line;
  const out = [];
  let cur = '';
  let limit = 75;
  for (const ch of line) {
    if (bytesOf(cur + ch) > limit) {
      out.push(cur);
      cur = ch;
      limit = 74;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

function line(name, value) {
  return foldLine(`${name}:${escapeText(value)}`);
}

function rawLine(name, value) {
  return foldLine(`${name}:${value}`);
}

function sessionUrl(session) {
  return session.url || session.youtubeUrl || '';
}

function sessionLocation(session) {
  return session.room || session.venue || sessionUrl(session) || 'Online';
}

function buildDescription(session) {
  const parts = [];
  if (session.abstract) parts.push(session.abstract);
  const url = sessionUrl(session);
  if (url) parts.push(url);
  return parts.join('\n\n');
}

// End time (ms since epoch): prefer scheduledEnd when strictly after start,
// else start+60min. Single source of truth for endDateOf + addToCalendarLinks.
function endMsOf(session) {
  const startMs = new Date(session.scheduledStart).getTime();
  const endMs = session.scheduledEnd ? new Date(session.scheduledEnd).getTime() : NaN;
  if (Number.isFinite(endMs) && Number.isFinite(startMs) && endMs > startMs) return endMs;
  return startMs + DEFAULT_MINUTES * 60_000;
}

// End time: prefer the session's real scheduledEnd; fall back to start+60min.
// Guard against dirty ingest data where scheduledEnd is missing OR not strictly
// after scheduledStart (RFC 5545 requires DTEND > DTSTART; a swapped/equal pair
// makes clients silently drop the event).
function endDateOf(session) {
  return toICSDateUTC(new Date(endMsOf(session)));
}

// VEVENT body lines for one session, or null when it has no valid start.
function eventLines(session, now) {
  const dtStart = toICSDateUTC(session.scheduledStart);
  if (!dtStart) return null;
  const dtEnd = endDateOf(session);
  const dtStamp = toICSDateUTC(now) || toICSDateUTC(new Date());

  const out = [
    'BEGIN:VEVENT',
    rawLine('UID', `teched-${session.slug}@${UID_DOMAIN}`),
    rawLine('DTSTAMP', dtStamp),
    rawLine('DTSTART', dtStart),
    rawLine('DTEND', dtEnd),
    line('SUMMARY', session.title || 'SAP TechEd session'),
  ];
  const desc = buildDescription(session);
  if (desc) out.push(line('DESCRIPTION', desc));
  const url = sessionUrl(session);
  if (url) out.push(rawLine('URL', url));
  out.push(line('LOCATION', sessionLocation(session)));
  out.push('END:VEVENT');
  return out;
}

function buildEventICS(session, opts = {}) {
  const now = opts.now || new Date();
  const ev = eventLines(session, now);
  if (!ev) return null;
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    rawLine('PRODID', opts.prodId || PRODID),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...ev,
    'END:VCALENDAR',
  ];
  return out.join('\r\n') + '\r\n';
}

function buildICS(feed, opts = {}) {
  const now = opts.now || new Date();
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    rawLine('PRODID', opts.prodId || PRODID),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    line('X-WR-CALNAME', opts.calName || 'SAP TechEd'),
  ];
  for (const session of feed?.sessions || []) {
    const ev = eventLines(session, now);
    if (ev) out.push(...ev);
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

// Per-session "Add to calendar" deep links for Google Calendar and Outlook.
// Returns { google, outlook }; each is null when the session has no start.
function addToCalendarLinks(session) {
  const startIso = session.scheduledStart;
  const startCompact = toICSDateUTC(startIso);
  if (!startCompact) return { google: null, outlook: null };
  const endCompact = endDateOf(session);
  const endIso = new Date(endMsOf(session)).toISOString();
  const title = session.title || 'SAP TechEd session';
  const details = buildDescription(session);
  const location = sessionLocation(session);

  const google = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(title)}`
    + `&dates=${encodeURIComponent(`${startCompact}/${endCompact}`)}`
    + `&details=${encodeURIComponent(details)}`
    + `&location=${encodeURIComponent(location)}`;

  const outlook = 'https://outlook.office.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent'
    + `&subject=${encodeURIComponent(title)}`
    + `&startdt=${encodeURIComponent(new Date(startIso).toISOString())}`
    + `&enddt=${encodeURIComponent(endIso)}`
    + `&body=${encodeURIComponent(details)}`
    + `&location=${encodeURIComponent(location)}`;

  return { google, outlook };
}

export { buildICS, buildEventICS, addToCalendarLinks, escapeText, foldLine, toICSDateUTC };

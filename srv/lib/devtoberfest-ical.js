// Pure helpers that render Devtoberfest sessions as RFC 5545 iCalendar. Consume
// the assembled-feed session shape (see devtoberfest-feed.js assembleFeed) — no
// cds/db access, so trivially unit-testable, matching this repo's pure-helper +
// thin-route split.
//
// Time model: the planner facade has SCHEDULEDSTART (a UTC Timestamp) but no end
// time, only free-text SESSIONLENGTH. We derive the duration with
// parseSessionLengthMinutes (default 60) and emit DTSTART/DTEND in UTC "Z" form
// (e.g. 20261005T090000Z). UTC is RFC-valid and unambiguous, and every calendar
// client localizes it for the viewer — so we avoid hand-authoring VTIMEZONE/DST
// blocks that a TZID form would require.

import { parseSessionLengthMinutes } from './parse-session-length.js';

const PRODID = '-//SAP Developers//Devtoberfest//EN';
const UID_DOMAIN = 'developers.sap.com';

// RFC 5545 text escaping (3.3.11): backslash, then ; , and newlines. Order
// matters — escape backslash first so the escapes we add are not re-escaped.
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Format a Date/ISO string as UTC iCal date-time: YYYYMMDDTHHMMSSZ.
// Returns null for missing input — note new Date(null) is the epoch, not
// Invalid Date, so we must reject falsy values before constructing a Date.
function toICSDateUTC(value) {
  if (!(value instanceof Date) && !value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Content-line folding (RFC 5545 3.1): no physical line may exceed 75 octets.
// Continuation lines begin with a single space. Count by UTF-8 byte length and
// never split a multi-byte character across the fold boundary.
function foldLine(line) {
  const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
  if (bytesOf(line) <= 75) return line;
  const out = [];
  let cur = '';
  let limit = 75; // first line: 75; continuation lines: 74 (leading space costs 1)
  for (const ch of line) { // iterate by code point, not UTF-16 unit
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

// A raw (already-escaped or structural) line that still needs folding but no
// text escaping — used for pre-formatted values like URLs and dates.
function rawLine(name, value) {
  return foldLine(`${name}:${value}`);
}

function sessionUrl(session) {
  return session.communityEventUrl || session.youtubeUrl || '';
}

function buildDescription(session) {
  const parts = [];
  if (session.abstract) parts.push(session.abstract);
  const speakerNames = (session.speakers || []).map((s) => s.name).filter(Boolean);
  if (speakerNames.length) parts.push(`Speakers: ${speakerNames.join(', ')}`);
  const url = sessionUrl(session);
  if (url) parts.push(url);
  return parts.join('\n\n');
}

// Build the VEVENT body lines for one session, or null when it cannot be placed
// on a calendar (missing/invalid start).
function eventLines(session, now, defaultMinutes) {
  const dtStart = toICSDateUTC(session.scheduledStart);
  if (!dtStart) return null;
  const minutes = parseSessionLengthMinutes(session.sessionLength, defaultMinutes);
  const endMs = new Date(session.scheduledStart).getTime() + minutes * 60_000;
  const dtEnd = toICSDateUTC(new Date(endMs));
  const dtStamp = toICSDateUTC(now) || toICSDateUTC(new Date());

  const out = [
    'BEGIN:VEVENT',
    rawLine('UID', `devtoberfest-${session.id}@${UID_DOMAIN}`),
    rawLine('DTSTAMP', dtStamp),
    rawLine('DTSTART', dtStart),
    rawLine('DTEND', dtEnd),
    line('SUMMARY', session.title || 'Devtoberfest session'),
  ];
  const desc = buildDescription(session);
  if (desc) out.push(line('DESCRIPTION', desc));
  const url = sessionUrl(session);
  if (url) out.push(rawLine('URL', url));
  const location = url || session.trackName || 'Online';
  out.push(line('LOCATION', location));
  out.push('END:VEVENT');
  return out;
}

function buildICS(feed, opts = {}) {
  const now = opts.now || new Date();
  const defaultMinutes = opts.defaultMinutes;
  const editions = feed?.editions || [];
  const activeEdition = editions.find((e) => e.id === feed?.activeEditionId) || editions[0] || {};
  const calName = opts.calName || activeEdition.name || 'Devtoberfest';

  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    rawLine('PRODID', opts.prodId || PRODID),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    line('X-WR-CALNAME', calName),
  ];
  for (const session of feed?.sessions || []) {
    const ev = eventLines(session, now, defaultMinutes);
    if (ev) out.push(...ev);
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

function buildEventICS(session, opts = {}) {
  const now = opts.now || new Date();
  const ev = eventLines(session, now, opts.defaultMinutes);
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

// Per-session "Add to calendar" deep links for Google Calendar and Outlook.
// Returns { google, outlook }; each is null when the session has no start.
function addToCalendarLinks(session, opts = {}) {
  const startIso = session.scheduledStart;
  const startCompact = toICSDateUTC(startIso);
  if (!startCompact) return { google: null, outlook: null };
  const minutes = parseSessionLengthMinutes(session.sessionLength, opts.defaultMinutes);
  const endDate = new Date(new Date(startIso).getTime() + minutes * 60_000);
  const endCompact = toICSDateUTC(endDate);
  const title = session.title || 'Devtoberfest session';
  const details = buildDescription(session);
  const location = sessionUrl(session) || session.trackName || 'Online';

  const google = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(title)}`
    + `&dates=${encodeURIComponent(`${startCompact}/${endCompact}`)}`
    + `&details=${encodeURIComponent(details)}`
    + `&location=${encodeURIComponent(location)}`;

  const outlook = 'https://outlook.office.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent'
    + `&subject=${encodeURIComponent(title)}`
    + `&startdt=${encodeURIComponent(new Date(startIso).toISOString())}`
    + `&enddt=${encodeURIComponent(endDate.toISOString())}`
    + `&body=${encodeURIComponent(details)}`
    + `&location=${encodeURIComponent(location)}`;

  return { google, outlook };
}

export { buildICS, buildEventICS, addToCalendarLinks, escapeText, foldLine, toICSDateUTC };

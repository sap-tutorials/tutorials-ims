import { describe, it, expect } from 'vitest';
import { buildICS, buildEventICS, addToCalendarLinks } from '../../srv/lib/devtoberfest-ical.js';

// A minimal assembled-feed shape (as produced by assembleFeed) for driving the
// iCal builder. Times are UTC ISO strings, matching planner SCHEDULEDSTART.
const session = {
  id: 's1',
  title: 'Intro to CAP',
  abstract: 'Learn CAP basics.',
  scheduledStart: '2026-10-05T09:00:00.000Z',
  scheduledTimeZone: 'Europe/Berlin',
  sessionLength: '30 min',
  trackName: 'ABAP',
  communityEventUrl: 'https://community.sap.com/e/1',
  youtubeUrl: 'https://youtu.be/abc',
  speakers: [{ id: 'sp1', name: 'Al One' }],
};
const feed = { activeEditionId: 'e1', editions: [{ id: 'e1', name: 'Devtoberfest 2026', timeZone: 'Europe/Berlin' }], sessions: [session], activities: [] };
const NOW = new Date('2026-09-01T00:00:00.000Z');

// Split an ICS document back into physical (unfolded-boundary) lines.
const lines = (ics) => ics.split('\r\n');

describe('buildICS', () => {
  it('wraps events in a VCALENDAR with VERSION 2.0 and CRLF line endings', () => {
    const ics = buildICS(feed, { now: NOW });
    expect(ics).toContain('\r\n');
    expect(ics.split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
  });

  it('emits one VEVENT per session that has a scheduledStart', () => {
    const multi = { ...feed, sessions: [session, { ...session, id: 's2', scheduledStart: null }, { ...session, id: 's3' }] };
    const ics = buildICS(multi, { now: NOW });
    const count = (ics.match(/BEGIN:VEVENT/g) || []).length;
    expect(count).toBe(2); // s2 skipped (no start)
  });

  it('derives a stable UID from the session id', () => {
    const ics = buildICS(feed, { now: NOW });
    expect(ics).toContain('UID:devtoberfest-s1@developers.sap.com');
  });

  it('emits DTSTART/DTEND in UTC Z form with DTEND = start + parsed duration', () => {
    const ics = buildICS(feed, { now: NOW });
    expect(ics).toContain('DTSTART:20261005T090000Z');
    expect(ics).toContain('DTEND:20261005T093000Z'); // 30 min later
  });

  it('defaults duration to 60 minutes when sessionLength is unparseable', () => {
    const ics = buildICS({ ...feed, sessions: [{ ...session, sessionLength: '' }] }, { now: NOW });
    expect(ics).toContain('DTEND:20261005T100000Z');
  });

  it('sets DTSTAMP from the supplied now', () => {
    const ics = buildICS(feed, { now: NOW });
    expect(ics).toContain('DTSTAMP:20260901T000000Z');
  });

  it('escapes commas, semicolons, backslashes and newlines in text', () => {
    const s = { ...session, title: 'A, B; C\\D', abstract: 'line1\nline2' };
    const ics = buildICS({ ...feed, sessions: [s] }, { now: NOW });
    expect(ics).toContain('A\\, B\\; C\\\\D');
    expect(ics).toContain('line1\\nline2');
  });

  it('includes the session URL', () => {
    const ics = buildICS(feed, { now: NOW });
    expect(ics).toContain('URL:https://community.sap.com/e/1');
  });

  it('folds every physical line to at most 75 octets', () => {
    const s = { ...session, title: 'X'.repeat(200) };
    const ics = buildICS({ ...feed, sessions: [s] }, { now: NOW });
    for (const l of lines(ics)) {
      expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    }
  });

  it('folds without splitting a multi-byte character (emoji stays intact)', () => {
    const s = { ...session, title: `${'a'.repeat(70)}🟢🟢🟢 tail` };
    const ics = buildICS({ ...feed, sessions: [s] }, { now: NOW });
    // Round-trip: unfold (CRLF + single leading space) and confirm the emoji survives.
    const unfolded = ics.replace(/\r\n[ \t]/g, '');
    expect(unfolded).toContain('🟢🟢🟢 tail');
    for (const l of lines(ics)) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('names the calendar from the active edition', () => {
    const ics = buildICS(feed, { now: NOW });
    expect(ics).toContain('X-WR-CALNAME:Devtoberfest 2026');
  });
});

describe('buildEventICS', () => {
  it('returns a single-event VCALENDAR for one session', () => {
    const ics = buildEventICS(session, { now: NOW });
    expect(ics.split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
    expect((ics.match(/BEGIN:VEVENT/g) || []).length).toBe(1);
    expect(ics).toContain('UID:devtoberfest-s1@developers.sap.com');
    expect(ics).toContain('SUMMARY:Intro to CAP');
  });

  it('returns null when the session has no scheduledStart', () => {
    expect(buildEventICS({ ...session, scheduledStart: null }, { now: NOW })).toBeNull();
  });
});

describe('addToCalendarLinks', () => {
  it('builds a Google Calendar template URL with encoded title and UTC date range', () => {
    const { google } = addToCalendarLinks(session);
    expect(google).toContain('https://calendar.google.com/calendar/render?action=TEMPLATE');
    expect(google).toContain('text=Intro%20to%20CAP');
    expect(google).toContain('dates=20261005T090000Z%2F20261005T093000Z');
  });

  it('builds an Outlook deeplink with subject and ISO start/end', () => {
    const { outlook } = addToCalendarLinks(session);
    expect(outlook).toContain('outlook.office.com/calendar');
    expect(outlook).toContain('subject=Intro%20to%20CAP');
    expect(outlook).toContain('startdt=2026-10-05T09%3A00%3A00.000Z');
    expect(outlook).toContain('enddt=2026-10-05T09%3A30%3A00.000Z');
  });

  it('returns null links when the session has no scheduledStart', () => {
    expect(addToCalendarLinks({ ...session, scheduledStart: null })).toEqual({ google: null, outlook: null });
  });
});

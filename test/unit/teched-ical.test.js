import { describe, it, expect } from 'vitest';
import { buildICS, buildEventICS, addToCalendarLinks, toICSDateUTC } from '../../srv/lib/teched-ical.js';

// A minimal /build/teched feed session shape (see srv/lib/teched-feed.js). The
// session identity is `slug` (no `id`), and TechEd carries a real scheduledEnd.
const session = {
  slug: 'te26-101',
  sessionCode: 'DEV101',
  title: 'Intro to CAP',
  abstract: 'Learn CAP basics.',
  venue: 'BERLIN',
  room: 'Hall A',
  scheduledStart: '2026-10-05T09:00:00.000Z',
  scheduledEnd: '2026-10-05T10:00:00.000Z',
  url: 'https://community.sap.com/e/1',
  youtubeUrl: 'https://youtu.be/abc',
  track: 'abap',
  speakers: ['al-one'],
};
const feed = { sessions: [session], speakers: [], tracks: [] };
const NOW = new Date('2026-09-01T00:00:00.000Z');

describe('teched-ical', () => {
  it('buildEventICS emits a VCALENDAR/VEVENT with UTC start+end from scheduledEnd', () => {
    const ics = buildEventICS(session, { now: NOW });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('PRODID:-//SAP Developers//TechEd//EN');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:teched-te26-101@developers.sap.com');
    expect(ics).toContain('DTSTART:20261005T090000Z');
    // Uses the real scheduledEnd (10:00), NOT a +60min guess off a length field.
    expect(ics).toContain('DTEND:20261005T100000Z');
    expect(ics).toContain('SUMMARY:Intro to CAP');
    expect(ics).toContain('LOCATION:Hall A');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('falls back to +60min when scheduledEnd is missing', () => {
    const noEnd = { ...session, scheduledEnd: null };
    const ics = buildEventICS(noEnd, { now: NOW });
    expect(ics).toContain('DTSTART:20261005T090000Z');
    expect(ics).toContain('DTEND:20261005T100000Z'); // 09:00 + 60min
  });

  it('ignores a scheduledEnd that is not strictly after start (dirty data)', () => {
    // Swapped/inverted end would produce DTEND <= DTSTART, which clients drop.
    const inverted = { ...session, scheduledEnd: '2026-10-05T08:00:00.000Z' };
    const ics = buildEventICS(inverted, { now: NOW });
    expect(ics).toContain('DTSTART:20261005T090000Z');
    expect(ics).toContain('DTEND:20261005T100000Z'); // falls back to start + 60min
    // add-to-calendar links stay consistent (google compact end == outlook ISO end).
    const { google, outlook } = addToCalendarLinks(inverted);
    expect(google).toContain(encodeURIComponent('20261005T090000Z/20261005T100000Z'));
    expect(outlook).toContain(encodeURIComponent('2026-10-05T10:00:00.000Z'));
  });

  it('LOCATION falls back room → venue → url → Online', () => {
    expect(buildEventICS({ ...session, room: null }, { now: NOW })).toContain('LOCATION:BERLIN');
    expect(buildEventICS({ ...session, room: null, venue: null }, { now: NOW }))
      .toContain('LOCATION:https://community.sap.com/e/1');
    expect(buildEventICS({ ...session, room: null, venue: null, url: null, youtubeUrl: null }, { now: NOW }))
      .toContain('LOCATION:Online');
  });

  it('buildEventICS returns null for a session without a start', () => {
    expect(buildEventICS({ ...session, scheduledStart: null }, { now: NOW })).toBeNull();
  });

  it('buildICS wraps every scheduled session and names the calendar', () => {
    const ics = buildICS(feed, { now: NOW });
    expect(ics).toContain('X-WR-CALNAME:SAP TechEd');
    expect((ics.match(/BEGIN:VEVENT/g) || []).length).toBe(1);
  });

  it('addToCalendarLinks builds Google + Outlook targets from start/end', () => {
    const { google, outlook } = addToCalendarLinks(session);
    expect(google).toContain('calendar.google.com/calendar/render');
    expect(google).toContain(encodeURIComponent('20261005T090000Z/20261005T100000Z'));
    expect(google).toContain(encodeURIComponent('Intro to CAP'));
    expect(outlook).toContain('outlook.office.com/calendar');
    expect(outlook).toContain(encodeURIComponent('2026-10-05T09:00:00.000Z'));
    expect(outlook).toContain(encodeURIComponent('2026-10-05T10:00:00.000Z'));
  });

  it('addToCalendarLinks returns nulls for an unscheduled session', () => {
    expect(addToCalendarLinks({ ...session, scheduledStart: null })).toEqual({ google: null, outlook: null });
  });

  it('toICSDateUTC rejects falsy/invalid input', () => {
    expect(toICSDateUTC(null)).toBeNull();
    expect(toICSDateUTC('not-a-date')).toBeNull();
  });
});

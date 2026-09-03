import { describe, it, expect } from 'vitest';
import { assembleFeed, completedActivityPoints, normalizeSlugSet, filterCompletionsWithinWindow, isVisibleStatus } from '../../srv/lib/devtoberfest-feed.js';

describe('devtoberfest-feed', () => {
  const tracks = [{ ID: 't1', NAME: 'ABAP', DAYOFWEEK: 'Monday' }];
  const sessions = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', STATUS: 'Confirmed', WEEK: '1', SCHEDULEDSTART: '2026-10-05T09:00:00.000Z', SCHEDULEDTIMEZONE: 'Europe/Berlin', YOUTUBEURL: 'https://youtu.be/abc', ACTIVITY_ID: 'a1' }];
  const activities = [
    { ID: 'a1', TITLE: 'Do Intro', STATUS: 'Confirmed', WEEK: '1', POINTS: 500, TASKTYPE: 'TUTORIAL', TASKSLUG: 'Intro-Slug', TRACK_ID: 't1' },
    { ID: 'a2', TITLE: 'Puzzle', STATUS: 'Completed', WEEK: '1', POINTS: 300, TASKTYPE: 'PUZZLE', TASKSLUG: 'puz-1', TRACK_ID: 't1' },
  ];

  it('assembleFeed maps track name/day and keeps active edition', () => {
    const out = assembleFeed({ sessions, activities, tracks, editions: [{ ID: 'e1', NAME: '2026', ISCURRENT: true }], activeEditionId: 'e1' });
    expect(out.activeEditionId).toBe('e1');
    expect(out.sessions[0].trackName).toBe('ABAP');
    expect(out.sessions[0].trackDay).toBe('Monday');
    expect(out.activities).toHaveLength(2);
  });

  it('assembleFeed emits scheduledStart and scheduledTimeZone, not scheduledDate/scheduledTime', () => {
    const out = assembleFeed({ sessions, activities, tracks, editions: [], activeEditionId: null });
    const s = out.sessions[0];
    expect(s.scheduledStart).toBe('2026-10-05T09:00:00.000Z');
    expect(s.scheduledTimeZone).toBe('Europe/Berlin');
    expect('scheduledDate' in s).toBe(false);
    expect('scheduledTime' in s).toBe(false);
  });

  it('assembleFeed emits edition startsAt/endsAt/timeZone, not startDate/endDate', () => {
    const editions = [{ ID: 'e1', NAME: '2026', YEAR: '2026', ISCURRENT: true, STARTSAT: '2026-10-01T00:00:00.000Z', ENDSAT: '2026-10-31T23:59:59.000Z', TIMEZONE: 'Europe/Berlin' }];
    const out = assembleFeed({ sessions: [], activities: [], tracks: [], editions, activeEditionId: 'e1' });
    const e = out.editions[0];
    expect(e.startsAt).toBe('2026-10-01T00:00:00.000Z');
    expect(e.endsAt).toBe('2026-10-31T23:59:59.000Z');
    expect(e.timeZone).toBe('Europe/Berlin');
    expect('startDate' in e).toBe(false);
    expect('endDate' in e).toBe(false);
  });

  it('sessions sort by week then scheduledStart (ISO lexicographic)', () => {
    const s2 = { ID: 's2', TITLE: 'Later', TRACK_ID: 't1', STATUS: 'Confirmed', WEEK: '1', SCHEDULEDSTART: '2026-10-05T11:00:00.000Z' };
    const s1 = { ID: 's1', TITLE: 'Earlier', TRACK_ID: 't1', STATUS: 'Confirmed', WEEK: '1', SCHEDULEDSTART: '2026-10-05T09:00:00.000Z' };
    const out = assembleFeed({ sessions: [s2, s1], activities: [], tracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].id).toBe('s1');
    expect(out.sessions[1].id).toBe('s2');
  });

  it('assembleFeed carries sessionLength (raw free-text) onto sessions', () => {
    const sess = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', STATUS: 'Confirmed', SESSIONLENGTH: '30 min' }];
    const out = assembleFeed({ sessions: sess, activities: [], tracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].sessionLength).toBe('30 min');
  });

  it('assembleFeed carries communityEventUrl and sessionCode onto sessions', () => {
    const sess = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', STATUS: 'Confirmed', SESSIONCODE: 'DEV101', COMMUNITYEVENTURL: 'https://community.sap.com/e/1' }];
    const out = assembleFeed({ sessions: sess, activities: [], tracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].communityEventUrl).toBe('https://community.sap.com/e/1');
    expect(out.sessions[0].sessionCode).toBe('DEV101');
  });

  it('assembleFeed carries broadcastingPreference (Live/PreRecorded), null when unset', () => {
    const sess = [
      { ID: 's1', TITLE: 'Live one', TRACK_ID: 't1', STATUS: 'Confirmed', BROADCASTINGPREFERENCE: 'Live' },
      { ID: 's2', TITLE: 'Recorded', TRACK_ID: 't1', STATUS: 'Confirmed', BROADCASTINGPREFERENCE: 'PreRecorded' },
      { ID: 's3', TITLE: 'Unset', TRACK_ID: 't1', STATUS: 'Confirmed' },
    ];
    const out = assembleFeed({ sessions: sess, activities: [], tracks, editions: [], activeEditionId: null });
    const byId = Object.fromEntries(out.sessions.map((s) => [s.id, s]));
    expect(byId.s1.broadcastingPreference).toBe('Live');
    expect(byId.s2.broadcastingPreference).toBe('PreRecorded');
    expect(byId.s3.broadcastingPreference).toBe(null);
  });

  it('normalizeSlugSet lowercases and dedupes', () => {
    const set = normalizeSlugSet([{ slug: 'Intro-Slug' }, { TASKSLUG: 'PUZ-1' }]);
    expect(set.has('intro-slug')).toBe(true);
    expect(set.has('puz-1')).toBe(true);
  });

  it('completedActivityPoints sums points for completed slugs, counted once', () => {
    const set = normalizeSlugSet([{ slug: 'intro-slug' }]);
    const r = completedActivityPoints(activities, set);
    expect(r.earnedPoints).toBe(500);
    expect(r.maxPoints).toBe(800);
    expect(r.completedActivityIds).toEqual(['a1']);
  });

  it('assembleFeed attaches ordered speakers and maps linkedinUrl', () => {
    const sess = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', STATUS: 'Confirmed', WEEK: '1', LINKEDINURL: 'https://linkedin.com/in/x' }];
    const speakers = [
      { ID: 'sp2', FIRSTNAME: 'Bea', LASTNAME: 'Two', ROLE: 'Dev', COMPANY: 'SAP' },
      { ID: 'sp1', FIRSTNAME: 'Al', LASTNAME: 'One', ROLE: 'PM', COMPANY: 'SAP', BIO: 'Loves HANA graph workloads.' },
    ];
    const sessionSpeakers = [
      { SESSION_ID: 's1', SPEAKER_ID: 'sp2', SPEAKERORDER: 2 },
      { SESSION_ID: 's1', SPEAKER_ID: 'sp1', SPEAKERORDER: 1 },
    ];
    const out = assembleFeed({ sessions: sess, activities: [], tracks, editions: [], activeEditionId: null, speakers, sessionSpeakers });
    const s = out.sessions[0];
    expect(s.linkedinUrl).toBe('https://linkedin.com/in/x');
    expect(s.speakers.map((sp) => sp.id)).toEqual(['sp1', 'sp2']); // ordered
    expect(s.speakers[0]).toEqual({ id: 'sp1', name: 'Al One', role: 'PM', company: 'SAP', bio: 'Loves HANA graph workloads.', photoUrl: '/api/devtoberfest/speaker/sp1/photo' });
    // Missing BIO defaults to '' so the client can search it unconditionally.
    expect(s.speakers[1].bio).toBe('');
  });

  it('assembleFeed defaults speakers to [] and linkedinUrl to empty when none', () => {
    const out = assembleFeed({ sessions: [{ ID: 's9', TITLE: 'X', TRACK_ID: 't1', STATUS: 'Confirmed' }], activities: [], tracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].speakers).toEqual([]);
    expect(out.sessions[0].linkedinUrl).toBe('');
  });

  it('assembleFeed carries trackColor and trackEmoji onto sessions', () => {
    const colorTracks = [{ ID: 't1', NAME: 'ABAP', DAYOFWEEK: 'Monday', COLOR: 'Green', EMOJI: '🟢' }];
    const out = assembleFeed({ sessions: [{ ID: 's1', TITLE: 'X', TRACK_ID: 't1', STATUS: 'Confirmed' }], activities: [], tracks: colorTracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].trackColor).toBe('Green');
    expect(out.sessions[0].trackEmoji).toBe('🟢');
  });

  describe('filterCompletionsWithinWindow', () => {
    const start = '2026-10-01T00:00:00.000Z';
    const end = '2026-10-31T23:59:59.000Z';
    const rows = [
      { slug: 'inside', completionDate: '2026-10-15T12:00:00.000Z' },
      { slug: 'before', completionDate: '2026-09-30T23:59:59.000Z' },
      { slug: 'after', completionDate: '2026-11-01T00:00:00.000Z' },
      { slug: 'on-start', completionDate: '2026-10-01T00:00:00.000Z' },
      { slug: 'on-end', completionDate: '2026-10-31T23:59:59.000Z' },
      { slug: 'no-date', completionDate: null },
    ];

    it('keeps only completions with completionDate within [start,end] inclusive', () => {
      const out = filterCompletionsWithinWindow(rows, start, end);
      const slugs = out.map((r) => r.slug).sort();
      expect(slugs).toEqual(['inside', 'on-end', 'on-start']);
    });

    it('excludes rows with a missing/unparseable completionDate', () => {
      const out = filterCompletionsWithinWindow(rows, start, end);
      expect(out.some((r) => r.slug === 'no-date')).toBe(false);
      expect(filterCompletionsWithinWindow([{ slug: 'bad', completionDate: 'not-a-date' }], start, end)).toEqual([]);
    });

    it('returns [] when the window is not fully defined (fail-closed)', () => {
      expect(filterCompletionsWithinWindow(rows, null, end)).toEqual([]);
      expect(filterCompletionsWithinWindow(rows, start, null)).toEqual([]);
      expect(filterCompletionsWithinWindow(rows, undefined, undefined)).toEqual([]);
    });

    it('handles empty/nullish rows input', () => {
      expect(filterCompletionsWithinWindow(null, start, end)).toEqual([]);
      expect(filterCompletionsWithinWindow([], start, end)).toEqual([]);
    });
  });

  describe('status filtering (Confirmed/Completed only)', () => {
    const tracks = [{ ID: 't1', NAME: 'ABAP' }];
    const mkSession = (id, status) => ({ ID: id, TITLE: id, TRACK_ID: 't1', STATUS: status, WEEK: '1' });
    const mkActivity = (id, status, points = 100, slug = id) => ({ ID: id, TITLE: id, TRACK_ID: 't1', STATUS: status, WEEK: '1', POINTS: points, TASKSLUG: slug });

    it('isVisibleStatus accepts only Confirmed/Completed, case-insensitively', () => {
      for (const s of ['Confirmed', 'confirmed', 'CONFIRMED', '  Confirmed  ', 'Completed', 'completed']) {
        expect(isVisibleStatus({ STATUS: s })).toBe(true);
      }
      for (const s of ['Draft', 'Invited', 'Declined', 'Cancelled', 'PendingTutorial', '', null, undefined]) {
        expect(isVisibleStatus({ STATUS: s })).toBe(false);
      }
    });

    it('assembleFeed drops hidden-status sessions and activities', () => {
      const sessions = [mkSession('sV', 'Confirmed'), mkSession('sD', 'Draft'), mkSession('sX', 'Cancelled'), mkSession('sC', 'Completed')];
      const acts = [mkActivity('aV', 'Confirmed'), mkActivity('aI', 'Invited'), mkActivity('aP', 'PendingTutorial'), mkActivity('aC', 'Completed')];
      const out = assembleFeed({ sessions, activities: acts, tracks, editions: [], activeEditionId: null });
      expect(out.sessions.map((s) => s.id).sort()).toEqual(['sC', 'sV']);
      expect(out.activities.map((a) => a.id).sort()).toEqual(['aC', 'aV']);
    });

    it('completedActivityPoints ignores hidden-status activities in earned and max', () => {
      const acts = [
        mkActivity('aV', 'Confirmed', 500, 'done-slug'),
        mkActivity('aHidden', 'Draft', 999, 'done-slug'),
      ];
      const set = normalizeSlugSet([{ slug: 'done-slug' }]);
      const r = completedActivityPoints(acts, set);
      expect(r.earnedPoints).toBe(500);
      expect(r.maxPoints).toBe(500);
      expect(r.completedActivityIds).toEqual(['aV']);
    });
  });
});

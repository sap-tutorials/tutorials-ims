import { describe, it, expect } from 'vitest';
import { assembleFeed, completedActivityPoints, normalizeSlugSet } from '../../srv/lib/devtoberfest-feed.js';

describe('devtoberfest-feed', () => {
  const tracks = [{ ID: 't1', NAME: 'ABAP', DAYOFWEEK: 'Monday' }];
  const sessions = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', WEEK: '1', SCHEDULEDSTART: '2026-10-05T09:00:00.000Z', SCHEDULEDTIMEZONE: 'Europe/Berlin', YOUTUBEURL: 'https://youtu.be/abc', ACTIVITY_ID: 'a1' }];
  const activities = [
    { ID: 'a1', TITLE: 'Do Intro', WEEK: '1', POINTS: 500, TASKTYPE: 'TUTORIAL', TASKSLUG: 'Intro-Slug', TRACK_ID: 't1' },
    { ID: 'a2', TITLE: 'Puzzle', WEEK: '1', POINTS: 300, TASKTYPE: 'PUZZLE', TASKSLUG: 'puz-1', TRACK_ID: 't1' },
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
    const s2 = { ID: 's2', TITLE: 'Later', TRACK_ID: 't1', WEEK: '1', SCHEDULEDSTART: '2026-10-05T11:00:00.000Z' };
    const s1 = { ID: 's1', TITLE: 'Earlier', TRACK_ID: 't1', WEEK: '1', SCHEDULEDSTART: '2026-10-05T09:00:00.000Z' };
    const out = assembleFeed({ sessions: [s2, s1], activities: [], tracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].id).toBe('s1');
    expect(out.sessions[1].id).toBe('s2');
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
    const sess = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', WEEK: '1', LINKEDINURL: 'https://linkedin.com/in/x' }];
    const speakers = [
      { ID: 'sp2', FIRSTNAME: 'Bea', LASTNAME: 'Two', ROLE: 'Dev', COMPANY: 'SAP' },
      { ID: 'sp1', FIRSTNAME: 'Al', LASTNAME: 'One', ROLE: 'PM', COMPANY: 'SAP' },
    ];
    const sessionSpeakers = [
      { SESSION_ID: 's1', SPEAKER_ID: 'sp2', SPEAKERORDER: 2 },
      { SESSION_ID: 's1', SPEAKER_ID: 'sp1', SPEAKERORDER: 1 },
    ];
    const out = assembleFeed({ sessions: sess, activities: [], tracks, editions: [], activeEditionId: null, speakers, sessionSpeakers });
    const s = out.sessions[0];
    expect(s.linkedinUrl).toBe('https://linkedin.com/in/x');
    expect(s.speakers.map((sp) => sp.id)).toEqual(['sp1', 'sp2']); // ordered
    expect(s.speakers[0]).toEqual({ id: 'sp1', name: 'Al One', role: 'PM', company: 'SAP', photoUrl: '/api/devtoberfest/speaker/sp1/photo' });
  });

  it('assembleFeed defaults speakers to [] and linkedinUrl to empty when none', () => {
    const out = assembleFeed({ sessions: [{ ID: 's9', TITLE: 'X', TRACK_ID: 't1' }], activities: [], tracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].speakers).toEqual([]);
    expect(out.sessions[0].linkedinUrl).toBe('');
  });

  it('assembleFeed carries trackColor and trackEmoji onto sessions', () => {
    const colorTracks = [{ ID: 't1', NAME: 'ABAP', DAYOFWEEK: 'Monday', COLOR: 'Green', EMOJI: '🟢' }];
    const out = assembleFeed({ sessions: [{ ID: 's1', TITLE: 'X', TRACK_ID: 't1' }], activities: [], tracks: colorTracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].trackColor).toBe('Green');
    expect(out.sessions[0].trackEmoji).toBe('🟢');
  });
});

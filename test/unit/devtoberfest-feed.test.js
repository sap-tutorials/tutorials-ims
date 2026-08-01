import { describe, it, expect } from 'vitest';
import { assembleFeed, completedActivityPoints, normalizeSlugSet } from '../../srv/lib/devtoberfest-feed.js';

describe('devtoberfest-feed', () => {
  const tracks = [{ ID: 't1', NAME: 'ABAP', DAYOFWEEK: 'Monday' }];
  const sessions = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', WEEK: '1', SCHEDULEDDATE: '2026-10-05', YOUTUBEURL: 'https://youtu.be/abc', ACTIVITY_ID: 'a1' }];
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
});

// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { youtubeId } from '../youtube';
import { youtubeThumb, mergeCompletion, safeHref, sessionMatchesQuery } from '../completion';

describe('youtube helpers', () => {
  it('extracts id from youtu.be, watch, embed', () => {
    expect(youtubeId('https://youtu.be/abc123')).toBe('abc123');
    expect(youtubeId('https://www.youtube.com/watch?v=xyz789&t=1')).toBe('xyz789');
    expect(youtubeId('https://www.youtube.com/embed/def456')).toBe('def456');
    expect(youtubeId('')).toBeNull();
    expect(youtubeId('https://example.com')).toBeNull();
  });
  it('thumb returns hqdefault url or null', () => {
    expect(youtubeThumb('https://youtu.be/abc123')).toBe('https://i.ytimg.com/vi/abc123/hqdefault.jpg');
    expect(youtubeThumb('nope')).toBeNull();
  });
});

describe('mergeCompletion', () => {
  const feed = {
    activeEditionId: 'e1', editions: [],
    sessions: [{ id: 's1', kind: 'session', title: 'S', activityId: 'a1', week: '1' }],
    activities: [
      { id: 'a1', kind: 'activity', title: 'A1', points: 500, taskSlug: 'slug-a', week: '1' },
      { id: 'a2', kind: 'activity', title: 'A2', points: 300, taskSlug: 'slug-b', week: '1' },
    ],
  } as any;

  it('marks sessions+activities complete and totals points', () => {
    const my = { authenticated: true, joined: true, completedSlugs: ['slug-a'], earnedPoints: 500, maxPoints: 800, completedActivityIds: ['a1'] } as any;
    const out = mergeCompletion(feed, my);
    expect(out.joined).toBe(true);
    expect(out.earnedPoints).toBe(500);
    expect(out.maxPoints).toBe(800);
    const session = out.rows.find((r) => r.id === 's1')!;
    expect(session.complete).toBe(true); // via linked activity a1
    const a2 = out.rows.find((r) => r.id === 'a2')!;
    expect(a2.complete).toBe(false);
  });

  it('authenticated-but-not-joined reports joined:false and zero earned points', () => {
    const my = { authenticated: true, joined: false, earnedPoints: 0, maxPoints: 800, completedSlugs: [], completedActivityIds: [] } as any;
    const out = mergeCompletion(feed, my);
    expect(out.joined).toBe(false);
    expect(out.earnedPoints).toBe(0);
    expect(out.maxPoints).toBe(800); // goal denominator still shown
    expect(out.rows.every((r) => !r.complete)).toBe(true);
  });

  it('anonymous merge leaves everything incomplete', () => {
    const out = mergeCompletion(feed, { authenticated: false } as any);
    expect(out.joined).toBe(false);
    expect(out.rows.every((r) => !r.complete)).toBe(true);
    expect(out.earnedPoints).toBe(0);
  });
});

describe('sessionMatchesQuery', () => {
  const row = {
    id: 's1', kind: 'session', title: 'Build a CAP Service',
    abstract: 'Learn to model data with SAP HANA Cloud.',
    speakers: [
      { id: 'sp1', name: 'Ada Lovelace', role: 'Developer Advocate', company: 'SAP', bio: 'Loves RAP and Fiori Elements.' },
    ],
  } as any;

  it('matches on title (case-insensitive)', () => {
    expect(sessionMatchesQuery(row, 'cap service')).toBe(true);
    expect(sessionMatchesQuery(row, 'CAP')).toBe(true);
  });
  it('matches on abstract', () => {
    expect(sessionMatchesQuery(row, 'hana cloud')).toBe(true);
  });
  it('matches on speaker name, role, company and bio', () => {
    expect(sessionMatchesQuery(row, 'lovelace')).toBe(true);
    expect(sessionMatchesQuery(row, 'advocate')).toBe(true);
    expect(sessionMatchesQuery(row, 'sap')).toBe(true);
    expect(sessionMatchesQuery(row, 'fiori elements')).toBe(true);
  });
  it('does not match unrelated text', () => {
    expect(sessionMatchesQuery(row, 'kubernetes')).toBe(false);
  });
  it('blank query matches everything', () => {
    expect(sessionMatchesQuery(row, '')).toBe(true);
    expect(sessionMatchesQuery(row, '   ')).toBe(true);
  });
  it('does not bridge two adjacent fields', () => {
    // title ends "...Service", abstract begins "Learn..." — a query spanning
    // the boundary must not match.
    expect(sessionMatchesQuery(row, 'service learn')).toBe(false);
  });
  it('tolerates a session with no abstract or speakers', () => {
    expect(sessionMatchesQuery({ id: 'x', kind: 'session', title: 'Solo' } as any, 'solo')).toBe(true);
    expect(sessionMatchesQuery({ id: 'x', kind: 'session', title: 'Solo' } as any, 'nope')).toBe(false);
  });
});

describe('safeHref', () => {
  it('returns https url unchanged', () => {
    expect(safeHref('https://youtu.be/x')).toBe('https://youtu.be/x');
  });
  it('blocks javascript: scheme', () => {
    expect(safeHref('javascript:alert(1)')).toBe('');
  });
  it('returns empty string for empty input', () => {
    expect(safeHref('')).toBe('');
  });
  it('returns empty string for null', () => {
    expect(safeHref(null)).toBe('');
  });
});

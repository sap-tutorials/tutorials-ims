// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { youtubeId } from '../youtube';
import { youtubeThumb, mergeCompletion, safeHref } from '../completion';

describe('youtube helpers', () => {
  it('extracts id from youtu.be, watch, embed', () => {
    expect(youtubeId('https://youtu.be/abc123')).toBe('abc123');
    expect(youtubeId('https://www.youtube.com/watch?v=xyz789&t=1')).toBe('xyz789');
    expect(youtubeId('https://www.youtube.com/embed/def456')).toBe('def456');
    expect(youtubeId('')).toBeNull();
    expect(youtubeId('https://example.com')).toBeNull();
  });
  it('thumb returns hqdefault url or null', () => {
    expect(youtubeThumb('https://youtu.be/abc123')).toBe('https://img.youtube.com/vi/abc123/hqdefault.jpg');
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
    const my = { authenticated: true, completedSlugs: ['slug-a'], earnedPoints: 500, maxPoints: 800, completedActivityIds: ['a1'] } as any;
    const out = mergeCompletion(feed, my);
    expect(out.earnedPoints).toBe(500);
    expect(out.maxPoints).toBe(800);
    const session = out.rows.find((r) => r.id === 's1')!;
    expect(session.complete).toBe(true); // via linked activity a1
    const a2 = out.rows.find((r) => r.id === 'a2')!;
    expect(a2.complete).toBe(false);
  });

  it('anonymous merge leaves everything incomplete', () => {
    const out = mergeCompletion(feed, { authenticated: false } as any);
    expect(out.rows.every((r) => !r.complete)).toBe(true);
    expect(out.earnedPoints).toBe(0);
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

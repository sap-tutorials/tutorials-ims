import { youtubeId } from './youtube';
import type { Feed, MyCompletions, ScheduleRow } from './types';

export function safeHref(u?: string | null): string {
  if (!u) return '';
  try {
    const p = new URL(u, window.location.origin);
    return (p.protocol === 'https:' || p.protocol === 'http:') ? u : '';
  } catch { return ''; }
}

export function youtubeThumb(url: string): string | null {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

export function mergeCompletion(feed: Feed, my: MyCompletions) {
  const completedActivityIds = new Set<string>(my?.authenticated ? my.completedActivityIds || [] : []);
  const completedSlugs = new Set<string>((my?.authenticated ? my.completedSlugs || [] : []).map((s) => s.toLowerCase()));

  const activityRows: ScheduleRow[] = feed.activities.map((a) => ({
    ...a,
    complete: completedActivityIds.has(a.id) || (!!a.taskSlug && completedSlugs.has(a.taskSlug.toLowerCase())),
  }));
  const sessionRows: ScheduleRow[] = feed.sessions.map((s) => ({
    ...s,
    complete: !!s.activityId && completedActivityIds.has(s.activityId),
  }));

  return {
    rows: [...sessionRows, ...activityRows],
    earnedPoints: my?.authenticated ? my.earnedPoints || 0 : 0,
    maxPoints: my?.authenticated ? my.maxPoints || feed.activities.reduce((n, a) => n + (a.points || 0), 0) : feed.activities.reduce((n, a) => n + (a.points || 0), 0),
    completedActivityIds,
  };
}

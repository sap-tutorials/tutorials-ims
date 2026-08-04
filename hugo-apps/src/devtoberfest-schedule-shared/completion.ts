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
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}

/**
 * Map a schedule activity's taskType + taskSlug to the page that serves it.
 * Petoberfest and puzzles live under their own content sections, NOT /tutorials/.
 * Linking a petoberfest/puzzle slug under /tutorials/ 404s (verified live).
 * Anything else defaults to /tutorials/ (the historical majority case).
 */
export function taskHref(row: { taskType?: string | null; taskSlug?: string | null } | null): string {
  const slug = row?.taskSlug;
  if (!slug) return '';
  switch (String(row?.taskType || '').toLowerCase()) {
    case 'puzzle': return `/puzzles/${slug}`;
    case 'petoberfest': return `/petoberfest/${slug}`;
    default: return `/tutorials/${slug}`;
  }
}

/** Link label matching the destination of {@link taskHref}. */
export function taskLinkLabel(row: { taskType?: string | null } | null): string {
  switch (String(row?.taskType || '').toLowerCase()) {
    case 'puzzle': return 'Open puzzle';
    case 'petoberfest': return 'Open Petoberfest';
    default: return 'Open tutorial';
  }
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
    joined: !!my?.authenticated && !!my.joined,
    earnedPoints: my?.authenticated ? my.earnedPoints || 0 : 0,
    maxPoints: my?.authenticated ? my.maxPoints || feed.activities.reduce((n, a) => n + (a.points || 0), 0) : feed.activities.reduce((n, a) => n + (a.points || 0), 0),
    completedActivityIds,
  };
}

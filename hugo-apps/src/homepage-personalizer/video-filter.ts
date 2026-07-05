interface VideoItem { videoId: string; title?: string; tags?: string[]; [k: string]: any; }

export function applyVideoFilter(items: VideoItem[], tags: string[]): VideoItem[] {
  if (!items?.length || !tags?.length) return items || [];
  const wants = new Set(tags.map((t) => t.toLowerCase()));
  const hit: VideoItem[] = [];
  const miss: VideoItem[] = [];
  for (const it of items) {
    const its = (it.tags || []).map((t: string) => String(t).toLowerCase());
    (its.some((t) => wants.has(t)) ? hit : miss).push(it);
  }
  return [...hit, ...miss];
}

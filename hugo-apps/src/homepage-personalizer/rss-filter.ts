interface RssItem { title: string; link: string; categories?: string[]; [k: string]: any; }

export function applyRssFilter(items: RssItem[], tags: string[]): RssItem[] {
  if (!items?.length || !tags?.length) return items || [];
  const wants = new Set(tags.map((t) => t.toLowerCase()));
  const hit: RssItem[] = [];
  const miss: RssItem[] = [];
  for (const it of items) {
    const its = (it.categories || []).map((t: string) => String(t).toLowerCase());
    (its.some((t) => wants.has(t)) ? hit : miss).push(it);
  }
  return [...hit, ...miss];
}

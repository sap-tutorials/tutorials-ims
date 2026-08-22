export interface ClusterItem { kind: string; slug: string; title: string; href: string; isNew?: boolean; }

/**
 * Merge volatile items into SSR items with a reserve minimum.
 * Guarantees up to `reserve` volatile slots even when SSR fills the cap,
 * preventing starvation of blogs/videos/events in full SSR clusters.
 * Dedupes by kind+slug (SSR kept first), drops items with no href.
 */
export function mergeVolatile(ssr: ClusterItem[], volatile: ClusterItem[], cap: number, reserve = 3): ClusterItem[] {
  const seen = new Set(ssr.map(i => `${i.kind}:${i.slug}`));
  const freshVol: ClusterItem[] = [];
  for (const v of volatile) {
    const k = `${v.kind}:${v.slug}`;
    if (seen.has(k) || !v.href) continue;
    seen.add(k);
    freshVol.push(v);
  }
  const reserved = Math.min(freshVol.length, reserve);      // slots guaranteed to volatile
  const ssrShown = ssr.slice(0, Math.max(0, cap - reserved));
  const remaining = cap - ssrShown.length;                  // volatile fills what's left
  const volShown = freshVol.slice(0, remaining);
  return [...ssrShown, ...volShown];
}

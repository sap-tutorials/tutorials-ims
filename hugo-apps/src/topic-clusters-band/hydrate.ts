export interface ClusterItem { kind: string; slug: string; title: string; href: string; isNew?: boolean; }

/** Merge volatile items into SSR items: dedupe by kind+slug, keep SSR first, cap total. */
export function mergeVolatile(ssr: ClusterItem[], volatile: ClusterItem[], cap: number): ClusterItem[] {
  const seen = new Set(ssr.map(i => `${i.kind}:${i.slug}`));
  const merged = [...ssr];
  for (const v of volatile) {
    const k = `${v.kind}:${v.slug}`;
    if (seen.has(k) || !v.href) continue;
    seen.add(k);
    merged.push(v);
  }
  return merged.slice(0, cap);
}

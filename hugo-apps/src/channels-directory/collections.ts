export interface CollectionItem { url: string; name: string; blurb?: string; sortOrder?: number }
export interface Collection { slug: string; title: string; intro?: string; sortOrder?: number; items: CollectionItem[] }

// Only render collections that have at least one item; order by sortOrder.
export function visibleCollections(collections: Collection[] | undefined): Collection[] {
  return (collections || [])
    .filter((c) => Array.isArray(c.items) && c.items.length > 0)
    .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100));
}

// hugo-apps/src/shared/cards/categoryLabel.ts
//
// Resolves a category slug to its display label by reading the inlined
// browse-data JSON payload. Vue island consumers pass through this helper
// to keep the slug → label mapping in one place. For tests, an override
// map can be passed instead of touching the DOM.

interface CategoryMeta {
  slug: string
  label: string
}

let _cache: Map<string, string> | null = null

function readFromDom(): Map<string, string> {
  if (typeof document === 'undefined') return new Map()
  const el = document.getElementById('browse-data')
  if (!el?.textContent) return new Map()
  try {
    const data = JSON.parse(el.textContent) as { categories?: CategoryMeta[] }
    const m = new Map<string, string>()
    for (const c of data.categories ?? []) m.set(c.slug, c.label)
    return m
  } catch {
    return new Map()
  }
}

/** Test-only — clears the cache between tests. */
export function _resetCategoryLabelCache() {
  _cache = null
}

export function categoryLabel(slug: string, override?: Map<string, string>): string {
  if (override) return override.get(slug) ?? slug
  if (!_cache) _cache = readFromDom()
  return _cache.get(slug) ?? slug
}

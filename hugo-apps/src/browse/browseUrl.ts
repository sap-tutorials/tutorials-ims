// hugo-apps/src/browse/browseUrl.ts
//
// /browse/-only sort param. urlSync.ts (#195) handles every other URL
// dimension and intentionally preserves unknown params, so adding ?sort=
// here composes cleanly without touching the shared module.

export const SORTS = ['relevance', 'updated', 'recent', 'title', 'time'] as const
export type Sort = typeof SORTS[number]
export const DEFAULT_SORT: Sort = 'relevance'

export function isValidSort(v: string): v is Sort {
  return (SORTS as readonly string[]).includes(v)
}

export function readSort(href: string): Sort {
  const v = new URL(href).searchParams.get('sort') ?? ''
  return isValidSort(v) ? v : DEFAULT_SORT
}

export function writeSort(href: string, sort: Sort): string {
  const url = new URL(href)
  if (sort === DEFAULT_SORT) url.searchParams.delete('sort')
  else url.searchParams.set('sort', sort)
  return url.toString()
}

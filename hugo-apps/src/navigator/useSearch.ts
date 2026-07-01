import { ref, computed, watch, type Ref } from 'vue'
import type { CardItem, SearchableItem, SearchFacets, TutorialEntry } from '@shared/types'
import { requiresLicense } from '../shared/license'
import { NEW_WINDOW_MS } from '../shared/freshness'

interface UseSearchOptions {
  searchTerm: Ref<string>
  filterTypes: Ref<string[]>
  filterLevels: Ref<string[]>
  filterProducts: Ref<string[]>
  filterIsNew?: Ref<boolean>
  filterNoLicense?: Ref<boolean>
  tutorials?: Ref<TutorialEntry[]>
}

export function mapToCardItem(item: SearchableItem, tutorialsBySlug?: Map<string, TutorialEntry>): CardItem {
  const enriched = item.slug && tutorialsBySlug ? tutorialsBySlug.get(item.slug) : undefined
  return {
    type: item.taskType.toLowerCase() as 'mission' | 'group' | 'tutorial',
    id: item.ID,
    title: item.title,
    description: item.description ?? '',
    time: item.averageTimeToComplete ?? 0,
    level: item.experienceTag ?? 'beginner',
    tutorialCount: 1,
    primaryTag: item.primaryTag ?? '',
    displayTags: enriched?.displayTags?.length
      ? enriched.displayTags
      : ([item.primaryTag].filter(Boolean) as string[]),
    displayTagSlugs: enriched?.displayTagSlugs?.length
      ? enriched.displayTagSlugs
      : ([item.primaryTag].filter(Boolean) as string[]),
    href: item.slug ? `/tutorials/${item.slug}` : '',
    stepCount: 0,
  }
}

export const MIN_SEARCH_CHARS = 2

const escOData = (v: string) => v.replace(/'/g, "''")

// Build the `getFacets(...)` URL using OData V4 parameter aliases. Inline
// collection literals in a URL segment are `["a","b"]` (JSON array, double
// quotes), NOT the OData string-literal form `['a','b']` — the latter is a
// v2-era artifact that CAP's v4 parser rejects with HTTP 400
// `Invalid value: taskTypes`. Aliases keep the JSON payload out of the URL
// path, so URLSearchParams handles all encoding for us and single quotes in
// the search term don't need to be doubled twice (once for OData, once for
// URL). See issue #869.
export function buildFacetsUrl(term: string, taskTypes: string[], experience: string[]): string {
  const q = new URLSearchParams()
  q.set('@s', JSON.stringify(term))
  const params: string[] = ['search=@s']
  if (taskTypes.length) {
    q.set('@t', JSON.stringify(taskTypes.map(t => t.toUpperCase())))
    params.push('taskTypes=@t')
  }
  if (experience.length) {
    q.set('@e', JSON.stringify(experience))
    params.push('experience=@e')
  }
  return `/search/getFacets(${params.join(',')})?${q}`
}

export interface BuildFilterFlags {
  isNew: boolean
  isNewCutoffISO: string
}

export function buildFilter(
  types: string[],
  levels: string[],
  products: string[],
  flags: BuildFilterFlags = { isNew: false, isNewCutoffISO: '' }
): string {
  const parts: string[] = []

  if (types.length) {
    const typeFilter = types.map(t => `taskType eq '${escOData(t.toUpperCase())}'`).join(' or ')
    parts.push(types.length > 1 ? `(${typeFilter})` : typeFilter)
  }

  if (levels.length) {
    const levelFilter = levels.map(l => `experienceTag eq '${escOData(l)}'`).join(' or ')
    parts.push(levels.length > 1 ? `(${levelFilter})` : levelFilter)
  }

  if (products.length) {
    const prodFilter = products.map(p => `primaryTag eq '${escOData(p)}'`).join(' or ')
    parts.push(products.length > 1 ? `(${prodFilter})` : prodFilter)
  }

  if (flags.isNew && flags.isNewCutoffISO) {
    // OData v4 datetime literal — no quotes, no `datetime'…'` wrapper.
    parts.push(`createdAt gt ${flags.isNewCutoffISO}`)
  }

  return parts.join(' and ')
}

// Exported for unit testing. Strips license-tagged items from a CardItem
// page when the noLicense toggle is on. Pure function; no side effects.
export function postFilterNoLicense(items: CardItem[], noLicense: boolean): CardItem[] {
  if (!noLicense) return items
  return items.filter(item => !requiresLicense(item))
}

export function useSearch(options: UseSearchOptions) {
  const { searchTerm, filterTypes, filterLevels, filterProducts, filterIsNew, filterNoLicense, tutorials } = options

  const searchResults = ref<CardItem[]>([])
  const searchFacets = ref<SearchFacets | null>(null)
  const isSearching = ref(false)
  const searchError = ref<string | null>(null)
  const searchTotalCount = ref(0)

  const tutorialsBySlug = computed(() => {
    const m = new Map<string, TutorialEntry>()
    if (tutorials) for (const t of tutorials.value) if (t.slug) m.set(t.slug, t)
    return m
  })

  const searchMode = computed(() => searchTerm.value.length >= MIN_SEARCH_CHARS)
  const isSubThreshold = computed(() =>
    searchTerm.value.length > 0 && searchTerm.value.length < MIN_SEARCH_CHARS
  )

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  async function executeSearch(page = 0, pageSize = 48) {
    const term = searchTerm.value
    if (term.length < MIN_SEARCH_CHARS) return

    isSearching.value = true
    searchError.value = null

    try {
      const isNewFlag = filterIsNew?.value ?? false
      const noLicenseFlag = filterNoLicense?.value ?? false
      const isNewCutoffISO = isNewFlag
        ? new Date(Date.now() - NEW_WINDOW_MS).toISOString()
        : ''
      const filter = buildFilter(
        filterTypes.value,
        filterLevels.value,
        filterProducts.value,
        { isNew: isNewFlag, isNewCutoffISO },
      )
      const params = new URLSearchParams()
      params.set('$search', term)
      params.set('$top', String(pageSize))
      params.set('$skip', String(page * pageSize))
      params.set('$count', 'true')
      if (filter) params.set('$filter', filter)

      const [itemsRes, facetsRes] = await Promise.all([
        fetch(`/search/SearchableItems?${params}`),
        fetch(buildFacetsUrl(term, filterTypes.value, filterLevels.value)),
      ])

      if (!itemsRes.ok || !facetsRes.ok) {
        searchError.value = 'Search request failed'
        return
      }

      const itemsData = await itemsRes.json()
      const facetsData = await facetsRes.json()

      const cards = (itemsData.value ?? []).map((it: SearchableItem) =>
        mapToCardItem(it, tutorialsBySlug.value)
      )
      // Client-side post-filter for the No license toggle. Cheap on a
      // page of $top=48 — at most 48 rows pruned. Avoids a HANA fuzzy-search
      // anti-pattern (`tagBag NOT LIKE '%tutorial>license%'` would defeat
      // the indexed search column).
      searchResults.value = postFilterNoLicense(cards, noLicenseFlag)
      // searchTotalCount comes from the unfiltered server-side $count. When
      // No license is on, the count is a slight over-count (legacy AEM had
      // the same behavior — facet counts ignored the Options toggles).
      searchTotalCount.value = itemsData['@odata.count'] ?? 0
      searchFacets.value = facetsData
    } catch (e) {
      searchError.value = (e as Error).message
    } finally {
      isSearching.value = false
    }
  }

  function debouncedSearch() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => executeSearch(), 300)
  }

  watch(
    [searchTerm, filterTypes, filterLevels, filterProducts,
     computed(() => filterIsNew?.value ?? false),
     computed(() => filterNoLicense?.value ?? false)],
    () => {
    if (searchMode.value) {
      debouncedSearch()
    } else {
      searchResults.value = []
      searchFacets.value = null
      searchTotalCount.value = 0
    }
  })

  return {
    searchMode,
    isSubThreshold,
    searchResults,
    searchFacets,
    searchTotalCount,
    isSearching,
    searchError,
    executeSearch,
  }
}

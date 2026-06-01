import { ref, computed, watch, type Ref } from 'vue'
import type { CardItem, SearchableItem, SearchFacets, TutorialEntry } from '@shared/types'

interface UseSearchOptions {
  searchTerm: Ref<string>
  filterTypes: Ref<string[]>
  filterLevels: Ref<string[]>
  filterProducts: Ref<string[]>
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

function buildFilter(types: string[], levels: string[], products: string[]): string {
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

  return parts.join(' and ')
}

export function useSearch(options: UseSearchOptions) {
  const { searchTerm, filterTypes, filterLevels, filterProducts, tutorials } = options

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
      const filter = buildFilter(filterTypes.value, filterLevels.value, filterProducts.value)
      const params = new URLSearchParams()
      params.set('$search', term)
      params.set('$top', String(pageSize))
      params.set('$skip', String(page * pageSize))
      params.set('$count', 'true')
      if (filter) params.set('$filter', filter)

      const [itemsRes, facetsRes] = await Promise.all([
        fetch(`/search/SearchableItems?${params}`),
        fetch(`/search/getFacets(search='${escOData(term)}'${filterTypes.value.length ? `,taskTypes=[${filterTypes.value.map(t => `'${escOData(t.toUpperCase())}'`).join(',')}]` : ''}${filterLevels.value.length ? `,experience=[${filterLevels.value.map(e => `'${escOData(e)}'`).join(',')}]` : ''})`),
      ])

      if (!itemsRes.ok || !facetsRes.ok) {
        searchError.value = 'Search request failed'
        return
      }

      const itemsData = await itemsRes.json()
      const facetsData = await facetsRes.json()

      searchResults.value = (itemsData.value ?? []).map((it: SearchableItem) =>
        mapToCardItem(it, tutorialsBySlug.value)
      )
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

  watch([searchTerm, filterTypes, filterLevels, filterProducts], () => {
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

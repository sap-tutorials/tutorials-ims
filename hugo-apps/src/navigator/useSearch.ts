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

// Percent-encode a value for use in an OData query string. CANNOT use
// URLSearchParams here: it applies `application/x-www-form-urlencoded`
// (RFC 1866 §8.2.1) rules which encode space as `+`, but CAP's OData v4
// URL parser does NOT decode `+` back to space in `$search` or in a
// parenthesized function parameter — it treats it as a literal `+`
// character. That silently broke every multi-word query typed into the
// navigator search box: `cap handler` → `?$search=cap+handler` →
// tokenised as a single opaque `cap+handler` token → zero rows, even
// though `cap` alone returns the whole CAP catalogue. Same problem hits
// the getFacets alias @s='cap ' → literal `cap+` → zero matches.
// encodeURIComponent uses RFC 3986 percent-encoding (space → `%20`) which
// the parser handles correctly.
const encodeODataValue = (v: string) => encodeURIComponent(v)

// Build the `getFacets(...)` URL using OData V4 parameter aliases.
//
// Scalar-vs-array literal shapes differ, and CAP's v4 parser is strict:
//   - Scalar `String` params require the OData string-literal form
//     `'abap'` (single quotes, internal quotes doubled). JSON-quoted
//     `"abap"` is rejected with HTTP 400 `Expected ... a single quoted
//     string ... but "\"" found.` This is the regression behind #943;
//     the prior fix for #869 emitted JSON here and worked against the
//     older parser but broke when @sap/cds tightened.
//   - Array params (`taskTypes`, `experience`) accept JSON collection
//     literals: `["TUTORIAL"]` (double quotes). The v2-era OData form
//     `['TUTORIAL']` is still rejected.
//
// See issues #869 (initial fix) and #943 (regression + this fix), plus
// the note above encodeODataValue for the space-encoding gotcha.
export function buildFacetsUrl(term: string, taskTypes: string[], experience: string[]): string {
  const parts: string[] = ['search=@s']
  const query: string[] = [`@s=${encodeODataValue(`'${escOData(term)}'`)}`]
  if (taskTypes.length) {
    parts.push('taskTypes=@t')
    query.push(`@t=${encodeODataValue(JSON.stringify(taskTypes.map(t => t.toUpperCase())))}`)
  }
  if (experience.length) {
    parts.push('experience=@e')
    query.push(`@e=${encodeODataValue(JSON.stringify(experience))}`)
  }
  return `/search/getFacets(${parts.join(',')})?${query.join('&')}`
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
      // Hand-build the query string — see encodeODataValue above for why we
      // can't use URLSearchParams for $search (space→`+` breaks CAP's OData
      // v4 parser, `cap handler` → 0 rows).
      const qs: string[] = [
        `$search=${encodeODataValue(term)}`,
        `$top=${pageSize}`,
        `$skip=${page * pageSize}`,
        `$count=true`,
      ]
      if (filter) qs.push(`$filter=${encodeODataValue(filter)}`)

      const [itemsRes, facetsRes] = await Promise.all([
        fetch(`/search/SearchableItems?${qs.join('&')}`),
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

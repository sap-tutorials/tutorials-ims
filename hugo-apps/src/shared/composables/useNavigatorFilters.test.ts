// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref, nextTick, defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useNavigatorFilters } from './useNavigatorFilters'
import * as useSearchModule from '../../navigator/useSearch'
import type { CardItem, TutorialEntry } from '@shared/types'

const cards: CardItem[] = [
  { type: 'mission', id: 'm1', title: 'M1', description: '', time: 60, level: 'beginner', tutorialCount: 3, primaryTag: '', displayTags: [], displayTagSlugs: ['software-product>sap-build-apps'], href: '/x', stepCount: 6 },
  { type: 'tutorial', id: 't1', title: 'T1 cap', description: '', time: 30, level: 'beginner', tutorialCount: 1, primaryTag: '', displayTags: ['CAP'], displayTagSlugs: ['software-product>sap-cloud-application-programming-model'], href: '/x', stepCount: 3 },
  { type: 'tutorial', id: 't2', title: 'T2', description: '', time: 30, level: 'advanced', tutorialCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: ['software-product>sap-build-apps'], href: '/x', stepCount: 2 },
]

describe('useNavigatorFilters', () => {
  it('returns all cards when no filters active', () => {
    const allCards = ref(cards)
    const { displayedItems } = useNavigatorFilters({ allCards, syncURL: false })
    expect(displayedItems.value.length).toBe(3)
  })

  it('filters by type', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.types = ['mission']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['m1'])
  })

  it('filters by level (case-insensitive on read)', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.levels = ['advanced']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t2'])
  })

  it('filters by product slug', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.products = ['software-product>sap-cloud-application-programming-model']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1'])
  })

  it('search "cap" matches title containing cap', async () => {
    // With no `tutorials` ref provided, server search isn't usable so the
    // composable falls back to client-side filteredItems for query matching.
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.searchQuery.value = 'cap'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1'])
  })

  it('clearFilters resets every dimension and currentPage to 1', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.types = ['mission']
    f.searchQuery.value = 'foo'
    f.currentPage.value = 3
    f.clearFilters()
    await nextTick()
    expect(f.filters.types).toEqual([])
    expect(f.searchQuery.value).toBe('')
    expect(f.currentPage.value).toBe(1)
    expect(f.displayedItems.value.length).toBe(3)
  })

  it('hasActiveFilters reflects any non-default state', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    expect(f.hasActiveFilters.value).toBe(false)
    f.filters.types = ['mission']
    expect(f.hasActiveFilters.value).toBe(true)
    f.clearFilters()
    expect(f.hasActiveFilters.value).toBe(false)
  })

  it('sort=recent orders by createdAt desc when enableSort=true and items have createdAt', async () => {
    const dated: CardItem[] = [
      { ...cards[0], id: 'old', createdAt: '2024-01-01T00:00:00Z' },
      { ...cards[1], id: 'new', createdAt: '2026-01-01T00:00:00Z' },
    ]
    const allCards = ref(dated)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.sort!.value = 'recent'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['new', 'old'])
  })

  it('sort=updated orders by updatedAt desc', async () => {
    const dated: CardItem[] = [
      { ...cards[0], id: 'old', updatedAt: '2024-06-01T00:00:00Z' },
      { ...cards[1], id: 'new', updatedAt: '2026-06-01T00:00:00Z' },
      { ...cards[2], id: 'mid', updatedAt: '2025-06-01T00:00:00Z' },
    ]
    const allCards = ref(dated)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.sort!.value = 'updated'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['new', 'mid', 'old'])
  })

  it('sort=title orders alphabetically', async () => {
    const titled: CardItem[] = [
      { ...cards[0], id: 'c', title: 'Charlie' },
      { ...cards[1], id: 'a', title: 'Alpha' },
      { ...cards[2], id: 'b', title: 'Bravo' },
    ]
    const allCards = ref(titled)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.sort!.value = 'title'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('sort=time orders by time-to-complete ascending (short first)', async () => {
    const timed: CardItem[] = [
      { ...cards[0], id: 'long', time: 240 },
      { ...cards[1], id: 'short', time: 30 },
      { ...cards[2], id: 'medium', time: 90 },
    ]
    const allCards = ref(timed)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.sort!.value = 'time'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['short', 'medium', 'long'])
  })

  it('sort=relevance is a no-op (preserves filteredItems order)', async () => {
    // Default 'relevance' uses comparator () => 0, so the input order
    // (filteredItems pipeline output) survives untouched. Important: changing
    // this contract would silently break any consumer that relies on
    // cap-search's relevance ordering being preserved.
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    // sort defaults to 'relevance'; without setting it, the items should
    // be in the same order as `cards`.
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['m1', 't1', 't2'])
    // Explicit relevance after a change should also be identity.
    f.sort!.value = 'title'
    await nextTick()
    f.sort!.value = 'relevance'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['m1', 't1', 't2'])
  })

  it('sort works alongside filters (sort applied to filtered subset)', async () => {
    const both: CardItem[] = [
      { ...cards[0], id: 'm1', title: 'Mission Bravo' },
      { ...cards[1], id: 't1', title: 'Tutorial Alpha' },
      { ...cards[2], id: 't2', title: 'Tutorial Charlie' },
    ]
    const allCards = ref(both)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.filters.types = ['tutorial']    // narrow to t1, t2
    f.sort!.value = 'title'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1', 't2'])  // Alpha, Charlie
  })

  it('sort is undefined when enableSort=false (default)', () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    expect(f.sort).toBeUndefined()
  })
})

// Product-facet fixtures (#1594): two DISTINCT tag slugs render the SAME
// human label. Mirrors the live PROD collision where
// `products>mobile-development-kit-client` (1 tutorial) and
// `software-product>mobile-development-kit-client` (34 tutorials) both
// humanize to "Mobile Development Kit Client", surfacing as two checkboxes.
const dupLabelTutorials: TutorialEntry[] = [
  {
    slug: 'mdk-a', title: 'MDK A', description: '', time: 30, level: 'beginner',
    stepCount: 3, primaryTag: 'software-product>mobile-development-kit-client',
    displayTags: ['Mobile Development Kit Client', 'SAP HANA'],
    displayTagSlugs: ['software-product>mobile-development-kit-client', 'software-product>sap-hana'],
    prev: null, next: null,
  },
  {
    slug: 'mdk-b', title: 'MDK B', description: '', time: 30, level: 'beginner',
    stepCount: 3, primaryTag: 'products>mobile-development-kit-client',
    displayTags: ['Mobile Development Kit Client'],
    displayTagSlugs: ['products>mobile-development-kit-client'],
    prev: null, next: null,
  },
  {
    slug: 'hana-only', title: 'HANA only', description: '', time: 30, level: 'beginner',
    stepCount: 3, primaryTag: 'software-product>sap-hana',
    displayTags: ['SAP HANA'], displayTagSlugs: ['software-product>sap-hana'],
    prev: null, next: null,
  },
]

const dupLabelCards: CardItem[] = dupLabelTutorials.map(t => ({
  type: 'tutorial', id: t.slug, title: t.title, description: '', time: t.time,
  level: t.level, tutorialCount: 1, primaryTag: t.primaryTag,
  displayTags: t.displayTags, displayTagSlugs: t.displayTagSlugs,
  href: `/tutorials/${t.slug}`, stepCount: t.stepCount,
}))

describe('useNavigatorFilters — product facet merge (#1594)', () => {
  it('merges distinct slugs sharing one label into a single facet entry', () => {
    const allCards = ref(dupLabelCards)
    const tutorials = ref(dupLabelTutorials)
    const f = useNavigatorFilters({ allCards, tutorials, syncURL: false })
    const mdk = f.filteredProducts.value.filter(p => p.label === 'Mobile Development Kit Client')
    expect(mdk).toHaveLength(1)
    expect([...mdk[0].slugs].sort()).toEqual([
      'products>mobile-development-kit-client',
      'software-product>mobile-development-kit-client',
    ])
  })

  it('toggleProduct selects ALL member slugs and matches tutorials tagged with either', async () => {
    const allCards = ref(dupLabelCards)
    const tutorials = ref(dupLabelTutorials)
    const f = useNavigatorFilters({ allCards, tutorials, syncURL: false })
    const mdk = f.filteredProducts.value.find(p => p.label === 'Mobile Development Kit Client')!
    f.toggleProduct(mdk.slugs)
    await nextTick()
    // Both MDK tutorials match (one via software-product>, one via products>).
    expect(f.displayedItems.value.map(c => c.id).sort()).toEqual(['mdk-a', 'mdk-b'])
    expect(f.isProductSelected(mdk.slugs)).toBe(true)
  })

  it('toggleProduct is a full-group deselect', async () => {
    const allCards = ref(dupLabelCards)
    const tutorials = ref(dupLabelTutorials)
    const f = useNavigatorFilters({ allCards, tutorials, syncURL: false })
    const mdk = f.filteredProducts.value.find(p => p.label === 'Mobile Development Kit Client')!
    f.toggleProduct(mdk.slugs)
    await nextTick()
    f.toggleProduct(mdk.slugs)
    await nextTick()
    expect(f.filters.products).toEqual([])
    expect(f.displayedItems.value).toHaveLength(3)
  })

  it('isProductSelected is false when only some member slugs are present (deep-link seed)', () => {
    const allCards = ref(dupLabelCards)
    const tutorials = ref(dupLabelTutorials)
    const f = useNavigatorFilters({ allCards, tutorials, syncURL: false })
    f.filters.products = ['products>mobile-development-kit-client']
    const mdk = f.filteredProducts.value.find(p => p.label === 'Mobile Development Kit Client')!
    expect(f.isProductSelected(mdk.slugs)).toBe(false)
  })
})

describe('useNavigatorFilters — #1804: product deep-link matches the full label union', () => {
  // A tutorial-page chip emits ONE raw slug (e.g. ?tag=products>…), so a
  // deep-link seeds only that single variant into filters.products. The
  // manual facet, by contrast, merges by label (#1594) and filters on the
  // UNION of every variant slug. Before this fix the deep-link exact-matched
  // only its own variant — so clicking the "Mobile Development Kit Client"
  // chip on a tutorial tagged `products>…` showed only that tutorial and hid
  // the 34 tagged `software-product>…` ("product not filtering correctly",
  // #1804). Filtering must resolve product slugs by label so a deep-link
  // matches the same union the facet does.
  it('a single member slug (deep-link) matches every tutorial sharing its product label', async () => {
    const allCards = ref(dupLabelCards)
    const tutorials = ref(dupLabelTutorials)
    const f = useNavigatorFilters({ allCards, tutorials, syncURL: false })
    f.filters.products = ['products>mobile-development-kit-client']
    await nextTick()
    // Both MDK tutorials show — the one tagged products> AND the one tagged
    // software-product> — matching the manual-facet union, NOT just mdk-b.
    expect(f.displayedItems.value.map(c => c.id).sort()).toEqual(['mdk-a', 'mdk-b'])
  })

  it('does not widen matches to unrelated products sharing no label', async () => {
    const allCards = ref(dupLabelCards)
    const tutorials = ref(dupLabelTutorials)
    const f = useNavigatorFilters({ allCards, tutorials, syncURL: false })
    f.filters.products = ['products>mobile-development-kit-client']
    await nextTick()
    // The HANA-only tutorial must NOT appear — its label ("SAP HANA") differs.
    expect(f.displayedItems.value.map(c => c.id)).not.toContain('hana-only')
  })

  it('falls back to exact-slug match when no tutorials list is supplied', async () => {
    // /browse/ mounts may not pass `tutorials`; with no label map the product
    // filter must degrade to the pre-fix exact-slug behaviour (no crash, no
    // over-broad match).
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.products = ['software-product>sap-cloud-application-programming-model']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1'])
  })
})

describe('endpoint base forwarding', () => {
  it('defaults navBase to /tutorials when not supplied', () => {
    const r = useNavigatorFilters({ allCards: ref([]) })
    expect(r.navBase).toBe('/tutorials')
  })

  it('exposes a supplied navBase', () => {
    const r = useNavigatorFilters({ allCards: ref([]), navBase: '/tutorials-qa' })
    expect(r.navBase).toBe('/tutorials-qa')
  })

  it('forwards searchBase and hrefBase to useSearch with defaults', () => {
    const useSearchSpy = vi.spyOn(useSearchModule, 'useSearch').mockReturnValue({
      searchMode: ref(false),
      isSubThreshold: ref(false),
      searchResults: ref([]),
      searchFacets: ref(null),
      searchTotalCount: ref(0),
      isSearching: ref(false),
      searchError: ref(null),
    })

    useNavigatorFilters({ allCards: ref([]), syncURL: false })

    // Verify useSearch was called with default values
    expect(useSearchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        searchBase: '/search',
        hrefBase: '/tutorials',
      })
    )

    useSearchSpy.mockRestore()
  })

  it('forwards custom searchBase and hrefBase to useSearch', () => {
    const useSearchSpy = vi.spyOn(useSearchModule, 'useSearch').mockReturnValue({
      searchMode: ref(false),
      isSubThreshold: ref(false),
      searchResults: ref([]),
      searchFacets: ref(null),
      searchTotalCount: ref(0),
      isSearching: ref(false),
      searchError: ref(null),
    })

    useNavigatorFilters({
      allCards: ref([]),
      searchBase: '/qa-search',
      hrefBase: '/tutorials-qa',
      syncURL: false,
    })

    // Verify useSearch was called with custom values
    expect(useSearchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        searchBase: '/qa-search',
        hrefBase: '/tutorials-qa',
      })
    )

    useSearchSpy.mockRestore()
  })
})

describe('useNavigatorFilters — clientSearch (#1939, QA channel)', () => {
  // A sentinel that only the SERVER path would surface — it is NOT in allCards,
  // so its presence/absence proves which path displayedItems took.
  const serverSentinel: CardItem = {
    type: 'tutorial', id: 'server-only', title: 'ServerOnly', description: '',
    time: 0, level: 'beginner', tutorialCount: 1, primaryTag: '',
    displayTags: [], displayTagSlugs: [], href: '/tutorials/server-only', stepCount: 0,
  }
  const tutorials = ref<TutorialEntry[]>([
    { slug: 't1', title: 'T1 cap', description: '', time: 30, level: 'beginner', stepCount: 3,
      primaryTag: '', displayTags: ['CAP'], displayTagSlugs: ['software-product>sap-cloud-application-programming-model'], prev: null, next: null },
  ])

  function mockServerSearch() {
    return vi.spyOn(useSearchModule, 'useSearch').mockReturnValue({
      searchMode: ref(true),
      isSubThreshold: ref(false),
      searchResults: ref([serverSentinel]),
      searchFacets: ref({ totalCount: 1, typeCounts: [{ name: 'TUTORIAL', count: 999 }], experienceCounts: [], tagCounts: [] }),
      searchTotalCount: ref(999),
      isSearching: ref(false),
      searchError: ref(null),
    } as unknown as ReturnType<typeof useSearchModule.useSearch>)
  }

  it('clientSearch=true uses client-filtered allCards, NOT server results', async () => {
    const spy = mockServerSearch()
    try {
      const allCards = ref(cards)
      const f = useNavigatorFilters({ allCards, tutorials, syncURL: false, clientSearch: true })
      f.searchQuery.value = 'cap'
      await nextTick()
      // 'cap' matches T1's title client-side; the server sentinel is absent.
      expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1'])
      // Counts come from the client filter, not the server facet (999).
      expect(f.displayedCounts.value.tutorials).toBe(1)
      expect(f.displayedTotalCount.value).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('clientSearch=false (default) uses server results when tutorials provided', async () => {
    const spy = mockServerSearch()
    try {
      const allCards = ref(cards)
      const f = useNavigatorFilters({ allCards, tutorials, syncURL: false })
      f.searchQuery.value = 'cap'
      await nextTick()
      // Server path wins: the sentinel is surfaced and counts are the facet's.
      expect(f.displayedItems.value.map(c => c.id)).toEqual(['server-only'])
      expect(f.displayedCounts.value.tutorials).toBe(999)
      expect(f.displayedTotalCount.value).toBe(999)
    } finally {
      spy.mockRestore()
    }
  })

  it('forwards enabled=!clientSearch to useSearch', () => {
    const spy = vi.spyOn(useSearchModule, 'useSearch').mockReturnValue({
      searchMode: ref(false), isSubThreshold: ref(false), searchResults: ref([]),
      searchFacets: ref(null), searchTotalCount: ref(0), isSearching: ref(false), searchError: ref(null),
    } as unknown as ReturnType<typeof useSearchModule.useSearch>)
    try {
      useNavigatorFilters({ allCards: ref([]), syncURL: false, clientSearch: true })
      const arg = spy.mock.calls[0][0] as { enabled: { value: boolean } }
      expect(arg.enabled.value).toBe(false)

      spy.mockClear()
      useNavigatorFilters({ allCards: ref([]), syncURL: false })
      const arg2 = spy.mock.calls[0][0] as { enabled: { value: boolean } }
      expect(arg2.enabled.value).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('useNavigatorFilters — #1804: experience-level slugs never filter as products', () => {
  // Repro cards: two beginner tutorials (one CAP, one not) + one advanced CAP.
  // The CAP slug is the software-product-FUNCTION form from the issue URL, and
  // every beginner tutorial carries `tutorial>beginner` in displayTagSlugs.
  const capBeginner: CardItem = {
    type: 'tutorial', id: 'cap-beginner', title: 'CAP Beginner', description: '', time: 30,
    level: 'beginner', tutorialCount: 1, primaryTag: '', displayTags: ['CAP', 'Beginner'],
    displayTagSlugs: ['software-product-function>sap-cloud-application-programming-model', 'tutorial>beginner'],
    href: '/x', stepCount: 3,
  }
  const otherBeginner: CardItem = {
    type: 'tutorial', id: 'other-beginner', title: 'HANA Beginner', description: '', time: 30,
    level: 'beginner', tutorialCount: 1, primaryTag: '', displayTags: ['SAP HANA', 'Beginner'],
    displayTagSlugs: ['software-product>sap-hana', 'tutorial>beginner'],
    href: '/x', stepCount: 3,
  }
  const capAdvanced: CardItem = {
    type: 'tutorial', id: 'cap-advanced', title: 'CAP Advanced', description: '', time: 30,
    level: 'advanced', tutorialCount: 1, primaryTag: '', displayTags: ['CAP', 'Advanced'],
    displayTagSlugs: ['software-product-function>sap-cloud-application-programming-model', 'tutorial>advanced'],
    href: '/x', stepCount: 3,
  }
  const cards: CardItem[] = [capBeginner, otherBeginner, capAdvanced]

  type Api = ReturnType<typeof useNavigatorFilters>

  beforeEach(() => {
    try { localStorage.clear() } catch { /* happy-dom always has it */ }
    window.history.replaceState({}, '', '/')
  })

  async function mountNavigator(url: string): Promise<Api> {
    window.history.replaceState({}, '', url)
    let api!: Api
    const Harness = defineComponent({
      setup() {
        const allCards = ref(cards)
        api = useNavigatorFilters({ allCards, syncURL: true })
        return () => h('div')
      },
    })
    mount(Harness)
    // onMounted seeds + routes synchronously, then awaits nextTick before
    // restoring the page. Flush two ticks so all reactive writes settle.
    await nextTick()
    await nextTick()
    return api
  }

  it('routes ?product=…,tutorial>beginner into Experience so only CAP-beginner shows', async () => {
    const api = await mountNavigator(
      '/tutorial-navigator/?product=software-product-function%3Esap-cloud-application-programming-model%2Ctutorial%3Ebeginner',
    )
    expect(api.filters.products).toEqual(['software-product-function>sap-cloud-application-programming-model'])
    expect(api.filters.levels).toContain('beginner')
    // Without the fix, `tutorial>beginner` OR-matches otherBeginner too → the
    // list balloons to every beginner tutorial ("nothing filtered").
    expect(api.displayedItems.value.map(c => c.id)).toEqual(['cap-beginner'])
  })

  it('routes a ?tag=tutorial>beginner chip into Experience, not Software Product', async () => {
    const api = await mountNavigator(
      '/tutorial-navigator/?tag=software-product-function%3Esap-cloud-application-programming-model&tag=tutorial%3Ebeginner',
    )
    expect(api.filters.products).toEqual(['software-product-function>sap-cloud-application-programming-model'])
    expect(api.filters.levels).toContain('beginner')
    expect(api.displayedItems.value.map(c => c.id)).toEqual(['cap-beginner'])
  })

  it('heals poisoned localStorage (tutorial>beginner persisted under products)', async () => {
    localStorage.setItem('navigator.filters.v1', JSON.stringify({ products: ['tutorial>beginner'] }))
    const api = await mountNavigator('/tutorial-navigator/')
    expect(api.filters.products).toEqual([])
    expect(api.filters.levels).toContain('beginner')
  })
})

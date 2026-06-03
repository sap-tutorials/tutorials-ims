// hugo-apps/src/shared/composables/useNavigatorFilters.ts
//
// Reactive filter state + URL sync + filtering pipeline + pagination +
// optional sort, all in one composable. Accepts allCards as a ref so both
// `/` (CSR `/build/navigator` fetch) and `/browse/` (SSR-injected list)
// can consume it. URL sync delegates to urlSync.ts; sort is opt-in via
// `enableSort`.
//
// Extracted verbatim from hugo-apps/src/navigator/TutorialNavigator.vue.
// See spec at docs/superpowers/specs/2026-06-02-issue-174-browse-extract-pr1.md.

import {
  ref, reactive, computed, watch, nextTick, onMounted, onScopeDispose,
  type Ref,
} from 'vue'
import { useSearch } from '../../navigator/useSearch'
import {
  parseNavState, writeNavStateToWindow, EMPTY_STATE, type NavState,
} from '../../navigator/urlSync'
import { parseTagParams, parseLevelParams } from '../../navigator/url-params'
import { isWithinNewWindow } from '../freshness'
import { requiresLicense, LICENSE_SLUG } from '../license'
import type { CardItem, TutorialEntry } from '@shared/types'

export type Sort = 'relevance' | 'updated' | 'recent' | 'title' | 'time'

export interface UseNavigatorFiltersOptions {
  allCards: Ref<CardItem[]>
  tutorials?: Ref<TutorialEntry[]>
  enableSort?: boolean
  syncURL?: boolean
  pageSize?: number
}

const SORT_COMPARATORS: Record<Sort, (a: CardItem, b: CardItem) => number> = {
  relevance: () => 0,
  updated:   (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  recent:    (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
  title:     (a, b) => a.title.localeCompare(b.title),
  time:      (a, b) => (a.time ?? 0) - (b.time ?? 0),
}

// Verbatim copy from TutorialNavigator.vue. Slug → topic-bucket map used
// by `availableTopics`, `tutorialMatchesTopic`, and the topics filter.
const PRODUCT_TO_TOPICS: Record<string, string[]> = {
  // Slug-keyed entries (from HANA tag data):
  'software-product-function>sap-cloud-application-programming-model': ['Application Development', 'Cloud'],
  'software-product>sap-cloud-application-programming-model': ['Application Development', 'Cloud'],
  'software-product>sap-build-code': ['Application Development', 'Development Tools'],
  'programming-tool>node-js': ['Application Development'],
  'programming-tool>java': ['Application Development'],
  'topic>java': ['Application Development'],
  'programming-tool>javascript': ['Application Development'],
  'topic>javascript': ['Application Development'],
  'programming-tool>python': ['Application Development'],
  'topic>python': ['Application Development'],
  'programming-tool>odata': ['Application Development'],
  'topic>odata': ['Application Development'],
  'topic>artificial-intelligence': ['Artificial Intelligence'],
  'topic>machine-learning': ['Artificial Intelligence'],
  'software-product>sap-ai-core': ['Artificial Intelligence', 'Cloud'],
  'software-product>sap-ai-launchpad': ['Artificial Intelligence'],
  'software-product>sap-ai-services': ['Artificial Intelligence'],
  'products>sap-conversational-ai': ['Artificial Intelligence'],
  'software-product>sap-conversational-ai': ['Artificial Intelligence'],
  'software-product>sap-document-ai': ['Artificial Intelligence'],
  'software-product>data-attribute-recommendation': ['Artificial Intelligence'],
  'software-product>business-entity-recognition': ['Artificial Intelligence'],
  'software-product>service-ticket-intelligence': ['Artificial Intelligence'],
  'software-product>personalized-recommendation': ['Artificial Intelligence'],
  'software-product>document-information-extraction': ['Artificial Intelligence'],
  'products>sap-analytics-cloud': ['Analytics'],
  'software-product>sap-analytics-cloud': ['Analytics'],
  'software-product-function>sap-analytics-cloud-for-planning': ['Analytics'],
  'software-product>sap-datasphere': ['Analytics', 'Database & Data Management'],
  'topic>big-data': ['Analytics', 'Database & Data Management'],
  'software-product>analytics': ['Analytics'],
  'software-product>sap-signavio-process-intelligence': ['Analytics', 'Automation'],
  'software-product>sap-build-process-automation': ['Automation'],
  'software-product>sap-build': ['Automation', 'Application Development'],
  'software-product>sap-build-apps': ['Automation', 'Application Development'],
  'products>sap-workflow': ['Automation'],
  'products>sap-workflow-management': ['Automation'],
  'products>business-rules': ['Automation'],
  'software-product>sap-intelligent-robotic-process-automation': ['Automation'],
  'software-product-function>sap-automation-pilot': ['Automation', 'Cloud'],
  'software-product>sap-automation-pilot': ['Automation', 'Cloud'],
  'topic>cloud': ['Cloud'],
  'products>sap-business-technology-platform': ['Cloud'],
  'sap-conversational-ai>sap-business-technology-platform': ['Cloud'],
  'sbpa workflows software-product>sap-business-technology-platform': ['Cloud'],
  'software-product-function>sap-business-technology-platform': ['Cloud'],
  'software-product>sap-business-technology-platform': ['Cloud'],
  'software-product>technology-platform>sap-business-technology-platform': ['Cloud'],
  'topic>cloud; software-product>sap-business-technology-platform': ['Cloud'],
  'products>sap-btp-cloud-foundry-environment': ['Cloud'],
  'software-product>sap-btp-cloud-foundry-environment': ['Cloud'],
  'software-product-function>sap-btp-cockpit': ['Cloud'],
  'software-product-function>sap-btp-command-line-interface': ['Cloud', 'Development Tools'],
  'products>sap-cloud-platform': ['Cloud'],
  'products>sap-cloud-platform-for-the-cloud-foundry-environment': ['Cloud'],
  'topic>cloud-operations': ['Cloud'],
  'products>sap-hana': ['Database & Data Management'],
  'sap-conversational-ai>sap-hana': ['Database & Data Management'],
  'software-product>sap-hana': ['Database & Data Management'],
  'products>sap-hana-cloud': ['Database & Data Management', 'Cloud'],
  'software-product>sap-hana-cloud': ['Database & Data Management', 'Cloud'],
  'software-product>technology-platform>sap-hana-cloud': ['Database & Data Management', 'Cloud'],
  'products>sap-hana-cloud-data-lake': ['Database & Data Management', 'Cloud'],
  'products>sap-hana-dynamic-tiering': ['Database & Data Management'],
  'products>sap-hana-streaming-analytics': ['Database & Data Management'],
  'software-product-function>sap-hana-spatial': ['Database & Data Management'],
  'software-product-function>sap-hana-multi-model-processing': ['Database & Data Management'],
  'software-product-function>sap-hana-graph': ['Database & Data Management'],
  'products>sap-hana-studio': ['Database & Data Management', 'Development Tools'],
  'products>sap-hana-service-for-sap-btp': ['Database & Data Management', 'Cloud'],
  'software-product>sap-hana-service-for-sap-btp': ['Database & Data Management', 'Cloud'],
  'programming-tool>sql': ['Database & Data Management'],
  'topic>sql': ['Database & Data Management'],
  'products>sap-data-intelligence': ['Database & Data Management'],
  'software-product>sap-iq': ['Database & Data Management'],
  'software-product-function>sap-adaptive-server-enterprise': ['Database & Data Management'],
  'products>sap-business-application-studio': ['Development Tools'],
  'software-product-function>sap-business-application-studio': ['Development Tools'],
  'software-product>sap-business-application-studio': ['Development Tools'],
  'software-products>sap-business-application-studio': ['Development Tools'],
  'products>sap-web-ide': ['Development Tools'],
  'software-product>sap-web-ide': ['Development Tools'],
  'products>sap-fiori-tools': ['Development Tools', 'SAP Fiori'],
  'software-product-function>sap-fiori-tools': ['Development Tools', 'SAP Fiori'],
  'software-product>sap-fiori-tools': ['Development Tools', 'SAP Fiori'],
  'software-product>sap-cloud-transport-management': ['Development Tools', 'Cloud'],
  'software-product>sap-content-agent-service': ['Development Tools', 'Cloud'],
  'products>sap-integration-suite': ['Extension & Integration'],
  'sap-conversational-ai>sap-integration-suite': ['Extension & Integration'],
  'software-product>sap-integration-suite': ['Extension & Integration'],
  'software-product>cloud-integration': ['Extension & Integration', 'Cloud'],
  'topic>integration': ['Extension & Integration'],
  'software-product>sap-process-integration': ['Extension & Integration'],
  'software-product>sap-process-orchestration': ['Extension & Integration'],
  'products>sap-application-interface-framework': ['Extension & Integration'],
  'software-product>sap-application-interface-framework': ['Extension & Integration'],
  'software-product>sap-event-mesh': ['Extension & Integration', 'Cloud'],
  'software-product>sap-connectivity-service': ['Extension & Integration', 'Cloud'],
  'software-product>sap-cloud-platform-connectivity': ['Extension & Integration', 'Cloud'],
  'software-product-function>sap-private-link-service': ['Extension & Integration', 'Cloud'],
  'products>sap-api-management': ['Extension & Integration'],
  'software-product>sap-api-management': ['Extension & Integration'],
  'products>api-management': ['Extension & Integration'],
  'topic>sap-api-business-hub': ['Extension & Integration'],
  'topic>api': ['Extension & Integration'],
  'software-product>sap-concur': ['Extension & Integration'],
  'topic>mobile': ['Mobile'],
  'products>sap-mobile-services': ['Mobile', 'Cloud'],
  'software-product>sap-mobile-services': ['Mobile', 'Cloud'],
  'products>mobile-development-kit-client': ['Mobile'],
  'software-product>mobile-development-kit-client': ['Mobile'],
  'operating-system>android': ['Mobile'],
  'products>sap-fiori': ['SAP Fiori'],
  'software-product-function>sap-fiori': ['SAP Fiori'],
  'software-product>sap-fiori': ['SAP Fiori'],
  'products>sap-fiori-elements': ['SAP Fiori'],
  'software-product-function>sap-fiori-elements': ['SAP Fiori'],
  'programming-tool>sapui5': ['SAP Fiori'],
  'software-product>sap-s-4hana; topic>google workspace; topic>sapui5': ['SAP Fiori'],
  'software-product>sapui5': ['SAP Fiori'],
  'topic>sapui5': ['SAP Fiori'],
  'topic>user-interface': ['SAP Fiori'],
  'software-product>ui-theme-designer': ['SAP Fiori'],
  'products>sap-screen-personas': ['SAP Fiori'],
  'software-product>sap-screen-personas': ['SAP Fiori'],
  'software-product>sap-launchpad-service': ['SAP Fiori', 'Cloud'],
  'software-product>sap-work-zone': ['SAP Fiori', 'Cloud'],
  'products>sap-s-4hana': ['SAP S/4HANA'],
  'software-product>sap-s-4hana': ['SAP S/4HANA'],
  'software-product>sap-s-4hana-cloud': ['SAP S/4HANA', 'Cloud'],
  'software-product>sap-s-4hana-cloud-public-edition': ['SAP S/4HANA', 'Cloud'],
  'software-product>sap-s-4hana-cloud-front-end': ['SAP S/4HANA', 'SAP Fiori'],
  'software-product>sap-s/4hana': ['SAP S/4HANA'],
  'software-product>sap-netweaver': ['SAP S/4HANA'],
  'software-product>sap-netweaver-7.5': ['SAP S/4HANA'],
  'products>sap-gateway': ['SAP S/4HANA', 'Extension & Integration'],
  'topic>security': ['Security'],
  'products>identity-authentication': ['Security', 'Cloud'],
  'software-product>identity-authentication': ['Security', 'Cloud'],
  'software-product>sap-alert-notification-service-for-sap-btp': ['Security', 'Cloud'],
  'topic>internet-of-things': ['IoT'],
  'software-product>sap-successfactors-hxm-suite': ['SAP SuccessFactors'],
  'software-product>sap-successfactors-hcm-suite': ['SAP SuccessFactors'],
  'software-product>sap-document-management-service': ['Extension & Integration'],
  'products>sap-translation-hub': ['Development Tools'],
  'software-product>sap-translation-hub': ['Development Tools'],

  // Legacy label-keyed entries (no matching HANA slug found, kept for safety):
  'ABAP Development': ['ABAP'],
  'ABAP Extensibility': ['ABAP', 'Extension & Integration'],
  'ABAP Platform': ['ABAP'],
  'ABAP Connectivity': ['ABAP', 'Extension & Integration'],
  'SAP BTP ABAP Environment': ['ABAP', 'Cloud'],
  'SAP S 4hana Cloud ABAP Environment': ['ABAP', 'SAP S/4HANA'],
  'S 4hana Cloud ABAP Environment': ['ABAP', 'SAP S/4HANA'],
  'HTML5': ['Application Development'],
  'SAP Analytics Cloud Analytics Designer': ['Analytics'],
  'SAP Build Apps Enterprise Edition': ['Automation', 'Application Development'],
  'SAP BTP Cloud Foundry Runtime And Environment': ['Cloud'],
  'SAP BTP Kyma Runtime': ['Cloud'],
  'SAP Btp, Kyma Runtime': ['Cloud'],
  'Free Tier': ['Cloud'],
  'SAP CAP Operator Kubernetes Environment': ['Cloud'],
  'SAP HANA Database': ['Database & Data Management'],
  'SAP HANA Cloud SAP HANA Database': ['Database & Data Management', 'Cloud'],
  'SAP HANA Cloud, SAP HANA Database': ['Database & Data Management', 'Cloud'],
  'SAP HANA Cloud, Data Lake': ['Database & Data Management', 'Cloud'],
  'Data Lake': ['Database & Data Management'],
  'SAP HANA Express Edition': ['Database & Data Management'],
  'SAP Hana, Express Edition': ['Database & Data Management'],
  'Express Edition': ['Database & Data Management'],
  'SAP HANA Service': ['Database & Data Management', 'Cloud'],
  'SAP Cloud Platform, SAP HANA Service': ['Database & Data Management', 'Cloud'],
  'SAP Cloud Sdk': ['Development Tools', 'Application Development'],
  'DirectProcess Adapter': ['Extension & Integration'],
  'SAP Kafka Connect': ['Extension & Integration'],
  'SAP BTP Sdk For Android': ['Mobile', 'Development Tools'],
  'SAP BTP Sdk For iOS': ['Mobile', 'Development Tools'],
  'Ios': ['Mobile'],
  'Ios Sdk For SAP BTP': ['Mobile', 'Development Tools'],
  'SAPUI5': ['SAP Fiori'],
  'UI SAP Business Client Nwbc': ['SAP Fiori'],
  'SAP Build Work Zone Standard Edition': ['SAP Fiori', 'Cloud'],
  'SAP Build Work Zone Advanced Edition': ['SAP Fiori', 'Cloud'],
  'Document Management Service': ['Extension & Integration'],
}

export function useNavigatorFilters(opts: UseNavigatorFiltersOptions) {
  const {
    allCards,
    tutorials,
    enableSort = false,
    syncURL = true,
    pageSize = 48,
  } = opts

  // ─── Reactive filter state ───
  const searchQuery   = ref('')
  const productSearch = ref('')
  const topicSearch   = ref('')
  const currentPage   = ref(1)
  const sort          = ref<Sort>('relevance')

  const filters = reactive({
    levels: [] as string[],
    types: [] as string[],
    products: [] as string[],
    topics: [] as string[],
    isNew: false,
    noLicense: false,
  })

  function currentNavState(): NavState {
    return {
      q: searchQuery.value,
      types: [...filters.types],
      levels: [...filters.levels],
      products: [...filters.products],
      topics: [...filters.topics],
      isNew: filters.isNew,
      noLicense: filters.noLicense,
      page: currentPage.value,
    }
  }

  // ─── URL sync (gated by syncURL) ───
  let urlSyncTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleURLSync() {
    if (urlSyncTimer) clearTimeout(urlSyncTimer)
    urlSyncTimer = setTimeout(() => writeNavStateToWindow(currentNavState()), 300)
  }

  if (syncURL) {
    // `deep: true` is meaningful for the `() => filters.X` array getters; it's
    // a no-op on the bare `searchQuery` and `currentPage` refs but lets us keep
    // a single watcher instead of two.
    watch(
      [searchQuery, () => filters.levels, () => filters.types,
       () => filters.products, () => filters.topics,
       () => filters.isNew, () => filters.noLicense, currentPage],
      scheduleURLSync,
      { deep: true },
    )
    onScopeDispose(() => { if (urlSyncTimer) clearTimeout(urlSyncTimer) })
  }

  // ─── Server search integration ───
  // We always wire useSearch, but `displayedItems` only consults its results
  // when `tutorials` was provided (otherwise the slug→createdAt enrichment
  // would crash). On `/browse/` mounts that don't supply `tutorials`, the
  // composable falls through to client-side filtering even when searchMode
  // is true — which is the documented browse-page behaviour.
  const {
    searchMode, isSubThreshold, searchResults, searchFacets,
    searchTotalCount, isSearching, searchError,
  } = useSearch({
    searchTerm: searchQuery,
    filterTypes: computed(() => filters.types.map(t => t.toUpperCase())),
    filterLevels: computed(() => filters.levels),
    filterProducts: computed(() => filters.products),
    filterIsNew: computed(() => filters.isNew),
    filterNoLicense: computed(() => filters.noLicense),
    tutorials,
  })

  // ─── URL state read on mount (gated by syncURL) ───
  if (syncURL) {
    onMounted(async () => {
      // Defensive: a malformed window.location.href or a Storage that throws
      // (e.g. older Safari private mode, enterprise policy) shouldn't prevent
      // the navigator from booting. Fall back to defaults — same behaviour the
      // pre-urlSync code had when localStorage was unreadable.
      let initial: NavState
      const params = new URL(window.location.href).searchParams
      try {
        initial = parseNavState(
          window.location.href,
          typeof localStorage !== 'undefined' ? localStorage : null,
        )
      } catch {
        initial = { ...EMPTY_STATE }
      }
      searchQuery.value = initial.q
      filters.types     = initial.types
      filters.levels    = initial.levels
      filters.products  = initial.products
      filters.topics    = initial.topics
      filters.isNew     = initial.isNew
      filters.noLicense = initial.noLicense

      // Issue #161: deep-link from clickable tutorial-page chips uses `?tag=` /
      // `?level=` (multi-value) instead of urlSync's `?product=` / `?level=`.
      // Seed those into the already-restored filter state; the urlSync watcher
      // (300ms after this block) writes the canonical `?product=` URL and the
      // serializer strips `?tag` / chip-`?level` so they don't survive a
      // subsequent "Clear all filters" + reload.
      for (const slug of parseTagParams(params)) {
        if (!filters.products.includes(slug)) filters.products.push(slug)
      }
      for (const lvl of parseLevelParams(params)) {
        if (!filters.levels.includes(lvl)) filters.levels.push(lvl)
      }

      // Page must be set AFTER the pagination-reset watcher has flushed in
      // response to the filter assignments above — otherwise it clobbers our
      // restored page back to 1. `nextTick` defers past the pre-flush queue.
      await nextTick()
      currentPage.value = initial.page
    })
  }

  // ─── Available facet lists (driven by `tutorials` when provided) ───
  const availableProducts = computed(() => {
    // Each entry is { slug, label }, deduped by slug, sorted by label.
    const map = new Map<string, string>()
    const tuts = tutorials?.value ?? []
    for (const t of tuts) {
      for (let i = 0; i < t.displayTagSlugs.length; i++) {
        const slug = t.displayTagSlugs[i]
        const label = t.displayTags[i]
        // Skip experience-level tags (those go in the Experience filter, not
        // Software Product) and the license chip (handled separately).
        if (slug === 'tutorial>beginner' || slug === 'tutorial>intermediate' || slug === 'tutorial>advanced') continue
        if (slug === LICENSE_SLUG) continue
        if (!map.has(slug)) map.set(slug, label)
      }
    }
    return [...map.entries()]
      .map(([slug, label]) => ({ slug, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })

  const filteredProducts = computed(() => {
    if (!productSearch.value) return availableProducts.value
    const q = productSearch.value.toLowerCase()
    return availableProducts.value.filter(t => t.label.toLowerCase().includes(q))
  })

  const availableTopics = computed(() => {
    const topicSet = new Set<string>()
    const tuts = tutorials?.value ?? []
    for (const t of tuts) {
      for (const slug of t.displayTagSlugs) {
        const topics = PRODUCT_TO_TOPICS[slug]
        if (topics) {
          for (const topic of topics) topicSet.add(topic)
        }
      }
    }
    return [...topicSet].sort()
  })

  const filteredTopics = computed(() => {
    if (!topicSearch.value) return availableTopics.value
    const q = topicSearch.value.toLowerCase()
    return availableTopics.value.filter(t => t.toLowerCase().includes(q))
  })

  function tutorialMatchesTopic(item: CardItem, topic: string): boolean {
    return item.displayTagSlugs.some(slug => (PRODUCT_TO_TOPICS[slug] ?? []).includes(topic))
  }

  // ─── Client-side filtering pipeline ───
  const filteredItems = computed(() => {
    return allCards.value.filter(item => {
      if (searchQuery.value) {
        const q = searchQuery.value.toLowerCase()
        const matches = (item.title ?? '').toLowerCase().includes(q) ||
          (item.description ?? '').toLowerCase().includes(q) ||
          item.displayTags.some(t => t.toLowerCase().includes(q))
        if (!matches) return false
      }

      if (filters.types.length > 0 && !filters.types.includes(item.type)) {
        return false
      }

      if (filters.levels.length > 0 && !filters.levels.includes(item.level)) {
        return false
      }

      if (filters.products.length > 0) {
        const hasProduct = item.displayTagSlugs.some(s => filters.products.includes(s))
        if (!hasProduct) return false
      }

      if (filters.topics.length > 0) {
        const hasTopic = filters.topics.some(topic => tutorialMatchesTopic(item, topic))
        if (!hasTopic) return false
      }

      if (filters.isNew && !item.isNew) {
        return false
      }

      if (filters.noLicense && requiresLicense(item)) {
        return false
      }

      return true
    })
  })

  const counts = computed(() => {
    const all = filteredItems.value
    return {
      missions: all.filter(i => i.type === 'mission').length,
      groups: all.filter(i => i.type === 'group').length,
      tutorials: all.filter(i => i.type === 'tutorial').length,
    }
  })

  function toggleFilter(arr: string[], value: string) {
    const idx = arr.indexOf(value)
    if (idx >= 0) arr.splice(idx, 1)
    else arr.push(value)
  }

  function clearFilters() {
    searchQuery.value = ''
    filters.levels = []
    filters.types = []
    filters.products = []
    filters.topics = []
    filters.isNew = false
    filters.noLicense = false
    productSearch.value = ''
    topicSearch.value = ''
    currentPage.value = 1   // also reset page so URL drops `?page=` cleanly
  }

  const hasActiveFilters = computed(() => {
    return searchQuery.value.length > 0 ||
      filters.levels.length > 0 ||
      filters.types.length > 0 ||
      filters.products.length > 0 ||
      filters.topics.length > 0 ||
      filters.isNew ||
      filters.noLicense
  })

  const totalPages = computed(() => Math.ceil(filteredItems.value.length / pageSize))

  // ─── Display pipeline (server-search OR client-filter+sort+paginate) ───
  // displayedItems consults server search results only when `tutorials` is
  // provided (the SFC on `/`). On `/browse/` mounts without `tutorials`, we
  // fall through to the client path even in searchMode — server search would
  // crash on the slug→createdAt enrichment.
  const displayedItems = computed(() => {
    if (searchMode.value && tutorials) {
      const bySlug = new Map(tutorials.value.map(t => [t.slug, t.createdAt]))
      return searchResults.value.map(item => {
        if (item.type !== 'tutorial') return item
        const slug = item.href.replace(/^\/tutorials\//, '')
        return { ...item, isNew: isWithinNewWindow(bySlug.get(slug)) }
      })
    }
    // Client-filter path. Optional sort (only when enableSort=true and the
    // user picked something other than the default 'relevance'); pagination
    // applies in both sorted and unsorted modes.
    const items = enableSort && sort.value !== 'relevance'
      ? [...filteredItems.value].sort(SORT_COMPARATORS[sort.value])
      : filteredItems.value
    const start = (currentPage.value - 1) * pageSize
    return items.slice(start, start + pageSize)
  })

  const displayedTotalCount = computed(() => {
    if (searchMode.value && tutorials) return searchTotalCount.value
    return filteredItems.value.length
  })

  const displayedCounts = computed(() => {
    if (searchMode.value && tutorials && searchFacets.value) {
      const facets = searchFacets.value
      return {
        missions: facets.typeCounts.find(t => t.name === 'MISSION')?.count ?? 0,
        groups: facets.typeCounts.find(t => t.name === 'GROUP')?.count ?? 0,
        tutorials: facets.typeCounts.find(t => t.name === 'TUTORIAL')?.count ?? 0,
      }
    }
    return counts.value
  })

  const paginatorPages = computed(() => {
    const total = totalPages.value
    if (total <= 1) return []
    const current = currentPage.value
    const pages: Array<{ label: string; page: number; isCurrent: boolean; isRange: boolean }> = []

    if (total <= 9) {
      for (let i = 1; i <= total; i++) {
        pages.push({ label: String(i), page: i, isCurrent: i === current, isRange: false })
      }
      return pages
    }

    const nearby: number[] = []
    for (let i = Math.max(1, current - 3); i <= Math.min(total, current + 5); i++) {
      nearby.push(i)
    }
    if (nearby.length > 9) nearby.length = 9

    for (const p of nearby) {
      pages.push({ label: String(p), page: p, isCurrent: p === current, isRange: false })
    }

    const lastNearby = nearby[nearby.length - 1]
    if (lastNearby < total) {
      const rangeSize = 9
      let rangeStart = lastNearby + 1
      while (rangeStart <= total) {
        const rangeEnd = Math.min(rangeStart + rangeSize - 1, total)
        pages.push({ label: `${rangeStart}-${rangeEnd}`, page: rangeStart, isCurrent: false, isRange: true })
        rangeStart = rangeEnd + 1
      }
    }

    return pages
  })

  function goToPage(page: number) {
    currentPage.value = Math.max(1, Math.min(page, totalPages.value))
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // ─── Pagination-reset watcher (LOAD-BEARING for #195 + this composable) ───
  // Without this, filter changes don't reset to page 1 — the user lands on
  // an empty page after narrowing their filters.
  watch(
    [searchQuery, () => filters.levels, () => filters.types,
     () => filters.products, () => filters.topics,
     () => filters.isNew, () => filters.noLicense],
    () => { currentPage.value = 1 },
    { deep: true },
  )

  return {
    // Reactive state
    searchQuery,
    filters,
    currentPage,
    productSearch,
    topicSearch,
    sort: enableSort ? sort : undefined,
    // Display pipeline
    totalPages,
    displayedItems,
    displayedTotalCount,
    displayedCounts,
    counts,
    hasActiveFilters,
    paginatorPages,
    goToPage,
    // Mutators
    clearFilters,
    toggleFilter,
    // URL helper
    currentNavState,
    // Facet lists
    availableProducts,
    filteredProducts,
    availableTopics,
    filteredTopics,
    // useSearch outputs (server-search loading/error states)
    searchMode,
    isSubThreshold,
    searchResults,
    isSearching,
    searchError,
  }
}

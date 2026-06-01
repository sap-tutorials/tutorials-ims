<script setup lang="ts">
import { ref, computed, onMounted, reactive, watch } from 'vue'
import type { TutorialEntry, CardItem, MissionRef, GroupRef } from '@shared/types'
import { useSearch } from './useSearch'
import Skeleton from '@shared/Skeleton.vue'
import ProgressRing from '@shared/ProgressRing.vue'
import { cardProgress, toLookup, emptyProgress, type ProgressPayload } from './cardProgress'
import LicenseIcon from '../shared/LicenseIcon.vue'
import { requiresLicense, LICENSE_SLUG } from '../shared/license'
import type { SearchFacets } from '@shared/types'

const tutorials = ref<TutorialEntry[]>([])
const missionsMeta = ref<MissionRef[]>([])
const groupsMeta = ref<GroupRef[]>([])
const searchQuery = ref('')
const filtersOpen = ref(true)
const productSearch = ref('')
const topicSearch = ref('')
const currentPage = ref(1)
const pageSize = 48

const progress = ref<ProgressPayload>(emptyProgress())
const progressLoaded = ref(false)

const filters = reactive({
  levels: [] as string[],
  types: [] as string[],
  products: [] as string[],
  topics: [] as string[],
})

const loading = computed(() => tutorials.value.length === 0)

const { searchMode, isSubThreshold, searchResults, searchFacets, searchTotalCount, isSearching, searchError } = useSearch({
  searchTerm: searchQuery,
  filterTypes: computed(() => filters.types.map(t => t.toUpperCase())),
  filterLevels: computed(() => filters.levels),
  filterProducts: computed(() => filters.products),
  tutorials,
})

onMounted(async () => {
  const initialQuery = new URL(window.location.href).searchParams.get('q')
  if (initialQuery) searchQuery.value = initialQuery

  const [navRes, catalogRes, progRes] = await Promise.all([
    fetch('/tutorials/_nav.json'),
    fetch('/build/navigator'),
    fetch('/build/my-progress', { credentials: 'include' }).catch(() => null),
  ])

  if (navRes.ok) {
    const navData = await navRes.json()
    const tuts: TutorialEntry[] = navData.tutorials ?? navData
    tutorials.value = tuts
  }

  if (catalogRes.ok) {
    const catalog = await catalogRes.json()
    missionsMeta.value = catalog.missions ?? []
    groupsMeta.value = catalog.groups ?? []

    if (catalog.tutorialMappings && tutorials.value.length) {
      const mappingBySlug = new Map(catalog.tutorialMappings.map((m: any) => [m.slug, m]))
      tutorials.value = tutorials.value.map(t => {
        const mapping = mappingBySlug.get(t.slug)
        if (mapping) {
          return {
            ...t,
            missionId: mapping.missionId,
            missionTitle: mapping.missionTitle,
            groupId: mapping.groupId,
            groupTitle: mapping.groupTitle,
            prev: mapping.prev ?? t.prev,
            next: mapping.next ?? t.next,
          }
        }
        return t
      })
    }
  }

  if (progRes && progRes.ok) {
    try {
      const json = await progRes.json()
      progress.value = toLookup(json)
    } catch {
      // leave progress at emptyProgress default
    }
  }
  progressLoaded.value = true
})

const LEVEL_ORDER: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 }

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

function lowestLevel(levels: string[]): string {
  return levels.sort((a, b) => (LEVEL_ORDER[a] ?? 9) - (LEVEL_ORDER[b] ?? 9))[0] || 'beginner'
}

function formatTime(minutes: number): string {
  if (minutes < 60) return `${minutes} min.`
  const hrs = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hrs} hr. ${mins} min.` : `${hrs} hr.`
}

function capitalizeLevel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}

function missionGroupCount(missionId: number): number {
  const groupIds = new Set<number>()
  for (const t of tutorials.value) {
    if (t.missionId === missionId && t.groupId != null) {
      groupIds.add(t.groupId)
    }
  }
  return groupIds.size
}

const TYPE_LABELS: Record<string, string> = {
  mission: 'MISSION',
  group: 'GROUP',
  tutorial: 'TUTORIAL',
}

const NEW_BADGE_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

function isWithinNewWindow(createdAt: string | undefined): boolean {
  if (!createdAt) return false
  const t = Date.parse(createdAt)
  if (!Number.isFinite(t)) return false
  return Date.now() - t <= NEW_BADGE_WINDOW_MS
}

const allCards = computed<CardItem[]>(() => {
  const tuts = tutorials.value
  if (!tuts.length) return []

  const items: CardItem[] = []

  const missionGroups = new Map<number, TutorialEntry[]>()
  const groupMap = new Map<number, TutorialEntry[]>()

  for (const t of tuts) {
    if (t.missionId) {
      const mList = missionGroups.get(t.missionId) ?? []
      mList.push(t)
      missionGroups.set(t.missionId, mList)
    }

    if (t.groupId) {
      const gList = groupMap.get(t.groupId) ?? []
      gList.push(t)
      groupMap.set(t.groupId, gList)
    }
  }

  for (const [missionId, mTuts] of missionGroups) {
    const allTags = [...new Set(mTuts.flatMap(t => t.displayTags))]
    const allTagSlugs = [...new Set(mTuts.flatMap(t => t.displayTagSlugs))]
    const mMeta = missionsMeta.value.find(m => m.id === missionId)
    items.push({
      type: 'mission',
      id: `mission-${missionId}`,
      title: mTuts[0].missionTitle,
      description: `Complete this mission to build full-stack applications combining CAP with SAP HANA Cloud. Includes ${mTuts.length} tutorials across ${missionGroupCount(missionId)} groups.`,
      time: mTuts.reduce((sum, t) => sum + t.time, 0),
      level: lowestLevel(mTuts.map(t => t.level)),
      tutorialCount: mTuts.length,
      primaryTag: mTuts[0].primaryTag,
      displayTags: allTags,
      displayTagSlugs: allTagSlugs,
      href: mMeta ? `/tutorials/mission-${mMeta.slug}` : `/tutorials/${mTuts[0].slug}`,
      stepCount: mTuts.reduce((sum, t) => sum + t.stepCount, 0),
    })
  }

  for (const [groupId, gTuts] of groupMap) {
    const allTags = [...new Set(gTuts.flatMap(t => t.displayTags))]
    const allTagSlugs = [...new Set(gTuts.flatMap(t => t.displayTagSlugs))]
    const gMeta = groupsMeta.value.find(g => g.id === groupId)
    items.push({
      type: 'group',
      id: `group-${groupId}`,
      title: gTuts[0].groupTitle,
      description: `${gTuts.length} tutorials covering ${gTuts.map(t => t.title).join(', ')}.`,
      time: gTuts.reduce((sum, t) => sum + t.time, 0),
      level: lowestLevel(gTuts.map(t => t.level)),
      tutorialCount: gTuts.length,
      primaryTag: gTuts[0].primaryTag,
      displayTags: allTags,
      displayTagSlugs: allTagSlugs,
      href: gMeta ? `/tutorials/group-${gMeta.slug}` : `/tutorials/${gTuts[0].slug}`,
      stepCount: gTuts.reduce((sum, t) => sum + t.stepCount, 0),
    })
  }

  for (const t of tuts) {
    items.push({
      type: 'tutorial',
      id: t.slug,
      title: t.title,
      description: t.description,
      time: t.time,
      level: t.level,
      tutorialCount: 1,
      primaryTag: t.primaryTag,
      displayTags: t.displayTags,
      displayTagSlugs: t.displayTagSlugs,
      href: `/tutorials/${t.slug}`,
      stepCount: t.stepCount,
      isNew: isWithinNewWindow(t.createdAt),
    })
  }

  return items
})

const availableProducts = computed(() => {
  // Each entry is { slug, label }, deduped by slug, sorted by label.
  const map = new Map<string, string>()
  for (const t of tutorials.value) {
    for (let i = 0; i < t.displayTagSlugs.length; i++) {
      const slug = t.displayTagSlugs[i]
      const label = t.displayTags[i]
      // Skip experience-level tags (those go in the Experience filter, not Software Product)
      // and the license chip (handled separately).
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
  for (const t of tutorials.value) {
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
  productSearch.value = ''
  topicSearch.value = ''
}

const hasActiveFilters = computed(() => {
  return searchQuery.value.length > 0 ||
    filters.levels.length > 0 ||
    filters.types.length > 0 ||
    filters.products.length > 0 ||
    filters.topics.length > 0
})

const totalPages = computed(() => Math.ceil(filteredItems.value.length / pageSize))

const paginatedItems = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  return filteredItems.value.slice(start, start + pageSize)
})

const displayedItems = computed(() => {
  if (searchMode.value) {
    const bySlug = new Map(tutorials.value.map(t => [t.slug, t.createdAt]))
    return searchResults.value.map(item => {
      if (item.type !== 'tutorial') return item
      const slug = item.href.replace(/^\/tutorials\//, '')
      return { ...item, isNew: isWithinNewWindow(bySlug.get(slug)) }
    })
  }
  return paginatedItems.value
})

const displayedTotalCount = computed(() => {
  if (searchMode.value) return searchTotalCount.value
  return filteredItems.value.length
})

const displayedCounts = computed(() => {
  if (searchMode.value && searchFacets.value) {
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
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

watch([searchQuery, () => filters.levels, () => filters.types, () => filters.products, () => filters.topics], () => {
  currentPage.value = 1
}, { deep: true })
</script>

<template>
  <div class="tutorial-navigator" :data-progress-loaded="progressLoaded">
    <!-- Section: Hero Banner -->
    <section class="navigator-hero">
      <div class="hero-inner">
        <div class="hero-text">
          <h1>SAP Tutorials</h1>
          <p>
            Get hands-on experience with SAP HANA Cloud, ABAP, CAP, SAP Business AI Platform, and so much more.
            Follow step-by-step tutorials, earn badges, and build real-world applications.
          </p>
        </div>
        <div class="hero-promo">
          <div class="hero-promo-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--sapBrandColor, #0070f2)" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="6"/><path d="M9 14l-2 8 5-3 5 3-2-8"/></svg>
          </div>
          <div class="hero-promo-text">
            <strong>Earn badges as you learn!</strong>
            <span>Complete a tutorial mission, mark your progress, answer all the questions and earn badges.</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Section: Search + Filter -->
    <div class="navigator-body">
      <section class="navigator-search">
        <div class="fd-input-group">
          <input
            type="text"
            v-model="searchQuery"
            placeholder="Search for a tutorial"
            class="fd-input fd-input-group__input"
          />
          <span class="fd-input-group__addon fd-input-group__addon--button">
            <button class="fd-button fd-button--emphasized fd-input-group__button" aria-label="Search">Search</button>
          </span>
        </div>
        <button
          class="fd-button filter-toggle-btn"
          :class="filtersOpen ? 'fd-button--toggled' : 'fd-button--transparent'"
          @click="filtersOpen = !filtersOpen"
          :title="filtersOpen ? 'Hide filters' : 'Show filters'"
          aria-label="Toggle filters"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14l-5 6v5l-4 2V8z"/></svg>
        </button>
      </section>

      <!-- Section: Filter Panel -->
      <section v-show="filtersOpen" class="navigator-filters">
        <h2 class="filters-heading">Filter Your Search</h2>
        <div class="filters-grid">
          <div class="filter-column">
            <h3 class="filter-title">Topic</h3>
            <div class="fd-input-group filter-tag-search">
              <input
                type="text"
                v-model="topicSearch"
                placeholder="Search for a topic"
                class="fd-input fd-input-group__input"
              />
            </div>
            <div class="filter-list">
              <label v-for="topic in filteredTopics" :key="topic" class="filter-option">
                <input type="checkbox" :checked="filters.topics.includes(topic)" @change="toggleFilter(filters.topics, topic)" class="filter-checkbox" />
                <span class="filter-label">{{ topic }}</span>
              </label>
            </div>
          </div>

          <div class="filter-column">
            <h3 class="filter-title">Software Product</h3>
            <div class="fd-input-group filter-tag-search">
              <input
                type="text"
                v-model="productSearch"
                placeholder="Search for a product"
                class="fd-input fd-input-group__input"
              />
            </div>
            <div class="filter-list">
              <label v-for="product in filteredProducts" :key="product.slug" class="filter-option">
                <input type="checkbox"
                       :checked="filters.products.includes(product.slug)"
                       @change="toggleFilter(filters.products, product.slug)"
                       class="filter-checkbox" />
                <span class="filter-label">{{ product.label }}</span>
              </label>
            </div>
          </div>

          <div class="filter-column">
            <h3 class="filter-title">Experience</h3>
            <div class="filter-list">
              <label v-for="level in ['beginner', 'intermediate', 'advanced']" :key="level" class="filter-option">
                <input type="checkbox" :checked="filters.levels.includes(level)" @change="toggleFilter(filters.levels, level)" class="filter-checkbox" />
                <span class="filter-label">{{ capitalizeLevel(level) }}</span>
              </label>
            </div>
          </div>

          <div class="filter-column">
            <h3 class="filter-title">Type</h3>
            <div class="filter-list">
              <label v-for="type in ['mission', 'group', 'tutorial']" :key="type" class="filter-option">
                <input type="checkbox" :checked="filters.types.includes(type)" @change="toggleFilter(filters.types, type)" class="filter-checkbox" />
                <span class="filter-label">{{ type.charAt(0).toUpperCase() + type.slice(1) }}</span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Result Count Bar -->
      <section class="navigator-toolbar">
        <div class="toolbar-counts">
          <button class="toolbar-count" :class="{ active: filters.types.includes('mission') }" @click="toggleFilter(filters.types, 'mission')">
            <span class="toolbar-count-num count-mission">{{ displayedCounts.missions }}</span> Mission
          </button>
          <span class="toolbar-sep">&middot;</span>
          <button class="toolbar-count" :class="{ active: filters.types.includes('group') }" @click="toggleFilter(filters.types, 'group')">
            <span class="toolbar-count-num count-group">{{ displayedCounts.groups }}</span> Group
          </button>
          <span class="toolbar-sep">&middot;</span>
          <button class="toolbar-count" :class="{ active: filters.types.includes('tutorial') }" @click="toggleFilter(filters.types, 'tutorial')">
            <span class="toolbar-count-num count-tutorial">{{ displayedCounts.tutorials }}</span> Tutorial
          </button>
        </div>
        <button v-if="hasActiveFilters" class="fd-button fd-button--transparent" @click="clearFilters">
          Clear all filters
        </button>
      </section>

      <!-- Section: Card Grid (or skeleton while loading)
           Issue #159: Result-region children are persistent siblings gated by
           v-show, NOT v-if branches inside a <Transition>. Keeping the heavy
           ui5-illustrated-message empty-state mounted prevents the visible
           "no results" flash on every keystroke when the query has no matches.
           <Transition> is reserved for the initial-load skeleton (which only
           appears once per page load). Busy state is signalled via aria-busy
           on the wrapper plus a delayed ui5-busy-indicator that overlays
           rather than displaces. -->
      <div class="navigator-result-area" :aria-busy="isSearching">
        <Transition name="navigator-fade" mode="out-in">
          <section
            v-if="loading"
            key="skeleton"
            class="navigator-grid navigator-grid--loading"
            aria-label="Loading tutorials"
          >
            <Skeleton kind="card" :count="6" />
          </section>
        </Transition>

        <ui5-busy-indicator
          v-if="!loading"
          data-region-busy
          size="Medium"
          :active="isSearching"
          delay="400"
        ></ui5-busy-indicator>

        <div v-show="!loading && isSubThreshold" class="navigator-hint">
          <ui5-illustrated-message name="BeforeSearch" design="Spot">
            <span slot="title">Keep typing&hellip;</span>
            <span slot="subtitle">Search starts at 2 characters.</span>
          </ui5-illustrated-message>
        </div>

        <section
          v-show="!loading && !isSubThreshold && displayedItems.length > 0"
          class="navigator-grid"
        >
          <a
            v-for="item in displayedItems"
            :key="item.id"
            :href="item.href"
            class="nav-card"
            data-vt-card="navigator"
            :class="{
              'nav-card--new': item.isNew,
              'nav-card--has-progress': !!cardProgress(item, progress),
            }"
          >
            <ProgressRing
              v-if="cardProgress(item, progress)"
              class="nav-card__progress"
              v-bind="cardProgress(item, progress)!"
            />
            <span v-if="item.isNew" class="nav-card__new-badge" aria-label="New tutorial">NEW</span>
            <LicenseIcon v-if="requiresLicense(item)" class="nav-card__license" />
            <div class="nav-card__type" :class="`nav-card__type--${item.type}`">
              {{ TYPE_LABELS[item.type] }}
            </div>

            <h3 class="nav-card__title">{{ item.title }}</h3>

            <p class="nav-card__desc">{{ item.description }}</p>

            <div class="nav-card__meta">
              <span class="nav-card__meta-item">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"/></svg>
                {{ capitalizeLevel(item.level) }}
              </span>
              <span class="nav-card__meta-sep">&middot;</span>
              <span class="nav-card__meta-item">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>
                {{ formatTime(item.time) }}
              </span>
              <template v-if="item.type !== 'tutorial'">
                <span class="nav-card__meta-sep">&middot;</span>
                <span class="nav-card__meta-item">{{ item.tutorialCount }} Tutorials</span>
              </template>
            </div>

            <div class="nav-card__tag">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5l7 7-5 5-7-7V3zm3 2a1 1 0 100 2 1 1 0 000-2z"/></svg>
              {{ item.primaryTag }}
            </div>
          </a>
        </section>

        <div
          v-show="!loading && !isSubThreshold && displayedItems.length === 0"
          class="navigator-empty"
        >
          <ui5-illustrated-message name="NoFilterResults" design="Spot">
            <span slot="title">No results match your filters</span>
            <span slot="subtitle">Try removing a filter or broadening your search.</span>
            <ui5-button design="Emphasized" @click="clearFilters">Clear all filters</ui5-button>
          </ui5-illustrated-message>
        </div>
      </div>

      <!-- Section: Pagination -->
      <nav v-if="totalPages > 1 && !searchMode" class="navigator-pagination" aria-label="Page navigation">
        <button
          class="pagination-btn pagination-prev"
          :disabled="currentPage === 1"
          @click="goToPage(currentPage - 1)"
          aria-label="Previous page"
        >&lsaquo;</button>
        <button
          v-for="p in paginatorPages"
          :key="p.label"
          class="pagination-btn"
          :class="{ 'pagination-btn--current': p.isCurrent, 'pagination-btn--range': p.isRange }"
          @click="goToPage(p.page)"
        >{{ p.label }}</button>
        <button
          class="pagination-btn pagination-next"
          :disabled="currentPage === totalPages"
          @click="goToPage(currentPage + 1)"
          aria-label="Next page"
        >&rsaquo;</button>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.tutorial-navigator {
  font-family: var(--sapFontFamily, '72', '72full', Arial, Helvetica, sans-serif);
  color: var(--sapTextColor, #32363a);
  background: var(--sapBackgroundColor, #f5f6f7);
  min-height: 100vh;
  overflow-x: hidden;
}

/* ─── Hero ─── */
.navigator-hero {
  background: var(--sapShellColor, #354a5f);
  color: var(--sapShell_TextColor, #fff);
  padding: 2.5rem 2rem 3rem;
}

.hero-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: flex-start;
  gap: 3rem;
}

.hero-text {
  flex: 1;
}

.hero-text h1 {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 0.75rem;
  color: inherit;
  letter-spacing: -0.01em;
}

.hero-text p {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.7;
  opacity: 0.88;
  max-width: 560px;
}

.hero-promo {
  flex-shrink: 0;
  background: var(--sapBaseColor, #fff);
  color: var(--sapTextColor, #32363a);
  border-radius: 0.75rem;
  padding: 1.25rem 1.5rem;
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
  max-width: 340px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.hero-promo-icon {
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  background: var(--sapInformationBackground, #e1f4ff);
  display: flex;
  align-items: center;
  justify-content: center;
}

.hero-promo-text strong {
  display: block;
  color: var(--sapBrandColor, #0070f2);
  font-size: 0.875rem;
  margin-bottom: 0.25rem;
}

.hero-promo-text span {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--sapContent_LabelColor, #556b82);
}

/* ─── Body ─── */
.navigator-body {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem 2rem 3rem;
}

/* ─── Search ─── */
.navigator-search {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
  margin-bottom: 1.5rem;
}

.navigator-search .fd-input-group {
  flex: 1;
  background: var(--sapField_Background, #fff);
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.5rem) 0 0 var(--sapField_BorderCornerRadius, 0.5rem);
}

.navigator-search .fd-input-group:focus-within {
  border-color: var(--sapField_Focus_BorderColor, #0064d9);
  outline: var(--sapContent_FocusWidth, 1px) dotted var(--sapContent_FocusColor, #0064d9);
  outline-offset: 1px;
}

.navigator-search .fd-input {
  height: 2.75rem;
  font-size: 0.9375rem;
  background: transparent;
  border: none;
  color: var(--sapField_TextColor, #32363a);
}

.navigator-search .fd-input::placeholder {
  color: var(--sapField_PlaceholderTextColor, #a9b4be);
}

.navigator-search .fd-button--emphasized {
  height: 2.75rem;
  padding: 0 1.5rem;
  border-radius: 0 var(--sapField_BorderCornerRadius, 0.5rem) var(--sapField_BorderCornerRadius, 0.5rem) 0;
}

.filter-toggle-btn {
  height: 2.75rem;
  width: 2.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
}

.fd-button--toggled {
  background: var(--sapButton_Selected_Background, rgba(0, 100, 217, 0.08));
  border: 1px solid var(--sapButton_Selected_BorderColor, #0064d9);
  color: var(--sapButton_Selected_TextColor, #0064d9);
  border-radius: var(--sapButton_BorderCornerRadius, 0.5rem);
  cursor: pointer;
}

/* ─── Filters ─── */
.navigator-filters {
  background: var(--sapBaseColor, #fff);
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.filters-heading {
  font-size: 1.125rem;
  font-weight: 700;
  margin: 0 0 1.25rem;
  color: var(--sapTextColor, #32363a);
}

.filters-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: 1.5rem;
}

.filter-title {
  font-size: 0.8125rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0 0 0.75rem;
}

.filter-tag-search {
  margin-bottom: 0.75rem;
}

.filter-tag-search .fd-input {
  height: 2rem;
  font-size: 0.8125rem;
}

.filter-list {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  max-height: 7.5rem;
  overflow-y: auto;
  padding-right: 0.25rem;
}

.filter-list::-webkit-scrollbar {
  width: 4px;
}

.filter-list::-webkit-scrollbar-track {
  background: transparent;
}

.filter-list::-webkit-scrollbar-thumb {
  background: var(--sapScrollBar_FaceColor, #94a2b3);
  border-radius: 2px;
}

.filter-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--sapTextColor, #32363a);
}

.filter-option .filter-checkbox {
  accent-color: var(--sapBrandColor, #0070f2);
  width: 1rem;
  height: 1rem;
  cursor: pointer;
  flex-shrink: 0;
  margin: 0;
}

.filter-option .filter-label {
  cursor: pointer;
}

/* ─── Toolbar / Result Bar ─── */
.navigator-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
  padding: 0.5rem 0;
}

.toolbar-counts {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #556b82);
}

.toolbar-count {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-weight: 600;
  background: none;
  border: 1.5px solid transparent;
  border-radius: 1rem;
  padding: 0.25rem 0.625rem;
  cursor: pointer;
  transition: all 0.15s ease;
  color: inherit;
  font-size: inherit;
  font-family: inherit;
}

.toolbar-count:hover {
  background: var(--sapList_Hover_Background, #eaeff5);
}

.toolbar-count.active {
  border-color: var(--sapSelectedColor, #0070f2);
  background: var(--sapSelectedColor, #0070f2);
  color: #fff;
}

.toolbar-count-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.375rem;
  height: 1.375rem;
  padding: 0 0.375rem;
  border-radius: 0.75rem;
  font-size: 0.6875rem;
  font-weight: 700;
  color: #fff;
}

.count-mission { background: var(--sapInformativeBorderColor, #046c7a); }
.count-group { background: var(--sapPositiveColor, #6c32a9); }
.count-tutorial { background: var(--sapNeutralTextColor, #5b738b); }

.toolbar-count.active .toolbar-count-num {
  background: rgba(255, 255, 255, 0.25);
}

.toolbar-sep {
  color: var(--sapNeutralBorderColor, #d9d9d9);
  font-size: 1rem;
}

/* ─── Card Grid ─── */
.navigator-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}

.nav-card {
  display: flex;
  flex-direction: column;
  background: var(--sapBaseColor, #fff);
  border-radius: 0.75rem;
  padding: 1.5rem;
  text-decoration: none;
  color: inherit;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  min-height: 200px;
  position: relative;
}

/* ─── NEW badge (tutorials authored within the last 31 days) ─── */
.nav-card__new-badge {
  position: absolute;
  bottom: 0.75rem;
  right: 0.75rem;
  background: var(--sapAccentColor8, #6c32a9);
  color: #fff;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  line-height: 1;
  z-index: 1;
}

.nav-card__license {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  color: var(--sapContent_NonInteractiveIconColor, var(--sapTextColor, #32363a));
  z-index: 1;
}

.nav-card:hover {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  transform: translateY(-1px);
}

/* ─── Card Type Label ─── */
.nav-card__type {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.nav-card__type--mission { color: var(--sapAccentColor6, #046c7a); }
.nav-card__type--group { color: var(--sapAccentColor8, #6c32a9); }
.nav-card__type--tutorial { color: var(--sapAccentColor10, #5b738b); }

.nav-card__type::before {
  content: '';
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: currentColor;
}

/* ─── Card Title ─── */
.nav-card__title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
  margin: 0 0 0.5rem;
  line-height: 1.4;
}

.nav-card:hover .nav-card__title {
  color: var(--sapBrandColor, #0070f2);
}

/* ─── Card Description ─── */
.nav-card__desc {
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0;
  flex: 1;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ─── Card Meta ─── */
.nav-card__meta {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-top: 1rem;
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #556b82);
  flex-wrap: wrap;
}

.nav-card__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.nav-card__meta-item svg {
  opacity: 0.6;
}

.nav-card__meta-sep {
  color: var(--sapNeutralBorderColor, #d9d9d9);
}

/* ─── Card Tag ─── */
.nav-card__tag {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--sapGroup_ContentBorderColor, #e5e5e5);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--sapBrandColor, #0070f2);
}

.nav-card__tag svg {
  opacity: 0.7;
}

/* ─── Skeleton loading state ─── */
.navigator-grid--loading {
  /* Inherit grid-template-columns from .navigator-grid via the cascade. */
}
.navigator-grid--loading .skeleton-group {
  display: contents; /* let each .skeleton card occupy a grid cell directly */
}
.navigator-grid--loading .skeleton--card {
  min-height: 200px;
  border-radius: 0.75rem;
  margin-bottom: 0; /* grid gap handles spacing */
}

/* ─── Empty State ─── */
.navigator-empty {
  text-align: center;
  padding: 1.5rem 2rem 3rem;
}

.navigator-empty ui5-button {
  margin-top: 1rem;
}

.navigator-result-area {
  /* Prevents collapse-to-zero during out-in fade. The Spot-design
     illustrated message renders ~220-240px tall; 320px gives headroom for
     the title + subtitle slots without dictating browse-grid height. */
  min-height: 320px;
  /* #159: anchors the absolutely-positioned ui5-busy-indicator overlay so
     it floats above the persistent-sibling result region without
     displacing the empty-state. */
  position: relative;
}

.navigator-result-area > [data-region-busy] {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
}

.navigator-hint {
  text-align: center;
  padding: 1.5rem 2rem 3rem;
}

@media (prefers-reduced-motion: no-preference) {
  .navigator-fade-enter-active,
  .navigator-fade-leave-active {
    transition: opacity 150ms ease-out;
  }
  .navigator-fade-enter-from,
  .navigator-fade-leave-to {
    opacity: 0;
  }
}

/* ─── Pagination ─── */
.navigator-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  margin-top: 2rem;
  padding: 1rem 0;
}

.pagination-btn {
  min-width: 2.25rem;
  height: 2.25rem;
  padding: 0 0.5rem;
  border: 1px solid var(--sapButton_BorderColor, #bcc3ca);
  border-radius: var(--sapButton_BorderCornerRadius, 0.5rem);
  background: var(--sapButton_Background, #fff);
  color: var(--sapButton_TextColor, #32363a);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s ease;
  font-family: inherit;
}

.pagination-btn:hover:not(:disabled):not(.pagination-btn--current) {
  background: var(--sapButton_Hover_Background, #eaeff5);
  border-color: var(--sapButton_Hover_BorderColor, #0064d9);
}

.pagination-btn--current {
  background: var(--sapSelectedColor, #0070f2);
  border-color: var(--sapSelectedColor, #0070f2);
  color: #fff;
  cursor: default;
}

.pagination-btn--range {
  font-size: 0.75rem;
  padding: 0 0.625rem;
  color: var(--sapContent_LabelColor, #556b82);
  border-style: dashed;
}

.pagination-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pagination-prev,
.pagination-next {
  font-size: 1.25rem;
  font-weight: 400;
}

/* ─── Responsive ─── */
@media (max-width: 1024px) {
  .navigator-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .filters-grid {
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
  }
}

@media (max-width: 768px) {
  .hero-inner {
    flex-direction: column;
    text-align: center;
  }

  .hero-promo {
    max-width: 100%;
  }

  .hero-text h1 {
    font-size: 1.375rem;
  }

  .filters-grid {
    grid-template-columns: 1fr;
  }

  .navigator-toolbar {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
}

@media (max-width: 640px) {
  .navigator-hero {
    padding: 1.5rem 1rem 2rem;
  }

  .navigator-body {
    padding: 1rem 1rem 2rem;
  }

  .navigator-search {
    flex-direction: column;
  }

  .filter-toggle-btn {
    align-self: flex-end;
  }

  .navigator-grid {
    grid-template-columns: 1fr;
  }
}

.nav-card__progress {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  opacity: 0;
  transition: opacity 0.15s ease-out;
}
.tutorial-navigator[data-progress-loaded="true"] .nav-card__progress {
  opacity: 1;
}
.nav-card--has-progress .nav-card__type,
.nav-card--has-progress .nav-card__title,
.nav-card--has-progress .nav-card__desc {
  padding-left: 3rem;
}
</style>

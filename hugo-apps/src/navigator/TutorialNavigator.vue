<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import type { TutorialEntry, CardItem, MissionRef, GroupRef } from '@shared/types'
import Skeleton from '@shared/Skeleton.vue'
import { toLookup, emptyProgress, type ProgressPayload } from './cardProgress'
import { isWithinNewWindow } from '../shared/freshness'
import { useNavigatorFilters } from '@shared/composables/useNavigatorFilters'
import { wireTracker } from '@shared/analytics/wire-tracker'
// /browse/ ships ?sort= via browseUrl.ts. Reusing that module here (#199)
// keeps the URL contract identical across both surfaces — no new param
// shape to maintain. The module's behaviour is fully covered by
// hugo-apps/src/browse/__tests__/browseUrl.test.ts.
import { readSort, writeSort, DEFAULT_SORT, type Sort } from '../browse/browseUrl'
import MissionCard from '@shared/cards/MissionCard.vue'
import GroupCard from '@shared/cards/GroupCard.vue'
import TutorialCard from '@shared/cards/TutorialCard.vue'

// `/`-specific data shapes — fetched in onMounted below.
const tutorials = ref<TutorialEntry[]>([])
const missionsMeta = ref<MissionRef[]>([])
const groupsMeta = ref<GroupRef[]>([])

// SSR-pre-seeded card list (#200). Read synchronously at script-init from
// the <script id="browse-data" type="application/json"> element emitted by
// hugo/layouts/index.html. Lets us render the grid in the first paint after
// Vue mount instead of waiting for /tutorials/_nav.json + /build/navigator
// (~200-400ms on a cold connection). The fetches still run in onMounted to
// enrich tutorials/missionsMeta/groupsMeta refs for facet computation
// (filteredTopics, filteredProducts) — at which point allCards switches to
// the live computation. Empty array when SSR data is missing (fresh deploy,
// recovery, or if Hugo couldn't read .Site.Data.browse).
function readSsrPreseededCards(): CardItem[] {
  if (typeof document === 'undefined') return []
  const el = document.getElementById('browse-data')
  if (!el?.textContent) return []
  try {
    const parsed = JSON.parse(el.textContent) as { all?: CardItem[] }
    return parsed.all ?? []
  } catch {
    return []
  }
}
const ssrPreseededCards = ref<CardItem[]>(readSsrPreseededCards())

// User progress is `/`-only (the `/browse/` build will fetch its own).
const progress = ref<ProgressPayload>(emptyProgress())
const progressLoaded = ref(false)

// Template UI toggle for the filter rail visibility.
const filtersOpen = ref(true)

// Loading is false when EITHER the live fetches have resolved (tutorials
// populated) OR SSR pre-seed data is present. The SSR preview should NOT
// be replaced by the loading skeleton — that would re-introduce the
// flash-of-empty-grid the SSR pass is meant to eliminate.
const loading = computed(() =>
  tutorials.value.length === 0 && ssrPreseededCards.value.length === 0
)

const LEVEL_ORDER: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 }

function lowestLevel(levels: string[]): string {
  return levels.sort((a, b) => (LEVEL_ORDER[a] ?? 9) - (LEVEL_ORDER[b] ?? 9))[0] || 'beginner'
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

const allCards = computed<CardItem[]>(() => {
  const tuts = tutorials.value
  // SSR pre-seed path (#200): when fetches haven't resolved yet but Hugo
  // emitted the inlined browse-data JSON, render those cards immediately
  // instead of an empty grid. Fetches will replace this with the
  // tutorials-derived computation as soon as they land.
  if (!tuts.length) {
    return ssrPreseededCards.value
  }

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
    const groupCount = missionGroupCount(missionId)
    items.push({
      type: 'mission',
      id: `mission-${missionId}`,
      title: mTuts[0].missionTitle,
      // Topic-neutral description (issue #218). Was hardcoded to a CAP-specific
      // string that mis-texted every non-CAP mission. Build-time mirror in
      // scripts/fetch-tutorials.ts buildAllCards() uses the same template.
      description: `${mTuts.length} tutorials across ${groupCount} ${groupCount === 1 ? 'group' : 'groups'}.`,
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

// All filter state, URL sync, filtering pipeline, pagination, available
// facet lists, and useSearch wiring live in the composable. `tutorials`
// is provided so the composable's server-search path can enrich results
// with isNew via slug→createdAt lookup.
const {
  searchQuery, filters, currentPage, productSearch, topicSearch,
  totalPages, displayedItems, displayedCounts,
  hasActiveFilters, paginatorPages, goToPage, clearFilters, toggleFilter,
  filteredProducts, filteredTopics,
  searchMode, isSubThreshold, isSearching,
  sort: composableSort,
} = useNavigatorFilters({
  allCards,
  tutorials,
  enableSort: true,
})

// Sort UI (#199): reuse /browse/'s ?sort= URL contract via browseUrl.ts —
// keeps the URL behavior identical across both surfaces. The composable
// also exposes its own `sort` ref (composableSort above); we mirror this
// local ref's value into it so the comparator pipeline picks up changes.
// Pattern matches BrowsePage.vue:80-94.
const sort = ref<Sort>(
  typeof window !== 'undefined' ? readSort(window.location.href) : DEFAULT_SORT
)
if (composableSort) composableSort.value = sort.value
watch(sort, (next) => {
  if (composableSort) composableSort.value = next
  if (typeof window !== 'undefined') {
    const newHref = writeSort(window.location.href, next)
    if (newHref !== window.location.href) {
      history.replaceState({}, '', newHref)
    }
  }
})

// Joule handoff (#943): button in the search box's fd-input-group__addon
// slot opens Joule with a canned prompt when the user has typed a search
// query, otherwise just opens the Joule pane empty. Drops telemetry into
// globalThis.__JOULE_NAV_SEARCH before calling openWithMessage so
// downstream tools can attribute the call to a navigator search. Mirrors
// the __JOULE_ADVOCATES bridge in hugo-apps/src/advocates/App.vue.
function handleJouleClick() {
  const query = searchQuery.value?.trim() ?? ''
  const joule = (window as any).joule
  if (!joule) return
  if (!query) { joule.open?.(); return }
  const template = [
    `Find tutorials about: ${query}`,
    `Use the expandSearchConcepts tool for related concepts, then searchTutorials for keyword matches. Summarise the top results with why they're relevant.`,
  ].join('\n\n')
  ;(globalThis as any).__JOULE_NAV_SEARCH = {
    queryLength: query.length,
    hasFilters: hasActiveFilters.value,
    ts: Date.now(),
  }
  joule.openWithMessage?.({ text: template })
}

onMounted(async () => {
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

  // Analytics tracker (#204) — fires page_view, filter_change, card_click,
  // pagination_change, rail_show_all_click, scroll_depth, page_leave.
  // Tracker self-disables on 503 (default until UI_EVENTS_ENABLED is set).
  // Sort ref passed in via filters (#199) so filter_change(kind=sort)
  // events fire on dropdown change, matching /browse/'s telemetry.
  wireTracker({
    surface: '/',
    filters: { searchQuery, filters, sort },
  })
})
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
          <span class="fd-input-group__addon">
            <button
              type="button"
              class="fd-button fd-button--transparent joule-search-btn"
              :aria-label="'Ask Joule about ' + (searchQuery || 'tutorials')"
              @click="handleJouleClick"
            >
              <i class="sap-icon--ai" aria-hidden="true"></i>
            </button>
          </span>
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
              <hr class="filter-divider" aria-hidden="true" />
              <label class="filter-option">
                <input type="checkbox" v-model="filters.isNew" class="filter-checkbox" />
                <span class="filter-label">New tutorials</span>
              </label>
              <label class="filter-option">
                <input type="checkbox" v-model="filters.noLicense" class="filter-checkbox" />
                <span class="filter-label">No license</span>
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
        <!-- Sort dropdown (#199): same five options as /browse/, same
             ?sort= URL contract via browseUrl.ts. The native <select>
             matches /browse/'s `.browse-sort__select` styling pattern;
             reusing the same .browse-sort* classes (rather than
             /-specific ones) lets shared CSS govern both. -->
        <label class="navigator-sort browse-sort">
          Sort:
          <select name="sort" class="browse-sort__select" v-model="sort">
            <option value="relevance">Relevance</option>
            <option value="updated">Recently updated</option>
            <option value="recent">Recently added</option>
            <option value="title">Title A→Z</option>
            <option value="time">Time-to-complete</option>
          </select>
        </label>
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
          <template v-for="item in displayedItems" :key="item.id">
            <MissionCard  v-if="item.type === 'mission'"      :item="item" :progress="progress" />
            <GroupCard    v-else-if="item.type === 'group'"   :item="item" :progress="progress" />
            <TutorialCard v-else-if="item.type === 'tutorial'" :item="item" :progress="progress" />
          </template>
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

.filter-divider {
  border: none;
  border-top: 1px solid var(--sapList_BorderColor, #d9d9d9);
  margin: 0.5rem 0;
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

/* Selected state: subtle tinted background + colored border, mirroring the
   .fd-button--toggled convention used elsewhere in this file. The inner
   .toolbar-count-num keeps its native semantic Horizon color (teal / purple /
   grey) so type-color encoding survives selection and contrast stays WCAG-safe
   in both Horizon light and dark. See issue #152. */
.toolbar-count.active {
  border-color: var(--sapButton_Selected_BorderColor, #0064d9);
  background: var(--sapButton_Selected_Background, rgba(0, 100, 217, 0.08));
  color: var(--sapButton_Selected_TextColor, #0064d9);
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

.toolbar-sep {
  color: var(--sapNeutralBorderColor, #d9d9d9);
  font-size: 1rem;
}

/* Sort dropdown (#199): pin to the right of the toolbar; matches /browse/'s
   visual where the sort dropdown sits at the end of the grid header. */
.navigator-sort {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #556b82);
}
.navigator-sort .browse-sort__select {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 4px;
  background: var(--sapField_Background, #fff);
  font: inherit;
  color: inherit;
  cursor: pointer;
}

/* ─── Card Grid ─── */
.navigator-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
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
</style>

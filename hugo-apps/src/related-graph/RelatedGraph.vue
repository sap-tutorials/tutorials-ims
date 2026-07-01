<!--
  hugo-apps/src/related-graph/RelatedGraph.vue
  Knowledge Graph sidebar island — thin orchestrator (Task 13 of #850).

  Composes SidebarPanel (Task 11) + optional ExpandedPanel (Task 12).
  All per-section templates and the per-type v-else-if chain moved into
  SidebarPanel + ResourceRow. This file retains only:
    - State machine (loading | ready | empty | error | disabled).
    - IntersectionObserver anchor + lazy fetch of /graph/neighborhood.
    - Slug extraction from <html data-page-slug>.
    - Expansion state + 250ms double-click lock.
    - Telemetry emit helper shared with both panels.

  Hide-on-empty: if the server returns no `teaches`, the panel does not
  render — there is no empty placeholder.

  Kill-switch: 503 from /graph/* (KNOWLEDGE_GRAPH_ENABLED=false) hides
  the panel silently — readers never see error UI. Network errors are
  warned to the console and otherwise swallowed.

  Telemetry — fired as window CustomEvents picked up by the existing
  UI_EVENTS_ENABLED bridge ([[project_204_deploy_flag_flipped]]):
    - kg.sidebar.shown                     once on first non-empty render
    - kg.sidebar.click                     tutorial item link click
    - kg.<per-type>.linked_from_sidebar    Other-resources row click
-->
<template>
  <template v-if="state === 'ready' && data">
    <SidebarPanel
      :data="data"
      :data-dimmed="expanded ? 'true' : 'false'"
      @open-expanded="onOpen"
      @item-click="onItemClick"
      @resource-click="onOtherResourceClick"
      @legacy-fallback="onLegacyFallback"
    />
    <ExpandedPanel
      v-if="expanded"
      :slug="slug"
      :tutorial-title="data.tutorial.title"
      @close="onClose"
    />
  </template>

  <!--
    Skeleton loading state. Renders while /graph/neighborhood resolves
    (~2-3 s typical) so readers see something on the way. Same panel
    chrome as SidebarPanel so layout doesn't jolt on state flip.

    Fires only when state === 'loading' AND fetchTriggered (IO has
    armed the fetch). error / disabled / empty fall through to the
    1 px anchor — those paths must stay silent per spec.
  -->
  <aside
    v-else-if="state === 'loading' && fetchTriggered"
    ref="rootEl"
    class="kg-sidebar kg-sidebar--skeleton"
    aria-busy="true"
    aria-label="Loading related concepts and tutorials"
  >
    <header class="kg-sidebar-header">
      <h2>Related learning</h2>
      <p class="kg-sidebar-help">
        Powered by the knowledge graph — surfaces tutorials that share
        concepts with this one, plus what comes before and after on a
        natural learning path. Hover any link to see why it appears here.
      </p>
    </header>
    <section v-for="(rows, idx) in SKELETON_SECTIONS" :key="idx">
      <div class="kg-sidebar-skel-heading skeleton skeleton--text-line"></div>
      <ul>
        <li v-for="n in rows" :key="n">
          <div class="skeleton skeleton--text-line"></div>
        </li>
      </ul>
    </section>
  </aside>

  <!--
    Hidden anchor used by IntersectionObserver before content arrives.
    aria-hidden + 1 px footprint keep it out of the accessibility tree
    and out of layout. Once data loads it's replaced by SidebarPanel
    above, which the observer no longer needs (already disconnected).
  -->
  <div
    v-else
    ref="rootEl"
    class="kg-sidebar-anchor"
    aria-hidden="true"
  ></div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { NeighborhoodResult, OtherResource, SidebarState } from './types'
import SidebarPanel from './SidebarPanel.vue'
import ExpandedPanel from './ExpandedPanel.vue'
import '../../../hugo/assets/css/skeletons.css'

// Skeleton row counts per section, in render order: Prereq → Other →
// Shared → Next. Underrunning the real result is fine (no layout jolt
// downward); over-running leaves visible empty rows on sparse tutorials.
// 5 is the empirical median across populated tutorials on DEV; Prereq
// tends to be shorter (~3) so the first section is intentionally smaller.
const SKELETON_SECTIONS = [3, 5, 5, 5] as const

const slug = (typeof document !== 'undefined' &&
  document.documentElement?.dataset?.pageSlug) || ''

const state = ref<SidebarState>('loading')
const data = ref<NeighborhoodResult | null>(null)
const rootEl = ref<HTMLElement | null>(null)
const fetchTriggered = ref(false)
const expanded = ref(false)

// 250 ms double-click lock on the ⤢ expand trigger. Guards against a
// user (or a jittery input device) opening the expanded dialog twice
// in rapid succession — the second open would nest a duplicate
// Teleport target and duplicate the kg.expanded.opened telemetry.
let openLockedUntil = 0

let observer: IntersectionObserver | null = null

// ── Telemetry ────────────────────────────────────────────────────────
//
// Fan-out via window CustomEvents. Wrapped in try/catch so a broken
// telemetry bridge never breaks the sidebar.
function emit(type: string, detail: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }))
  } catch {
    /* never let telemetry break the UI */
  }
}

function announce(body: NeighborhoodResult): void {
  emit('kg.sidebar.shown', {
    slug,
    sectionCounts: {
      teaches: body.teaches.length,
      prerequisitesOf: body.prerequisitesOf.length,
      sharedConcepts: body.sharedConcepts.length,
      whatToLearnNext: body.whatToLearnNext.length,
    },
  })
}

// ── SidebarPanel event handlers ───────────────────────────────────────

function onItemClick(
  type: 'prerequisitesOf' | 'sharedConcepts' | 'whatToLearnNext',
  targetSlug: string,
): void {
  emit('kg.sidebar.click', { type, targetSlug, slug })
}

// Cross-corpus rail telemetry. Branches on `r.type` so each type has
// its own event name. Types + shapes preserved verbatim from the
// pre-#850 handler.
function onOtherResourceClick(r: OtherResource): void {
  if (typeof window === 'undefined') return
  if (r.type === 'learning-journey') {
    emit('kg.learning_journey.linked_from_sidebar', {
      tutorialSlug: slug,
      journeySlug: r.slug,
    })
  } else if (r.type === 'blog-post') {
    emit('kg.blog_post.linked_from_sidebar', {
      tutorialSlug: slug,
      blogSlug: r.slug,
    })
  } else if (r.type === 'discovery-mission') {
    emit('kg.discovery_mission.linked_from_sidebar', {
      tutorialSlug: slug,
      missionSlug: r.slug,
    })
  } else if (r.type === 'video') {
    emit('kg.video.linked_from_sidebar', {
      tutorialSlug: slug,
      videoSlug: r.slug,
    })
  } else if (r.type === 'api-doc') {
    emit('kg.api-doc.linked_from_sidebar', {
      tutorialSlug: slug,
      apiDocSlug: r.slug,
    })
  } else if (r.type === 'sample') {
    emit('kg.sample.linked_from_sidebar', {
      tutorialSlug: slug,
      sampleSlug: r.slug,
    })
  }
}

// SidebarPanel emits legacy-fallback when the wire payload lacks
// typeConfig (older cached server response). Log a warn so we can
// measure CDN cache-refresh window; no state change — SidebarPanel
// already renders the fallback branch itself.
function onLegacyFallback(): void {
  console.warn(
    '[kg-sidebar] typeConfig missing on wire — falling back to inline per-type chain (CDN cache staleness?)',
  )
}

// ── Expansion state ───────────────────────────────────────────────────

function onOpen(): void {
  const now = Date.now()
  if (now < openLockedUntil) return
  openLockedUntil = now + 250
  if (expanded.value) return
  expanded.value = true
}

function onClose(): void {
  expanded.value = false
}

// ── Empty / fetch helpers ────────────────────────────────────────────
function isEmpty(body: NeighborhoodResult): boolean {
  // Spec: hide-on-empty is keyed off `teaches` — if no concepts have been
  // extracted for this tutorial yet, the whole panel hides. The other
  // three sections are derivative: no concepts → no shared / next /
  // prereqs by definition.
  return body.teaches.length === 0
}

async function loadNeighborhood(): Promise<void> {
  if (fetchTriggered.value || !slug) return
  fetchTriggered.value = true

  // Per-tab ETag cache. sessionStorage chosen over localStorage so a
  // graph rebuild that bumps `graphVersion` doesn't strand stale data
  // across days; per-tab is the right TTL for this surface.
  const cacheKey = `kg.sidebar.${slug}`
  let cached: { etag: string; body: NeighborhoodResult } | null = null
  try {
    const raw = sessionStorage.getItem(cacheKey)
    if (raw) cached = JSON.parse(raw)
  } catch {
    /* cache corrupted or sessionStorage disabled — ignore */
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (cached?.etag) headers['If-None-Match'] = cached.etag

  let res: Response
  try {
    res = await fetch(
      `/graph/neighborhood(slug='${encodeURIComponent(slug)}')`,
      { credentials: 'same-origin', headers },
    )
  } catch (err) {
    console.warn('[kg-sidebar] network error', err)
    state.value = 'error'
    return
  }

  // Kill-switch: KNOWLEDGE_GRAPH_ENABLED=false on the srv → 503.
  // Render nothing; reader sees no error.
  if (res.status === 503) {
    state.value = 'disabled'
    return
  }

  // Cache hit — reuse prior body.
  if (res.status === 304 && cached) {
    data.value = cached.body
    state.value = isEmpty(cached.body) ? 'empty' : 'ready'
    if (state.value === 'ready') announce(cached.body)
    return
  }

  if (!res.ok) {
    console.warn('[kg-sidebar] non-OK response', res.status)
    state.value = 'error'
    return
  }

  let body: NeighborhoodResult
  try {
    body = (await res.json()) as NeighborhoodResult
  } catch (err) {
    console.warn('[kg-sidebar] invalid JSON', err)
    state.value = 'error'
    return
  }

  const etag = res.headers.get('ETag')
  if (etag) {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ etag, body }))
    } catch {
      /* quota exceeded or disabled — drop cache silently */
    }
  }

  data.value = body
  state.value = isEmpty(body) ? 'empty' : 'ready'
  if (state.value === 'ready') announce(body)
}

// ── Lifecycle ────────────────────────────────────────────────────────
onMounted(() => {
  if (!slug) {
    state.value = 'error'
    console.warn('[kg-sidebar] missing data-page-slug; not fetching')
    return
  }

  // Environments without IntersectionObserver (very old browsers,
  // some test runners) — fetch immediately. Production happy path
  // is the observer below.
  if (typeof IntersectionObserver === 'undefined') {
    void loadNeighborhood()
    return
  }

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          void loadNeighborhood()
          observer?.disconnect()
          observer = null
          return
        }
      }
    },
    { rootMargin: '200px' },
  )
  if (rootEl.value) observer.observe(rootEl.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<style scoped>
/* Only the skeleton chrome + the 1 px anchor live here now; the
   real SidebarPanel carries its own scoped CSS. Skeleton mirrors
   the SidebarPanel surface so the swap to 'ready' doesn't reflow. */
.kg-sidebar {
  margin: 1rem 0 1.5rem;
  padding: 1.25rem 1.5rem;
  background: var(--sapList_Background, var(--sapBackgroundColor, #fff));
  border: 1px solid var(--sapList_BorderColor, #e5e5e5);
  border-radius: 0.5rem;
}

.kg-sidebar-header {
  margin: 0 0 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--sapList_BorderColor, #e5e5e5);
}

.kg-sidebar-header h2 {
  margin: 0 0 0.375rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
}

.kg-sidebar-help {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.kg-sidebar-anchor {
  width: 1px;
  height: 1px;
  margin: 0;
  padding: 0;
}

/* ── Skeleton loading state ──────────────────────────────────────────
 * Sized to match SidebarPanel: same border + padding so the panel
 * doesn't reflow when state flips to 'ready'. The shimmer comes from
 * the shared `.skeleton` / `@keyframes skeleton-shimmer` rules imported
 * above (hugo/assets/css/skeletons.css). The heading bars get a
 * narrower width than the body rows so they read as "headings" rather
 * than "first row of a list".
 */
.kg-sidebar--skeleton section + section {
  margin-top: 1rem;
}
.kg-sidebar-skel-heading {
  width: 60%;
  height: 0.875rem;
  margin: 0 0 0.75rem;
}
.kg-sidebar--skeleton ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.kg-sidebar--skeleton li {
  padding: 0.25rem 0;
}
.kg-sidebar--skeleton li .skeleton {
  height: 0.875rem;
  /* Variable row widths suggest variable-length titles — looks more
     organic than uniform 100%-width bars. Pure cosmetic. */
  width: 92%;
}
.kg-sidebar--skeleton li:nth-child(even) .skeleton { width: 78%; }
.kg-sidebar--skeleton li:nth-child(3n)   .skeleton { width: 85%; }
</style>

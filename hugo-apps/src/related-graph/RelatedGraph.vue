<!--
  hugo-apps/src/related-graph/RelatedGraph.vue
  Knowledge Graph sidebar island — PR 7 of issue #381.

  Mounts on the tutorial Object Page below the fold. Reads the page
  slug from <html data-page-slug="…"> ([[feedback_island_slug_source]]),
  lazy-fetches /graph/neighborhood(slug='…') once the panel scrolls
  within 200px of the viewport, and renders four sections:
    - This tutorial teaches  (concepts)
    - Prerequisites you might want first  (tutorials)
    - Tutorials covering related concepts  (tutorials)
    - What to learn next  (tutorials)

  Hide-on-empty: if the server returns no `teaches`, the panel does
  not render — there is no empty placeholder.

  Kill-switch: 503 from /graph/* (KNOWLEDGE_GRAPH_ENABLED=false) hides
  the panel silently — readers never see error UI. Network errors
  are warned to the console and otherwise swallowed.

  Telemetry — fired as window CustomEvents picked up by the existing
  UI_EVENTS_ENABLED bridge ([[project_204_deploy_flag_flipped]]):
    - kg.sidebar.shown        once on first non-empty render
    - kg.sidebar.click        on any tutorial item link click
    - kg.sidebar.hover_concept on concept hover (teaches section)
-->
<template>
  <aside
    v-if="state === 'ready' && data"
    ref="rootEl"
    class="kg-sidebar"
    aria-label="Related concepts and tutorials"
  >
    <!--
      Panel header — answers "what is this panel?" for a reader who scrolled
      past the first section H3. The intro line names the source (knowledge
      graph) and the signal (shared concepts) without going into the
      technical detail of how items are ranked.
    -->
    <header class="kg-sidebar-header">
      <h2>Related learning</h2>
      <p class="kg-sidebar-help">
        Powered by the knowledge graph — surfaces tutorials that share
        concepts with this one, plus what comes before and after on a
        natural learning path. Hover any link to see why it appears here.
      </p>
    </header>

    <section v-if="data.teaches.length > 0">
      <h3>This tutorial teaches</h3>
      <ul>
        <li
          v-for="concept in data.teaches"
          :key="concept.slug"
          :title="concept.description || ''"
          @mouseenter="onConceptHover(concept.slug)"
        >
          <!--
            Phase 3 (#446): when a public /concepts/<slug>/ landing page
            exists, render the concept as an in-site link so readers can
            follow it. Otherwise the name renders as plain text — the
            sidebar still surfaces what the tutorial teaches, just
            without a navigable destination.
          -->
          <a
            v-if="concept.published"
            :href="`/concepts/${concept.slug}/`"
            class="kg-sidebar-concept-link"
            @click="onConceptClick(concept.slug)"
          >{{ concept.name }}</a>
          <span v-else class="kg-sidebar-concept-text">{{ concept.name }}</span>
        </li>
      </ul>
    </section>

    <section v-if="data.prerequisitesOf.length > 0">
      <h3>Prerequisites you might want first</h3>
      <ul>
        <li v-for="t in data.prerequisitesOf" :key="t.slug">
          <a
            :href="`/tutorials/${t.slug}/`"
            :title="t.reason || ''"
            @click="onItemClick('prerequisitesOf', t.slug)"
          >{{ t.title || t.slug }}</a>
        </li>
      </ul>
    </section>

    <section v-if="data.sharedConcepts.length > 0">
      <h3>Tutorials covering related concepts</h3>
      <ul>
        <li v-for="t in data.sharedConcepts" :key="t.slug">
          <a
            :href="`/tutorials/${t.slug}/`"
            :title="t.reason || ''"
            @click="onItemClick('sharedConcepts', t.slug)"
          >{{ t.title || t.slug }}</a>
        </li>
      </ul>
    </section>

    <section v-if="data.whatToLearnNext.length > 0">
      <h3>What to learn next</h3>
      <ul>
        <li v-for="t in data.whatToLearnNext" :key="t.slug">
          <a
            :href="`/tutorials/${t.slug}/`"
            :title="t.reason || ''"
            @click="onItemClick('whatToLearnNext', t.slug)"
          >{{ t.title || t.slug }}</a>
        </li>
      </ul>
    </section>

    <!--
      Phase 4.1 (#447 §2.6): cross-corpus "Other resources" rail.
      Renders learning-journey rows joined by overlap on the tutorial's
      teaches concepts. The server-side handler in
      srv/knowledge-graph-service.js sorts by overlapCount and caps at
      the top 5; the client just renders what arrived.

      Hidden when empty — no empty placeholder. Future sub-phases (4.2-
      4.6) will widen the `type` discriminant; the `onOtherResourceClick`
      handler branches on `r.type` so each sub-phase can emit its own
      telemetry event.

      External links: `target="_blank" rel="noopener"` because journey
      URLs are on learning.sap.com (different origin).
    -->
    <section v-if="otherResources.length > 0" class="kg-section-other">
      <h3>Other resources</h3>
      <ul>
        <li v-for="r in otherResources" :key="r.slug">
          <a
            :href="r.url"
            target="_blank"
            rel="noopener"
            @click="onOtherResourceClick(r)"
          >{{ r.title }}</a>
          <span v-if="r.type === 'learning-journey' && (r.level || r.durationHours)" class="kg-sidebar-meta">
            <template v-if="r.level"> · {{ formatLevel(r.level) }}</template>
            <template v-if="r.durationHours"> · {{ r.durationHours }}h</template>
          </span>
          <span v-else-if="r.type === 'blog-post' && (r.authorName || r.postedAt)" class="kg-sidebar-meta">
            <template v-if="r.authorName"> · by {{ r.authorName }}</template>
            <template v-if="r.postedAt"> · {{ formatDate(r.postedAt) }}</template>
          </span>
          <span v-else-if="r.type === 'discovery-mission' && (r.effortLevel || r.categoryLabel)" class="kg-sidebar-meta">
            <template v-if="r.effortLevel"> · effort {{ r.effortLevel }}</template>
            <template v-if="r.categoryLabel"> · {{ r.categoryLabel }}</template>
          </span>
        </li>
      </ul>
    </section>
  </aside>

  <!--
    Hidden anchor used by IntersectionObserver before content arrives.
    aria-hidden + 1px footprint keep it out of accessibility tree
    and out of layout. Once data loads it's replaced by the <aside>
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
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import type { NeighborhoodResult, OtherResource, SidebarState } from './types'

const slug = (typeof document !== 'undefined' &&
  document.documentElement?.dataset?.pageSlug) || ''

const state = ref<SidebarState>('loading')
const data = ref<NeighborhoodResult | null>(null)
const rootEl = ref<HTMLElement | null>(null)
const fetchTriggered = ref(false)

// Phase 4.1 (#447 §2.6): the cross-corpus rail reads from
// `data.otherResources`. The field is optional on the wire (older cached
// payloads may not have it), so we coalesce to [] for the template guard.
const otherResources = computed<OtherResource[]>(
  () => data.value?.otherResources ?? [],
)

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

function onItemClick(
  type: 'prerequisitesOf' | 'sharedConcepts' | 'whatToLearnNext',
  targetSlug: string,
): void {
  emit('kg.sidebar.click', { type, targetSlug, slug })
}

function onConceptHover(conceptSlug: string): void {
  emit('kg.sidebar.hover_concept', { slug, conceptSlug })
}

// Phase 3 (#446): readers can now click through to a concept landing
// page. This emits a distinct event from kg.sidebar.click (which is
// tutorial→tutorial) so dashboards can measure concept-page CTR
// separately. Fires synchronously with the navigation; the <a> still
// follows its href normally (no preventDefault).
function onConceptClick(conceptSlug: string): void {
  emit('kg.concept.tutorial_clicked', { conceptSlug, tutorialSlug: slug })
}

// Phase 4.1 (#447 §2.6 + Q5): cross-corpus rail telemetry. Branches on
// `r.type` so each Phase 4 sub-phase can emit its own event without
// renaming this handler. Phase 4.2 adds the 'blog-post' branch. 4.3-4.6
// will add 'news', 'video', 'sample', 'discovery', 'resource'.
function formatLevel(level: string | null | undefined): string {
  if (!level) return ''
  return level.charAt(0).toUpperCase() + level.slice(1).toLowerCase()
}

// Phase 4.2 (#447 §9): blog-post `postedAt` is an ISO timestamp. Render it
// as a short month-day-year string ('en-US') matching the Hugo concept-page
// section's `dateFormat "Jan 2, 2006"` convention. On parse failure we fall
// back to the first 10 chars (YYYY-MM-DD prefix) so the row still renders
// something legible rather than 'Invalid Date'.
function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return (iso || '').slice(0, 10)
  }
}

function onOtherResourceClick(r: OtherResource): void {
  if (typeof window === 'undefined') return
  if (r.type === 'learning-journey') {
    emit('kg.learning_journey.linked_from_sidebar', {
      tutorialSlug: slug,
      journeySlug: r.slug,
    })
  } else if (r.type === 'blog-post') {
    // Phase 4.2 (#447 §9): mirror of the learning-journey branch — same
    // shape modulo the per-type slug field name.
    emit('kg.blog_post.linked_from_sidebar', {
      tutorialSlug: slug,
      blogSlug: r.slug,
    })
  } else if (r.type === 'discovery-mission') {
    // Phase 4.3 (#447 §8): third branch — same shape modulo the per-type
    // slug field name.
    emit('kg.discovery_mission.linked_from_sidebar', {
      tutorialSlug: slug,
      missionSlug: r.slug,
    })
  }
  // Future sub-phases branch here for their own telemetry events.
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
/* Mirrors the surface of tutorial-rating: bordered card, Horizon tokens. */
.kg-sidebar {
  margin: 1rem 0 1.5rem;
  padding: 1.25rem 1.5rem;
  background: var(--sapList_Background, var(--sapBackgroundColor, #fff));
  border: 1px solid var(--sapList_BorderColor, #e5e5e5);
  border-radius: 0.5rem;
}

/* Panel header — one-shot context above the per-section H3s so a reader who
   scrolls past the first section still knows what this panel is. */
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

/* The first section after the header doesn't need its own top-border —
   the header already provides the separator. */
.kg-sidebar-header + section h3 {
  border-bottom: 1px solid var(--sapList_BorderColor, #e5e5e5);
}

.kg-sidebar h3 {
  margin: 0 0 0.5rem;
  padding-bottom: 0.5rem;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  border-bottom: 1px solid var(--sapList_BorderColor, #e5e5e5);
}

.kg-sidebar section + section {
  margin-top: 1rem;
}

.kg-sidebar ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.kg-sidebar li {
  padding: 0.25rem 0;
  font-size: 0.875rem;
  color: var(--sapTextColor, #32363a);
}

.kg-sidebar a {
  color: var(--sapLinkColor, #0070f2);
  text-decoration: none;
}

.kg-sidebar a:hover,
.kg-sidebar a:focus {
  text-decoration: underline;
}

.kg-sidebar-anchor {
  width: 1px;
  height: 1px;
  margin: 0;
  padding: 0;
}
</style>

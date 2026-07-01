<!--
  hugo-apps/src/related-graph/SidebarPanel.vue
  Task 11 of KG widget redesign (#850).

  Presentational sidebar panel extracted from RelatedGraph.vue.
  Redesign changes vs. the pre-#850 sidebar:
    - "This tutorial teaches" section removed entirely.
    - Section order: Prereq → Other resources → Shared → Next.
    - Other-resources rows render via <ResourceRow> using the
      server-supplied typeConfig + metaText. No client-side v-if r.type chain
      on the happy path.

  Legacy fallback: when the wire payload has NO typeConfig (older cached
  responses), emit 'legacy-fallback' on mount so the parent can react, AND
  render the original per-type v-else-if chain inline as a belt-and-braces
  defense for the CDN cache-refresh window. Removed in a follow-up PR after
  24h. Both branches ship — the feature-detect just decides which is visible.

  The parent (RelatedGraph.vue after Task 13) owns fetching, telemetry, and
  expansion state. This component is purely presentational and communicates
  via emits: open-expanded, legacy-fallback, item-click, concept-click,
  concept-hover, resource-click.
-->
<template>
  <aside
    class="kg-sidebar"
    aria-label="Related concepts and tutorials"
  >
    <header class="kg-sidebar-header">
      <h2>Related learning</h2>
      <button
        type="button"
        class="kg-sidebar__expand-btn"
        aria-label="Expand to full view"
        @click="$emit('open-expanded')"
      >⤢</button>
      <p class="kg-sidebar-help">
        Powered by the knowledge graph — surfaces tutorials that share
        concepts with this one, plus what comes before and after on a
        natural learning path. Hover any link to see why it appears here.
      </p>
    </header>

    <section v-if="data.prerequisitesOf.length > 0">
      <h3>Prerequisites you might want first</h3>
      <ul>
        <li v-for="t in data.prerequisitesOf" :key="t.slug">
          <KgReasonPopover
            :text="t.title || t.slug"
            :reason="t.reason || null"
            :href="`/tutorials/${t.slug}/`"
            @click="$emit('item-click', 'prerequisitesOf', t.slug)"
          />
        </li>
      </ul>
    </section>

    <section v-if="otherResources.length > 0" class="kg-section-other">
      <h3>Other resources</h3>
      <!-- Happy path: server sent typeConfig; ResourceRow renders icon +
           link + metaText uniformly, no per-type branches on the client. -->
      <ul v-if="typeConfigMap">
        <ResourceRow
          v-for="r in otherResources"
          :key="r.slug"
          :config="resolveConfig(r.type)"
          :row="r"
          @click="$emit('resource-click', $event)"
        />
      </ul>
      <!-- Legacy fallback: no typeConfig on the wire (older cached
           server response). Renders the original per-type v-else-if chain
           lifted verbatim from RelatedGraph.vue lines 145-197. Defensive
           belt during the CDN cache-refresh window; will be removed in a
           follow-up PR after 24h. -->
      <ul v-else>
        <li v-for="r in otherResources" :key="r.slug">
          <a
            :href="r.url + (r.anchor ? '#' + r.anchor : '')"
            target="_blank"
            rel="noopener"
            @click="$emit('resource-click', r)"
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
          <span v-else-if="r.type === 'video' && (r.channelTitle || r.publishedAt)" class="kg-sidebar-meta">
            <template v-if="r.channelTitle"> · by {{ r.channelTitle }}</template>
            <template v-if="r.publishedAt"> · {{ formatDate(r.publishedAt) }}</template>
          </span>
          <span v-else-if="r.type === 'api-doc'" class="kg-sidebar-meta">
            · Official reference<template v-if="r.category"> · {{ r.category }}</template>
          </span>
          <span v-else-if="r.type === 'sample'" class="kg-sidebar-meta">
            <template v-if="r.language"> · {{ r.language }}</template>
            <template v-if="r.stars"> · {{ r.stars }} stars</template>
            <template v-if="r.lastCommitAt"> · Updated {{ formatRelativeMonth(r.lastCommitAt) }}</template>
          </span>
          <!--
            Phase 4.7 (#748 §4.8.2): help-doc legacy-fallback branch. Row
            shape per §3 Q10: `Title ↗ · <sourceLabel>`. Snippet + anchor
            label deliberately NOT rendered here (concept page only —
            space budget in the sidebar). The happy path routes through
            ResourceRow driven by the server's RESOURCE_TYPE_CONFIG entry
            for `help-doc` (priority 70, icon 📚, metaTemplate 'Source ·
            Anchor'); this branch only fires against cached responses
            older than Task 2 that lack `typeConfig` on the wire.
          -->
          <span v-else-if="r.type === 'help-doc'" class="kg-sidebar-meta">
            <template v-if="r.sourceLabel"> · <span class="kg-help-source" :class="`kg-help-source--${r.source}`">{{ r.sourceLabel }}</span></template>
          </span>
        </li>
      </ul>
    </section>

    <section v-if="data.sharedConcepts.length > 0">
      <h3>Tutorials covering related concepts</h3>
      <ul>
        <li v-for="t in data.sharedConcepts" :key="t.slug">
          <KgReasonPopover
            :text="t.title || t.slug"
            :reason="t.reason || null"
            :href="`/tutorials/${t.slug}/`"
            @click="$emit('item-click', 'sharedConcepts', t.slug)"
          />
        </li>
      </ul>
    </section>

    <section v-if="data.whatToLearnNext.length > 0">
      <h3>What to learn next</h3>
      <ul>
        <li v-for="t in data.whatToLearnNext" :key="t.slug">
          <KgReasonPopover
            :text="t.title || t.slug"
            :reason="t.reason || null"
            :href="`/tutorials/${t.slug}/`"
            @click="$emit('item-click', 'whatToLearnNext', t.slug)"
          />
        </li>
      </ul>
    </section>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { NeighborhoodResult, OtherResource, TypeConfigEntry } from './types'
import { formatRelativeMonth } from './related-graph-helpers'
import KgReasonPopover from './KgReasonPopover.vue'
import ResourceRow from './ResourceRow.vue'

const props = defineProps<{ data: NeighborhoodResult }>()

const emit = defineEmits<{
  (e: 'open-expanded'): void
  (e: 'legacy-fallback'): void
  (e: 'item-click', section: 'prerequisitesOf' | 'sharedConcepts' | 'whatToLearnNext', slug: string): void
  (e: 'resource-click', row: OtherResource): void
}>()

// Feature-detect: typeConfig present → use ResourceRow. Absent → legacy fallback.
const typeConfigMap = computed<Map<string, TypeConfigEntry> | null>(() => {
  if (!props.data.typeConfig || props.data.typeConfig.length === 0) return null
  return new Map(props.data.typeConfig.map((c) => [c.type, c]))
})

const otherResources = computed<OtherResource[]>(
  () => props.data.otherResources ?? [],
)

// Safely resolve a config entry for a row. If the server sent a row whose
// type isn't in typeConfig (shouldn't happen, but defensive), synthesize a
// minimal entry so ResourceRow doesn't crash — icon '' + empty template.
function resolveConfig(type: string): TypeConfigEntry {
  const entry = typeConfigMap.value?.get(type)
  if (entry) return entry
  return { type, icon: '', singular: type, plural: type, priority: 999, metaTemplate: '' }
}

// Legacy fallback helpers — used only when typeConfig is missing on the
// wire. Lifted verbatim from RelatedGraph.vue's original per-type chain.
function formatLevel(level: string | null | undefined): string {
  if (!level) return ''
  return level.charAt(0).toUpperCase() + level.slice(1).toLowerCase()
}
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

onMounted(() => {
  // `typeConfig` explicitly absent from the payload → old server or old
  // cached response. Signal the parent so it can log / measure the
  // fallback frequency. An empty array is also treated as legacy since
  // there's nothing to resolve rows against.
  if (!props.data.typeConfig || props.data.typeConfig.length === 0) {
    emit('legacy-fallback')
  }
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

.kg-sidebar-header {
  position: relative;
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

.kg-sidebar__expand-btn {
  position: absolute;
  top: 0;
  right: 0;
  background: transparent;
  border: 1px solid var(--sapList_BorderColor, #e5e5e5);
  border-radius: 0.25rem;
  padding: 0.125rem 0.375rem;
  font-size: 0.875rem;
  line-height: 1;
  color: var(--sapContent_LabelColor, #6a6d70);
  cursor: pointer;
}
.kg-sidebar__expand-btn:hover,
.kg-sidebar__expand-btn:focus {
  color: var(--sapLinkColor, #0070f2);
  border-color: var(--sapLinkColor, #0070f2);
}

.kg-sidebar-help {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--sapContent_LabelColor, #6a6d70);
}

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
</style>

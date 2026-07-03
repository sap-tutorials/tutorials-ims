<!--
  hugo-apps/src/related-graph/SidebarPanel.vue
  Task 11 of KG widget redesign (#850).

  Presentational sidebar panel extracted from RelatedGraph.vue.
  Redesign changes vs. the pre-#850 sidebar:
    - "This tutorial teaches" section removed entirely.
    - Section order: Prereq → Other resources → Shared → Next.
    - Other-resources rows render via <ResourceRow> using the
      server-supplied typeConfig + metaText. No client-side v-if r.type chain.

  The parent (RelatedGraph.vue after Task 13) owns fetching, telemetry, and
  expansion state. This component is purely presentational and communicates
  via emits: open-expanded, item-click, concept-click, concept-hover,
  resource-click.
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
      <!-- ResourceRow renders icon + link + metaText uniformly using the
           server-supplied typeConfig — no per-type branches on the client. -->
      <ul>
        <ResourceRow
          v-for="r in otherResources"
          :key="r.slug"
          :config="resolveConfig(r.type)"
          :row="r"
          @click="$emit('resource-click', $event)"
        />
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
import { computed } from 'vue'
import type { NeighborhoodResult, OtherResource, TypeConfigEntry } from './types'
import KgReasonPopover from './KgReasonPopover.vue'
import ResourceRow from './ResourceRow.vue'

const props = defineProps<{ data: NeighborhoodResult }>()

defineEmits<{
  (e: 'open-expanded'): void
  (e: 'item-click', section: 'prerequisitesOf' | 'sharedConcepts' | 'whatToLearnNext', slug: string): void
  (e: 'resource-click', row: OtherResource): void
}>()

const typeConfigMap = computed<Map<string, TypeConfigEntry>>(
  () => new Map((props.data.typeConfig ?? []).map((c) => [c.type, c])),
)

const otherResources = computed<OtherResource[]>(
  () => props.data.otherResources ?? [],
)

// Safely resolve a config entry for a row. If the server sent a row whose
// type isn't in typeConfig (shouldn't happen, but defensive), synthesize a
// minimal entry so ResourceRow doesn't crash — icon '' + empty template.
function resolveConfig(type: string): TypeConfigEntry {
  const entry = typeConfigMap.value.get(type)
  if (entry) return entry
  return { type, icon: '', singular: type, plural: type, priority: 999, metaTemplate: '' }
}
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

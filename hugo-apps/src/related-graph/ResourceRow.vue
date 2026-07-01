<!-- hugo-apps/src/related-graph/ResourceRow.vue
     Presentational component. Receives a resolved TypeConfigEntry + a
     row payload from the parent (SidebarPanel or ExpandedPanel).
     Renders icon (from config) + link (row.title -> row.url) + metaText
     (server-supplied) uniformly. NO v-if on r.type. NO client-side
     meta rendering — that's the server's job (via kg-resource-type-config).
     Task 10 of #850. -->
<template>
  <li class="kg-resource-row">
    <span class="kg-resource-row__icon" aria-hidden="true">{{ config.icon }}</span>
    <a
      :href="hrefWithAnchor"
      target="_blank"
      rel="noopener"
      class="kg-resource-row__link"
      @click="$emit('click', row)"
    >{{ row.title }}</a>
    <span
      v-if="row.metaText"
      class="kg-resource-row__meta"
    >{{ row.metaText }}</span>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { TypeConfigEntry, OtherResource } from './types'
const props = defineProps<{ config: TypeConfigEntry; row: OtherResource }>()
defineEmits<{ (e: 'click', row: OtherResource): void }>()

// Phase 4.7 (#748 §4.8.2): compose #anchor when the row carries one so
// deep-links to specific doc sections (help-doc rows today; other typed
// resources may gain anchors later) survive the sidebar → external nav
// hop. Generic on `row.anchor` — no help-doc-specific branch.
const hrefWithAnchor = computed(() =>
  props.row.url + (props.row.anchor ? '#' + props.row.anchor : '')
)
</script>

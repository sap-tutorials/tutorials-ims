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
      :href="row.url"
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
import type { TypeConfigEntry, OtherResource } from './types'
defineProps<{ config: TypeConfigEntry; row: OtherResource }>()
defineEmits<{ (e: 'click', row: OtherResource): void }>()
</script>

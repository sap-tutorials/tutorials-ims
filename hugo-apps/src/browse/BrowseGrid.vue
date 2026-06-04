<!--
  hugo-apps/src/browse/BrowseGrid.vue
  Renders the paginated card list. The Vue app mounts on #browse-root,
  so this component's rendered DOM IS the inner contents of #browse-root.
  Pagination links live OUTSIDE #browse-root (in the SSR'd
  <nav class="browse-pagination">) — controller.ts wires their click
  handlers to call goToPage on the shared filter state.
-->
<script setup lang="ts">
import MissionCard from '@shared/cards/MissionCard.vue'
import GroupCard from '@shared/cards/GroupCard.vue'
import TutorialCard from '@shared/cards/TutorialCard.vue'
import type { CardItem } from '@shared/types'
import type { ProgressPayload } from '../navigator/cardProgress'

defineProps<{
  items: CardItem[]
  progress: ProgressPayload
}>()
</script>

<template>
  <template v-for="item in items" :key="item.id">
    <MissionCard  v-if="item.type === 'mission'"   :item="item" :progress="progress" />
    <GroupCard    v-else-if="item.type === 'group'" :item="item" :progress="progress" />
    <TutorialCard v-else-if="item.type === 'tutorial'" :item="item" :progress="progress" />
  </template>
</template>

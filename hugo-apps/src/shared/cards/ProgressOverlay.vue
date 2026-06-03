<!--
  hugo-apps/src/shared/cards/ProgressOverlay.vue
  CSR-only progress decoration on a card. SSR renders nothing;
  client mounts the ring after onMounted. Used by all three
  shared card components (Mission/Group/Tutorial).
-->
<script setup lang="ts">
import { computed } from 'vue'
import ClientOnly from '../ClientOnly.vue'
import ProgressRing from '../ProgressRing.vue'
import { cardProgress, type ProgressPayload } from '../../navigator/cardProgress'
import type { CardItem } from '@shared/types'

const props = defineProps<{
  item: CardItem
  progress: ProgressPayload
}>()

const ringProps = computed(() => cardProgress(props.item, props.progress))
</script>

<template>
  <ClientOnly>
    <ProgressRing
      v-if="ringProps"
      class="nav-card__progress nav-card__progress--animate-in"
      v-bind="ringProps"
    />
  </ClientOnly>
</template>

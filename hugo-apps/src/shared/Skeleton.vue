<!-- hugo-apps/src/shared/Skeleton.vue
     U14: shared skeleton loader for Vue islands. Three modes — `card`, `text-line`,
     `rect`. The CSS lives in hugo/assets/css/skeletons.css and is inlined into
     each island bundle by vite-plugin-css-injected-by-js.
-->
<script setup lang="ts">
import '../../../hugo/assets/css/skeletons.css'

defineProps<{
  kind?: 'card' | 'text-line' | 'rect'
  count?: number
  height?: string
}>()
</script>

<template>
  <div class="skeleton-group" role="status" aria-busy="true" aria-label="Loading">
    <div
      v-for="i in (count ?? 1)"
      :key="i"
      class="skeleton"
      :class="`skeleton--${kind ?? 'rect'}`"
      :style="height ? { height } : undefined"
    ></div>
  </div>
</template>

<style scoped>
.skeleton-group {
  display: block;
}
</style>

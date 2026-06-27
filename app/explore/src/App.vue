<script setup lang="ts">
import { useGraphData } from './composables/useGraphData'
import ExploreGraph from './components/ExploreGraph.vue'

const { payload, hasData } = useGraphData()
</script>

<template>
  <main class="explore">
    <p v-if="!hasData" class="explore__empty">Loading graph…</p>
    <ExploreGraph
      v-else
      :nodes="payload!.nodes"
      :edges="payload!.edges"
    />
  </main>
</template>

<style>
.explore {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.explore__empty {
  text-align: center;
  margin-top: 4rem;
  color: #666;
}
</style>

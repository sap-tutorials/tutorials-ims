<template>
  <div data-app-space-game />
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { LevelModel } from './types'
import { isGameEnabled, isWebGLAvailable, loadAppSpaceData } from './feature'
import { buildLevelModel } from './level-model'

// Gate state — stays false until all conditions are satisfied
const ready = ref(false)
// Level model built from data — available when ready is true
const levelModel = ref<LevelModel | null>(null)

onMounted(async () => {
  // All three conditions must pass; any failure leaves ready false (grid intact)
  const [enabled, webgl] = await Promise.all([
    isGameEnabled(),
    Promise.resolve(isWebGLAvailable()),
  ])
  if (!enabled || !webgl) return

  const data = await loadAppSpaceData()
  if (!data) return

  // Build the level model (no renderer yet — Task 4 will consume this)
  levelModel.value = buildLevelModel(data)
  ready.value = true
})
</script>

<style scoped>
/* Task 3: gate wired; no visible rendering until Task 4 renderer */
</style>

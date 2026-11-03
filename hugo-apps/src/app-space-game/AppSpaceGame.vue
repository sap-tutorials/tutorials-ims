<template>
  <div data-app-space-game>
    <canvas ref="canvasRef" style="display:block;width:100%;height:100%" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { LevelModel } from './types'
import { isGameEnabled, isWebGLAvailable, loadAppSpaceData } from './feature'
import { buildLevelModel } from './level-model'
import type { GameHandle } from './renderer'

// Gate state - stays false until all conditions are satisfied
const ready = ref(false)
// Level model built from data - available when ready is true
const levelModel = ref<LevelModel | null>(null)
// Canvas ref for Three.js
const canvasRef = ref<HTMLCanvasElement | null>(null)
// Game handle for cleanup
let game: GameHandle | null = null

function onPickTrack(trackId: string): void {
  // Task 5 will wire real navigation here
  console.debug('[app-space-game] onPickTrack', trackId)
}

onMounted(async () => {
  // All three conditions must pass; any failure leaves ready false (grid intact)
  const [enabled, webgl] = await Promise.all([
    isGameEnabled(),
    Promise.resolve(isWebGLAvailable()),
  ])
  if (!enabled || !webgl) return

  const data = await loadAppSpaceData()
  if (!data) return

  // Build the level model
  levelModel.value = buildLevelModel(data)
  ready.value = true

  // Dynamic import - Three.js is code-split, only loaded after gate passes
  const { createGame } = await import('./renderer')

  const canvas = canvasRef.value
  if (!canvas) return

  game = createGame(canvas, levelModel.value, { onPickTrack })
  game.start()
})

onUnmounted(() => {
  game?.stop()
  game = null
})
</script>

<style scoped>
[data-app-space-game] {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #06080f;
}
</style>

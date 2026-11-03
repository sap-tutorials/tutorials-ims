<template>
  <div data-app-space-game>
    <!-- Demo trigger: only arm when gate passed -->
    <button
      v-if="gateReady"
      data-demo-trigger
      type="button"
      aria-label="Start Demo - watch Kasimir run through the App Space levels"
      @click="startAttract"
    >
      &#9654; Demo
    </button>

    <!-- Overlay dim wrapper: only shown during attract mode -->
    <div
      v-if="attractVisible"
      data-game-overlay
      role="dialog"
      aria-label="Kasimir Arcade Demo"
      aria-modal="true"
    />

    <!-- Canvas: always in DOM so canvasRef binds on mount; shown only in attract mode -->
    <canvas
      ref="canvasRef"
      :style="attractVisible ? 'display:block;width:100%;height:100%;position:relative;z-index:10000' : 'display:none'"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { LevelModel } from './types'
import { isGameEnabled, isWebGLAvailable, loadAppSpaceData } from './feature'
import { buildLevelModel } from './level-model'
import type { GameHandle } from './renderer'

// Default idle timeout before attract mode fires, in ms
const IDLE_TIMEOUT_MS = 60_000

// Gate state - stays false until all conditions are satisfied
const gateReady = ref(false)
// Level model built from data - available when gateReady is true
const levelModel = ref<LevelModel | null>(null)
// Canvas ref for Three.js
const canvasRef = ref<HTMLCanvasElement | null>(null)
// Whether the attract overlay is currently shown
const attractVisible = ref(false)
// Whether the user has taken control from attract mode
let inPlayerControl = false
// Game handle for cleanup
let game: GameHandle | null = null
// Idle timer handle
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** Returns true when the user prefers reduced motion. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Reset the idle countdown. When reduced motion is on, the timer never fires. */
function resetIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!gateReady.value || prefersReducedMotion()) return
  idleTimer = setTimeout(() => {
    startAttract()
  }, IDLE_TIMEOUT_MS)
}

/** Start attract mode: show overlay + call game.start(). */
function startAttract(): void {
  if (!game) return
  attractVisible.value = true
  inPlayerControl = false
  game.start()
}

/** Build the track URL preserving existing search params. */
function buildTrackUrl(trackId: string): string {
  const params = new URLSearchParams(window.location.search)
  params.set('track', trackId)
  const qs = params.toString()
  return window.location.pathname + (qs ? '?' + qs : '')
}

/** Called by the renderer when Kasimir reaches a goal. */
function onPickTrack(trackId: string): void {
  // 1. Update the URL without adding a history entry
  const newUrl = buildTrackUrl(trackId)
  window.history.replaceState({ track: trackId }, '', newUrl)
  // 2. Tell the grid island (AppSpace.vue popstate listener) to sync
  window.dispatchEvent(new PopStateEvent('popstate', { state: { track: trackId } }))
  // 3. Hide overlay and stop renderer
  attractVisible.value = false
  inPlayerControl = false
  game?.stop()
}

/** Handler called on any page-level input event. */
function onUserInput(): void {
  if (attractVisible.value && !inPlayerControl) {
    // Hand control to the player but keep overlay up
    inPlayerControl = true
    game?.setPlayerControl(true)
    return
  }
  // Not in attract mode - just reset idle timer
  if (!attractVisible.value) {
    resetIdleTimer()
  }
}

/** Events that reset the idle timer (or hand control in attract). */
const INPUT_EVENTS: string[] = ['mousemove', 'touchstart', 'keydown']

onMounted(async () => {
  // All three conditions must pass; any failure leaves gateReady false (grid intact)
  let enabled: boolean, webgl: boolean
  try {
    const results = await Promise.all([
      isGameEnabled(),
      Promise.resolve(isWebGLAvailable()),
    ])
    enabled = results[0]
    webgl = results[1]
  } catch {
    return
  }
  if (!enabled || !webgl) return

  let data
  try {
    data = await loadAppSpaceData()
  } catch {
    return
  }
  if (!data) return

  // Build the level model
  let model
  try {
    model = buildLevelModel(data)
  } catch {
    return
  }
  levelModel.value = model
  gateReady.value = true

  // Dynamic import - Three.js is code-split, only loaded after gate passes
  const { createGame } = await import('./renderer')

  const canvas = canvasRef.value
  if (!canvas) return

  game = createGame(canvas, levelModel.value, { onPickTrack })

  // Arm input listeners for idle timer and player-control handoff
  for (const ev of INPUT_EVENTS) {
    window.addEventListener(ev, onUserInput, { passive: true })
  }

  // Start the idle countdown
  resetIdleTimer()
})

onUnmounted(() => {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  for (const ev of INPUT_EVENTS) {
    window.removeEventListener(ev, onUserInput)
  }
  game?.stop()
  game = null
})
</script>

<style scoped>
[data-app-space-game] {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #06080f;
}

[data-demo-trigger] {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  padding: 6px 14px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  background: rgba(6, 8, 15, 0.8);
  color: #ffffff;
  font-size: 13px;
  font-family: system-ui, sans-serif;
  cursor: pointer;
}

[data-demo-trigger]:hover {
  background: rgba(30, 40, 70, 0.9);
}

[data-game-overlay] {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(6, 8, 15, 0.92);
}
</style>

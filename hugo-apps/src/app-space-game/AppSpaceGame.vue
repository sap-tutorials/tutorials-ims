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
    >
      <!-- Close / skip button - always visible so the user can always exit -->
      <button
        data-game-close
        type="button"
        aria-label="Close game and return to grid"
        @click="closeGame"
      >
        &#x2715; Close
      </button>

      <!-- Ring count HUD (top-right overlay, pointer-events:none) -->
      <div class="asg-rings" aria-live="polite" aria-label="Ring count">
        &#9711; {{ ringCount }}
      </div>

      <!-- Hit scatter toast: shown briefly after a hit -->
      <div
        v-if="showScatterToast"
        class="asg-scatter-toast"
        aria-live="assertive"
      >
        &minus;{{ scatterCount }}
      </div>

      <!-- Mute toggle button -->
      <button
        data-mute-toggle
        type="button"
        :aria-label="soundEnabled ? 'Mute sound' : 'Unmute sound'"
        @click="toggleMute"
      >
        {{ soundEnabled ? '&#128266;' : '&#128267;' }}
      </button>

      <!-- Player control hint shown once player has taken over -->
      <div v-if="showPlayerHint" data-player-hint aria-live="polite">
        Tap = jump &middot; Hold left/right = move &middot; Reach the flag to pick a track
      </div>
    </div>

    <!-- Canvas: always in DOM so canvasRef binds on mount; shown only in attract mode.
         position:fixed (not relative) is load-bearing: #app-space-game is an empty,
         zero-height mount div placed after the grid, so a relative/flow canvas lays
         out ~1740px down the page — off-screen — while the fixed overlay covers the
         viewport. The result: the renderer draws correctly but the canvas is nowhere
         the user can see it. Fixed + full-viewport anchors it over the overlay dim. -->
    <canvas
      ref="canvasRef"
      :style="attractVisible ? 'display:block;position:fixed;inset:0;width:100vw;height:100vh;z-index:10000' : 'display:none'"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import type { LevelModel } from './types'
import { isGameDisabled, isWebGLAvailable, loadAppSpaceData } from './feature'
import { buildLevelModel } from './level-model'
import type { GameHandle } from './renderer'
import { createSound } from './sound'

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
// Whether the player has taken over (shows hint)
const showPlayerHint = ref(false)
// Whether the user has taken control from attract mode
let inPlayerControl = false
// Game handle for cleanup
let game: GameHandle | null = null
// Idle timer handle
let idleTimer: ReturnType<typeof setTimeout> | null = null

// --- HUD state ---
const ringCount = ref(0)
const showScatterToast = ref(false)
const scatterCount = ref(0)
let scatterToastTimer: ReturnType<typeof setTimeout> | null = null

// --- Sound state ---
const sound = createSound()
const soundEnabled = ref(sound.enabled)

function toggleMute(): void {
  try {
    sound.toggle()
    soundEnabled.value = sound.enabled
  } catch {
    // fail-safe: never throw
  }
}

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
async function startAttract(): Promise<void> {
  if (!game) return
  attractVisible.value = true
  showPlayerHint.value = false
  inPlayerControl = false
  // Reset ring HUD
  ringCount.value = 0
  showScatterToast.value = false
  // The canvas is display:none until `attractVisible` flips it, and it is
  // position:fixed/full-viewport only while visible. Wait for Vue to flush the DOM
  // so the fixed canvas is laid out at its real viewport size before game.start()
  // runs its initial resizeToCanvas() — otherwise the camera aspect bakes against a
  // hidden/0-size canvas and the scene renders stretched. One nextTick suffices: a
  // position:fixed element has its size the moment the style applies (no paint frame
  // needed), and flushPromises() drives this in tests.
  await nextTick()
  // Guard: the user may have closed the overlay during the await.
  if (!attractVisible.value || !game) return
  game.start()
}

/** Close the game overlay without picking a track - return to grid as-is. */
function closeGame(): void {
  attractVisible.value = false
  showPlayerHint.value = false
  inPlayerControl = false
  game?.stop()
  resetIdleTimer()
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
  showPlayerHint.value = false
  inPlayerControl = false
  game?.stop()
}

/** Handler called on any page-level input event. */
function onUserInput(e: Event): void {
  // Escape key always closes the game overlay
  if (e instanceof KeyboardEvent && e.key === 'Escape' && attractVisible.value) {
    closeGame()
    return
  }

  if (attractVisible.value && !inPlayerControl) {
    // Hand control to the player but keep overlay up
    inPlayerControl = true
    showPlayerHint.value = true
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
  const safeStorage = (() => { try { return window.localStorage } catch { return null } })()
  if (isGameDisabled(window.location.search, safeStorage)) return

  // WebGL must be available
  if (!isWebGLAvailable()) return

  // Load data - the payload carries the feature flag
  let data
  try {
    data = await loadAppSpaceData()
  } catch {
    return
  }
  if (!data) return

  // Gate on the server-side flag (default OFF - absent or false means no game)
  if (data.appSpaceGameEnabled !== true) return

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

  // Wire ring count HUD callback
  try {
    game.onRingCount((n: number) => {
      const prev = ringCount.value
      ringCount.value = n
      // If count dropped (hit event), show scatter toast with the lost amount
      if (n < prev) {
        scatterCount.value = prev - n
        showScatterToast.value = true
        if (scatterToastTimer !== null) clearTimeout(scatterToastTimer)
        scatterToastTimer = setTimeout(() => {
          showScatterToast.value = false
        }, 800)
      }
    })
  } catch {
    // fail-safe: if callback setup throws, continue without it
  }

  // Wire event callback (for sound pickup)
  try {
    game.onEvent((e: 'hit' | 'pickup' | 'goal') => {
      if (e === 'pickup' || e === 'goal') {
        sound.blip()
      }
    })
  } catch {
    // fail-safe
  }

  // Arm input listeners for idle timer and player-control handoff
  for (const ev of INPUT_EVENTS) {
    window.addEventListener(ev, onUserInput, { passive: ev !== 'keydown' })
  }

  // Start the idle countdown
  resetIdleTimer()
})

onUnmounted(() => {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (scatterToastTimer !== null) {
    clearTimeout(scatterToastTimer)
    scatterToastTimer = null
  }
  for (const ev of INPUT_EVENTS) {
    window.removeEventListener(ev, onUserInput)
  }
  game?.stop()
  game?.dispose?.()
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
  /* Anchor to the viewport, not the mount div: #app-space-game is an empty,
     zero-height sibling placed after the grid, so position:absolute dropped the
     button ~1748px down the page (below the fold, never seen). Fixed keeps the
     manual attract-mode trigger visible in the corner regardless of scroll. */
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 998;
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

[data-game-close] {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 10001;
  padding: 6px 14px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 4px;
  background: rgba(6, 8, 15, 0.85);
  color: #ffffff;
  font-size: 13px;
  font-family: system-ui, sans-serif;
  cursor: pointer;
}

[data-game-close]:hover {
  background: rgba(60, 20, 20, 0.9);
}

.asg-rings {
  position: absolute;
  top: 16px;
  right: 72px;
  z-index: 10001;
  padding: 4px 12px;
  border-radius: 4px;
  background: rgba(6, 8, 15, 0.75);
  color: #ffd27a;
  font-size: 14px;
  font-family: system-ui, sans-serif;
  pointer-events: none;
  min-width: 3em;
  text-align: center;
}

.asg-scatter-toast {
  position: absolute;
  top: 52px;
  right: 72px;
  z-index: 10002;
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(200, 40, 40, 0.85);
  color: #ffffff;
  font-size: 13px;
  font-family: system-ui, sans-serif;
  pointer-events: none;
  animation: asg-fade-out 0.8s forwards;
}

@keyframes asg-fade-out {
  0% { opacity: 1; transform: translateY(0); }
  80% { opacity: 0.5; transform: translateY(-8px); }
  100% { opacity: 0; transform: translateY(-12px); }
}

[data-mute-toggle] {
  position: absolute;
  top: 16px;
  right: 120px;
  z-index: 10001;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  background: rgba(6, 8, 15, 0.8);
  color: #ffffff;
  font-size: 16px;
  font-family: system-ui, sans-serif;
  cursor: pointer;
}

[data-mute-toggle]:hover {
  background: rgba(30, 40, 70, 0.9);
}

[data-player-hint] {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10001;
  padding: 6px 16px;
  border-radius: 4px;
  background: rgba(6, 8, 15, 0.8);
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  font-family: system-ui, sans-serif;
  white-space: nowrap;
  pointer-events: none;
}
</style>

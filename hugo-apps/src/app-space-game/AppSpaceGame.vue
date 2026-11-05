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

    <!-- Game stage: always in the DOM so canvasRef/labelRootRef bind on mount; shown only while
         the game runs. position:fixed is load-bearing: #app-space-game is an empty, zero-height
         mount div placed after the grid, so a flow-positioned canvas lands ~1740px down the page. -->
    <div v-show="attractVisible" data-game-stage class="asg-stage">
      <canvas ref="canvasRef" class="asg-canvas" />
      <div ref="labelRootRef" class="asg-label-root" />
    </div>

    <!-- HUD + controls. Sits ABOVE the stage (z-index) and only intercepts pointer events
         on its own controls so taps still reach the canvas. -->
    <div
      v-if="attractVisible"
      data-game-overlay
      role="dialog"
      aria-label="Kasimir Arcade"
      aria-modal="true"
    >
      <div v-if="zone" class="asg-zone" :style="{ '--asg-accent': zone.color }" :key="zone.index" aria-live="polite">
        <span class="asg-zone__num">Zone {{ zone.index + 1 }} / {{ zone.total }}</span>
        <span class="asg-zone__title">{{ zone.title }}</span>
        <span v-if="zone.locked" class="asg-zone__lock">&#128274; Locked</span>
      </div>

      <div class="asg-hud-right">
        <div class="asg-rings" :class="{ 'is-bump': ringBump }" aria-live="polite" aria-label="Ring count">
          <span class="asg-rings__icon" aria-hidden="true" />
          <span class="asg-rings__count">{{ ringCount }}</span>
        </div>
        <button
          data-mute-toggle
          type="button"
          :aria-label="soundEnabled ? 'Mute sound' : 'Unmute sound'"
          @click="toggleMute"
        >
          {{ soundEnabled ? '&#128266;' : '&#128264;' }}
        </button>
        <button
          data-game-close
          type="button"
          aria-label="Close game and return to grid"
          @click="closeGame"
        >
          &#x2715; Close
        </button>
      </div>

      <div v-if="showScatterToast" class="asg-scatter-toast" aria-live="assertive">
        &minus;{{ scatterCount }} rings
      </div>

      <!-- Goal prompt: standing at a flag / chest in player mode -->
      <button
        v-if="goalPrompt && !goalPrompt.locked"
        data-goal-prompt
        type="button"
        class="asg-goal-prompt"
        @click="activateGoal"
      >
        <span class="asg-key">&#9650;</span> or <span class="asg-key">Enter</span>
        &nbsp;Open <strong>{{ goalPrompt.title }}</strong>
      </button>
      <div v-else-if="goalPrompt && goalPrompt.locked" data-goal-prompt class="asg-goal-prompt is-locked" role="status">
        &#128274; <strong>{{ goalPrompt.title }}</strong> is locked &mdash; finish its prerequisites first
      </div>

      <div v-else-if="!showPlayerHint" class="asg-attract-cta" aria-live="polite">
        Press any key or tap to play
      </div>
      <div v-else data-player-hint aria-live="polite">
        <span class="asg-key">&larr;</span><span class="asg-key">&rarr;</span> move &middot;
        <span class="asg-key">Space</span> jump &middot;
        <span class="asg-key">&#9650;</span> at a flag opens the track &middot;
        <span class="asg-key">Esc</span> exit
        <span class="asg-hint-touch">&middot; Touch: hold left/right edge to move, tap middle to jump</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import type { LevelModel } from './types'
import { isGameDisabled, isWebGLAvailable, loadAppSpaceData } from './feature'
import { buildLevelModel } from './level-model'
import type { GameHandle, GameEvent, GoalPrompt, ZoneInfo } from './renderer'
import { createSound } from './sound'

// Default idle timeout before attract mode fires, in ms
const IDLE_TIMEOUT_MS = 60_000
// A visitor who walks away mid-game hands control back to the autopilot after this long.
const PLAYER_IDLE_MS = 30_000

const gateReady = ref(false)
const levelModel = ref<LevelModel | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const labelRootRef = ref<HTMLElement | null>(null)
const attractVisible = ref(false)
const showPlayerHint = ref(false)
let inPlayerControl = false
let game: GameHandle | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let playerIdleTimer: ReturnType<typeof setTimeout> | null = null

function clearPlayerIdle(): void {
  if (playerIdleTimer !== null) {
    clearTimeout(playerIdleTimer)
    playerIdleTimer = null
  }
}

/** Restart the walk-away countdown while a visitor is playing. */
function armPlayerIdle(): void {
  clearPlayerIdle()
  playerIdleTimer = setTimeout(() => {
    playerIdleTimer = null
    if (!attractVisible.value || !inPlayerControl) return
    inPlayerControl = false
    showPlayerHint.value = false
    goalPrompt.value = null
    game?.setPlayerControl(false)
  }, PLAYER_IDLE_MS)
}

// --- HUD state ---
const ringCount = ref(0)
const ringBump = ref(false)
const showScatterToast = ref(false)
const scatterCount = ref(0)
const zone = ref<ZoneInfo | null>(null)
const goalPrompt = ref<GoalPrompt | null>(null)
let scatterToastTimer: ReturnType<typeof setTimeout> | null = null
let bumpTimer: ReturnType<typeof setTimeout> | null = null
// Set by a hit/fall event so the next ring drop shows the "−N" toast (a run reset does not).
let lossPending = false

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

/** Start attract mode: show the stage + HUD, then start the renderer. */
async function startAttract(): Promise<void> {
  if (!game || attractVisible.value) return
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  attractVisible.value = true
  showPlayerHint.value = false
  inPlayerControl = false
  ringCount.value = 0
  showScatterToast.value = false
  goalPrompt.value = null
  // Wait for Vue to show the fixed stage so the renderer sizes against the real viewport.
  await nextTick()
  if (!attractVisible.value || !game) return
  game.start()
}

function hideGame(): void {
  attractVisible.value = false
  showPlayerHint.value = false
  inPlayerControl = false
  goalPrompt.value = null
  clearPlayerIdle()
  game?.stop()
}

/** Close the game overlay without picking a track - return to grid as-is. */
function closeGame(): void {
  hideGame()
  resetIdleTimer()
}

function activateGoal(): void {
  try {
    game?.activateGoal?.()
  } catch {
    // fail-safe
  }
}

/** Build the track URL preserving existing search params. */
function buildTrackUrl(trackId: string): string {
  const params = new URLSearchParams(window.location.search)
  params.set('track', trackId)
  const qs = params.toString()
  return window.location.pathname + (qs ? '?' + qs : '')
}

/** Called by the renderer after the player opens a goal. */
function onPickTrack(trackId: string): void {
  const newUrl = buildTrackUrl(trackId)
  window.history.replaceState({ track: trackId }, '', newUrl)
  // Tell the grid island (AppSpace.vue popstate listener) to sync
  window.dispatchEvent(new PopStateEvent('popstate', { state: { track: trackId } }))
  hideGame()
}

function isOwnControl(e: Event): boolean {
  const t = e.target as Element | null
  return !!(t && typeof t.closest === 'function' && t.closest('[data-game-overlay] button'))
}

/**
 * Page-level input. While the demo runs, only a deliberate key press / tap hands control
 * to the visitor (mouse movement alone does not). Outside the demo, any input resets idle.
 */
function onUserInput(e: Event): void {
  if (e instanceof KeyboardEvent && e.key === 'Escape' && attractVisible.value) {
    closeGame()
    return
  }
  if (attractVisible.value) {
    if (inPlayerControl) {
      if (e.type !== 'mousemove') armPlayerIdle()
      return
    }
    if (e.type === 'mousemove' || isOwnControl(e)) return
    inPlayerControl = true
    showPlayerHint.value = true
    game?.setPlayerControl(true)
    armPlayerIdle()
    return
  }
  resetIdleTimer()
}

const INPUT_EVENTS: string[] = ['mousemove', 'touchstart', 'pointerdown', 'keydown']

function onRingCount(n: number): void {
  const prev = ringCount.value
  ringCount.value = n
  if (n > prev) {
    ringBump.value = false
    if (bumpTimer !== null) clearTimeout(bumpTimer)
    void nextTick(() => {
      ringBump.value = true
      bumpTimer = setTimeout(() => { ringBump.value = false }, 300)
    })
  } else if (n < prev && lossPending) {
    scatterCount.value = prev - n
    showScatterToast.value = true
    if (scatterToastTimer !== null) clearTimeout(scatterToastTimer)
    scatterToastTimer = setTimeout(() => {
      showScatterToast.value = false
    }, 1100)
  }
  lossPending = false
}

function onGameEvent(e: GameEvent): void {
  if (e === 'hit' || e === 'fall') lossPending = true
  if (e === 'pickup') sound.blip()
  else if (e === 'goal') sound.goal?.()
  else if (e === 'jump') sound.jump?.()
  else if (e === 'hit') sound.hit?.()
  else if (e === 'fall') sound.fall?.()
}

onMounted(async () => {
  const safeStorage = (() => { try { return window.localStorage } catch { return null } })()
  if (isGameDisabled(window.location.search, safeStorage)) return
  if (!isWebGLAvailable()) return

  let data
  try {
    data = await loadAppSpaceData()
  } catch {
    return
  }
  if (!data) return

  // Gate on the server-side flag (default OFF - absent or false means no game)
  if (data.appSpaceGameEnabled !== true) return

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

  // gateReady renders the stage; make sure its refs are bound.
  await nextTick()
  const canvas = canvasRef.value
  if (!canvas) return

  game = createGame(canvas, levelModel.value, {
    onPickTrack,
    labelRoot: labelRootRef.value,
    reducedMotion: prefersReducedMotion(),
  })

  try {
    game.onRingCount(onRingCount)
    game.onEvent(onGameEvent)
    game.onZone?.((z) => { zone.value = z })
    game.onGoalPrompt?.((g) => { goalPrompt.value = g })
  } catch {
    // fail-safe: continue without HUD callbacks
  }

  for (const ev of INPUT_EVENTS) {
    window.addEventListener(ev, onUserInput, { passive: ev !== 'keydown' })
  }
  resetIdleTimer()
})

onUnmounted(() => {
  for (const t of [idleTimer, scatterToastTimer, bumpTimer, playerIdleTimer]) {
    if (t !== null) clearTimeout(t)
  }
  idleTimer = scatterToastTimer = bumpTimer = playerIdleTimer = null
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
  /* Anchor to the viewport, not the zero-height mount div (see stage comment). */
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

.asg-stage {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: #06080f;
  overflow: hidden;
}

.asg-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}

.asg-label-root {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

/* The overlay stacks above the stage but lets taps fall through to the canvas. */
[data-game-overlay] {
  position: fixed;
  inset: 0;
  z-index: 10001;
  pointer-events: none;
  font-family: '72', '72full', system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #fff;
}

[data-game-overlay] button {
  pointer-events: auto;
}

.asg-hud-right {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 8px;
  align-items: center;
}

.asg-hud-right button {
  height: 40px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 20px;
  background: rgba(10, 14, 30, 0.7);
  backdrop-filter: blur(6px);
  color: #fff;
  font: inherit;
  font-size: 15px;
  cursor: pointer;
}

.asg-hud-right button:hover {
  background: rgba(40, 50, 90, 0.85);
}

.asg-rings {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px 0 10px;
  border-radius: 20px;
  background: rgba(10, 14, 30, 0.7);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 201, 74, 0.5);
  pointer-events: none;
}

.asg-rings__icon {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 5px solid #ffc94a;
  box-shadow: 0 0 10px rgba(255, 201, 74, 0.8), inset 0 0 4px rgba(120, 70, 0, 0.8);
}

.asg-rings__count {
  min-width: 2ch;
  font-size: 22px;
  font-weight: 800;
  color: #ffe08a;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 0 rgba(0, 0, 0, 0.5);
}

.asg-rings.is-bump {
  animation: asg-bump 0.3s ease-out;
}

@keyframes asg-bump {
  0% { transform: scale(1); }
  40% { transform: scale(1.18); }
  100% { transform: scale(1); }
}

.asg-scatter-toast {
  position: absolute;
  top: 22px;
  right: 268px;
  padding: 6px 14px;
  border-radius: 16px;
  background: rgba(220, 50, 60, 0.9);
  font-weight: 700;
  font-size: 15px;
  animation: asg-fade-out 1.1s forwards;
}

@keyframes asg-fade-out {
  0% { opacity: 1; transform: translateY(0); }
  70% { opacity: 0.8; transform: translateY(-6px); }
  100% { opacity: 0; transform: translateY(-12px); }
}

.asg-zone {
  position: absolute;
  top: 16px;
  left: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100vw - 340px);
  padding: 8px 20px 8px 8px;
  border-radius: 28px;
  background: rgba(10, 14, 30, 0.75);
  backdrop-filter: blur(6px);
  border: 2px solid var(--asg-accent, #5a8dee);
  box-shadow: 0 0 18px color-mix(in srgb, var(--asg-accent, #5a8dee) 50%, transparent);
  animation: asg-zone-in 0.45s ease-out;
}

@keyframes asg-zone-in {
  from { opacity: 0; transform: translateY(-12px); }
  to { opacity: 1; transform: translateY(0); }
}

.asg-zone__num {
  flex: none;
  padding: 4px 12px;
  border-radius: 16px;
  background: var(--asg-accent, #5a8dee);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.asg-zone__title {
  overflow: hidden;
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.asg-zone__lock {
  flex: none;
  font-size: 13px;
  color: #ffb02e;
}

.asg-goal-prompt,
.asg-attract-cta,
[data-player-hint] {
  position: absolute;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100vw - 32px);
  border-radius: 24px;
  backdrop-filter: blur(6px);
}

.asg-goal-prompt {
  padding: 12px 24px;
  border: 2px solid #ffc94a;
  background: rgba(30, 22, 6, 0.85);
  color: #fff;
  font: inherit;
  font-size: 18px;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 0 24px rgba(255, 201, 74, 0.45);
  animation: asg-pulse 1.2s ease-in-out infinite;
}

.asg-goal-prompt.is-locked {
  border-color: #8a8fa3;
  background: rgba(20, 22, 30, 0.85);
  box-shadow: none;
  animation: none;
  cursor: default;
}

@keyframes asg-pulse {
  0%, 100% { transform: translateX(-50%) scale(1); }
  50% { transform: translateX(-50%) scale(1.04); }
}

.asg-attract-cta {
  padding: 10px 26px;
  background: rgba(10, 14, 30, 0.7);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.04em;
  white-space: nowrap;
  animation: asg-blink 1.6s ease-in-out infinite;
}

@keyframes asg-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

[data-player-hint] {
  padding: 8px 18px;
  background: rgba(10, 14, 30, 0.7);
  color: rgba(255, 255, 255, 0.85);
  font-size: 14px;
  text-align: center;
}

.asg-key {
  display: inline-block;
  min-width: 1.6em;
  margin: 0 2px;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.12);
  font-size: 0.85em;
  font-weight: 700;
  text-align: center;
}

.asg-hint-touch {
  display: none;
}

@media (pointer: coarse) {
  .asg-hint-touch { display: inline; }
}

@media (max-height: 520px) {
  .asg-zone { padding: 4px 14px 4px 4px; }
  .asg-zone__title { font-size: 15px; }
  .asg-goal-prompt { bottom: 12px; padding: 8px 16px; font-size: 15px; }
  .asg-attract-cta, [data-player-hint] { bottom: 12px; font-size: 13px; }
}

@media (prefers-reduced-motion: reduce) {
  .asg-zone, .asg-goal-prompt, .asg-attract-cta, .asg-rings.is-bump { animation: none; }
}
</style>

<!-- Label elements are created by label-layer.ts at runtime, so their styles cannot be scoped. -->
<style>
.asg-labels {
  position: absolute;
  inset: 0;
  font-family: '72', '72full', system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.asg-label,
.asg-goal {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
  color: #fff;
  pointer-events: none;
}

.asg-label.is-hidden,
.asg-goal.is-hidden {
  display: none;
}

.asg-label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.asg-label__badge {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #ffc94a;
  color: #3b2600;
  font-size: 13px;
  font-weight: 800;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
}

.asg-label.is-done .asg-label__badge {
  background: #5fe07a;
  color: #08310f;
}

.asg-label.is-locked .asg-label__badge {
  background: #7b7f8c;
  color: #1c1e24;
}

.asg-label__title {
  display: none;
}

.asg-label.is-full {
  max-width: 280px;
  padding: 6px 12px 6px 6px;
  border-radius: 14px;
  background: rgba(8, 12, 28, 0.82);
  border: 1px solid rgba(255, 201, 74, 0.55);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}

.asg-label.is-full .asg-label__title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
}

.asg-label.is-full.is-done {
  border-color: rgba(95, 224, 122, 0.6);
}

.asg-goal {
  min-width: 180px;
  max-width: 300px;
  padding: 8px 14px;
  border-radius: 14px;
  background: rgba(8, 12, 28, 0.85);
  border: 2px solid var(--asg-accent, #ffc94a);
  box-shadow: 0 0 18px color-mix(in srgb, var(--asg-accent, #ffc94a) 45%, transparent);
  text-align: center;
}

.asg-goal__head {
  font-size: 16px;
  font-weight: 800;
  line-height: 1.25;
}

.asg-goal__sub {
  margin-top: 2px;
  font-size: 13px;
  color: #ffe08a;
}

.asg-goal.is-locked {
  border-color: #8a8fa3;
  box-shadow: none;
}

.asg-goal.is-locked .asg-goal__sub {
  color: #ffb02e;
}

.asg-label,
.asg-goal {
  transition: opacity 0.15s linear;
}

.asg-label.is-dim,
.asg-goal.is-dim {
  opacity: 0.3;
}

@media (max-height: 520px) {
  .asg-label.is-full { max-width: 220px; padding: 4px 10px 4px 4px; }
  .asg-label.is-full .asg-label__title { font-size: 13px; }
  .asg-label__badge { width: 22px; height: 22px; font-size: 12px; }
  .asg-goal { min-width: 150px; max-width: 240px; padding: 6px 10px; }
  .asg-goal__head { font-size: 14px; }
  .asg-goal__sub { font-size: 12px; }
}

.asg-floater {
  position: absolute;
  transform: translate(-50%, -50%);
  font-size: 26px;
  font-weight: 900;
  text-shadow: 0 2px 0 rgba(0, 0, 0, 0.6), 0 0 10px rgba(0, 0, 0, 0.4);
  animation: asg-float 0.95s ease-out forwards;
  pointer-events: none;
}

.asg-floater--gain { color: #ffe08a; }
.asg-floater--loss { color: #ff7b7b; }

@keyframes asg-float {
  0% { opacity: 0; transform: translate(-50%, -30%) scale(0.7); }
  15% { opacity: 1; transform: translate(-50%, -60%) scale(1.15); }
  100% { opacity: 0; transform: translate(-50%, -220%) scale(1); }
}
</style>

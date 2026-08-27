<script setup lang="ts">
/**
 * CatGame — a Chrome-dino-style Easter egg for the Devtoberfest home page
 * (issue #2042). Kasimir the cat wanders a bounded arena; click/tap (or focus +
 * Enter/Space) to "hit" him. Every hit plays a synthesized meow and shows
 * feedback. When signed in during the active contest, each qualifying hit POSTs
 * to the server-authoritative award endpoint (5 pts/day, once/day, cap 100) and
 * reflects the result. Anonymous visitors still get the meow + a gentle nudge.
 *
 * Points are awarded SERVER-SIDE — the client never decides scoring. It only
 * relays the reason string the endpoint returns.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { csrfFetch } from '@shared/csrf-fetch'
import type { CatGameAwardResponse } from './types'

const props = defineProps<{
  awardUrl: string
  imgCatGame: string
}>()

// Auth state — start unknown; a truthy /auth/user probe flips it on. A bare
// `res.ok` is NOT sufficient (the approuter answers anonymous AJAX with a 200
// HTML login page, not a 401), so we require JSON + a truthy `authenticated`
// flag. Mirrors petoberfest/lib/server.ts probeAuth().
const loggedIn = ref<boolean>(false)

async function probeAuth(): Promise<void> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' })
    if (!r.ok) return
    if (!((r.headers.get('content-type') || '').includes('json'))) return
    const body = await r.json()
    loggedIn.value = !!body?.authenticated
  } catch (e) {
    console.warn('[devtoberfest] cat-game auth probe failed', e)
  }
}

// --- Score readout (populated from award responses) ---
const total = ref<number | null>(null)
const cap = ref<number | null>(null)
const awardedToday = ref<boolean>(false)
const maxedOut = ref<boolean>(false)
const inactive = ref<boolean>(false)

const scoreText = computed<string>(() => {
  if (total.value == null || cap.value == null) return ''
  return `${total.value} / ${cap.value} points`
})

// --- Feedback (announced politely via aria-live) ---
const feedback = ref<string>('')

// --- Reduced motion ---
const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

// --- Cat position (percentages inside the arena) ---
const catX = ref<number>(50)
const catY = ref<number>(50)
const reacting = ref<boolean>(false)

let reactTimer: ReturnType<typeof setTimeout> | undefined
function triggerReaction(): void {
  reacting.value = true
  if (reactTimer) clearTimeout(reactTimer)
  reactTimer = setTimeout(() => { reacting.value = false }, 380)
}

function wander(): void {
  // Keep the cat inside the arena with a margin so its box never clips.
  catX.value = 10 + Math.random() * 80
  catY.value = 12 + Math.random() * 72
}

let wanderTimer: ReturnType<typeof setInterval> | undefined
function startWander(): void {
  if (prefersReducedMotion || wanderTimer) return
  wander()
  wanderTimer = setInterval(wander, 1200)
}

// --- Synthesized meow (Web Audio; no external asset). Only ever created on a
// user gesture (click / key), so no autoplay. Silently no-ops where Web Audio
// is unavailable (e.g. the test environment). ---
let audioCtx: AudioContext | null = null
function playMeow(): void {
  try {
    const Ctx =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    if (!audioCtx) audioCtx = new Ctx()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const now = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sawtooth'
    // Pitch-bend chirp: rise then fall ≈ "me-ow".
    osc.frequency.setValueAtTime(620, now)
    osc.frequency.exponentialRampToValueAtTime(940, now + 0.08)
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.30)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.03)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.36)
  } catch {
    /* audio is a nice-to-have; never the only feedback */
  }
}

// --- Anonymous nudge throttle (don't spam it every click) ---
let lastNudge = 0
function maybeAnonNudge(): void {
  const now = Date.now()
  if (now - lastNudge < 8000 && feedback.value) return
  lastNudge = now
  feedback.value = 'Log in during Devtoberfest to earn points \u{1F638}'
}

function applyAward(data: CatGameAwardResponse): void {
  if (typeof data.total === 'number') total.value = data.total
  if (typeof data.cap === 'number') cap.value = data.cap
  switch (data.reason) {
    case 'awarded': {
      awardedToday.value = true
      const pts = typeof data.points === 'number' ? data.points : 5
      feedback.value = `+${pts} points! ${total.value ?? ''}/${cap.value ?? ''} — come back tomorrow`
      break
    }
    case 'already-today':
      awardedToday.value = true
      feedback.value = `Already earned today — ${total.value ?? ''}/${cap.value ?? ''}`
      break
    case 'max':
      maxedOut.value = true
      feedback.value = `Maxed out! ${cap.value ?? ''}/${cap.value ?? ''} \u{1F389}`
      break
    case 'inactive':
      inactive.value = true
      feedback.value = "Devtoberfest isn't running right now"
      break
  }
}

let awarding = false
async function awardHit(): Promise<void> {
  if (!loggedIn.value) {
    maybeAnonNudge()
    return
  }
  if (awarding) return
  awarding = true
  try {
    const res = await csrfFetch(props.awardUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (res.status === 401) {
      // Session lapsed mid-play — fall back to the anonymous nudge.
      loggedIn.value = false
      maybeAnonNudge()
      return
    }
    if (!res.ok) {
      console.warn('[devtoberfest] cat-game award non-ok', res.status)
      return
    }
    const data = (await res.json()) as CatGameAwardResponse
    applyAward(data)
  } catch (e) {
    console.warn('[devtoberfest] cat-game award failed', e)
  } finally {
    awarding = false
  }
}

// Native <button> already fires @click on Enter/Space, so keyboard support is
// free — no extra keydown handler needed.
function onHit(): void {
  playMeow()
  triggerReaction()
  void awardHit()
}

onMounted(() => {
  void probeAuth()
  startWander()
})

onUnmounted(() => {
  if (wanderTimer) clearInterval(wanderTimer)
  if (reactTimer) clearTimeout(reactTimer)
  if (audioCtx) {
    try { void audioCtx.close() } catch { /* ignore */ }
    audioCtx = null
  }
})

defineExpose({ onHit })
</script>

<template>
  <section class="dtf-catgame" aria-labelledby="dtf-catgame-title">
    <h2 id="dtf-catgame-title" class="dtf-catgame-title">Tag the Cat</h2>
    <p class="dtf-catgame-lead">
      Kasimir won't sit still. Catch him for a meow &mdash; and, while
      Devtoberfest is running, sign in to earn 5 points a day (up to 100).
    </p>

    <div
      class="dtf-catgame-arena"
      :data-reduced="prefersReducedMotion ? 'true' : 'false'"
    >
      <button
        type="button"
        class="dtf-catgame-cat"
        :class="{ 'is-reacting': reacting }"
        :style="{ left: catX + '%', top: catY + '%' }"
        aria-label="Tag the cat"
        @click="onHit"
      >
        <img :src="imgCatGame" alt="" aria-hidden="true" class="dtf-catgame-cat-img" />
      </button>
    </div>

    <div class="dtf-catgame-hud">
      <p
        v-if="loggedIn && scoreText"
        class="dtf-catgame-score"
        :data-awarded="awardedToday ? 'true' : 'false'"
      >
        <span class="dtf-catgame-score-label">Your score:</span>
        <span class="dtf-catgame-score-value">{{ scoreText }}</span>
        <span v-if="maxedOut" class="dtf-catgame-badge">MAX</span>
        <span v-else-if="awardedToday" class="dtf-catgame-badge">TODAY ✓</span>
      </p>
      <p class="dtf-catgame-feedback" role="status" aria-live="polite">
        {{ feedback }}
      </p>
    </div>
  </section>
</template>

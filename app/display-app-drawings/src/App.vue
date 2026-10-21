<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useConfetti, type ConfettiParticle } from './composables/useConfetti'

// ── Types ────────────────────────────────────────
interface DrawEvent {
  legacyId: number
  name: string
  startDate: string
}

interface PoolResult {
  eventId: number
  eligibleCount: number
}

interface Winner {
  displayName: string
  email: string | null
}

interface DrawResult {
  winner: Winner | null
  eligibleCount: number
}

// ── Confetti ─────────────────────────────────────
const { particles: confettiParticles, active: confettiActive, burst } = useConfetti()

// ── State ─────────────────────────────────────────
const events = ref<DrawEvent[]>([])
const selectedEventId = ref<number | null>(null)
const eligibleCount = ref<number | null>(null)
const winner = ref<Winner | null | 'empty'>(null)
const loading = ref(false)
const poolLoading = ref(false)
const error = ref<string | null>(null)
const drawCount = ref(0)

// ── Computed ──────────────────────────────────────
const selectedEvent = computed(() =>
  events.value.find(e => e.legacyId === selectedEventId.value) ?? null
)

const poolEmpty = computed(() => eligibleCount.value === 0)

const drawDisabled = computed(() =>
  loading.value || poolLoading.value || poolEmpty.value || selectedEventId.value === null
)

const winnerName = computed(() =>
  winner.value && winner.value !== 'empty' ? winner.value.displayName : ''
)

const winnerEmail = computed(() => {
  if (!winner.value || winner.value === 'empty') return ''
  return winner.value.email ?? 'no email on file'
})

const showWinner = computed(() =>
  winner.value !== null && winner.value !== 'empty'
)

const showEmptyPool = computed(() =>
  winner.value === 'empty' || poolEmpty.value
)

// ── API helpers ───────────────────────────────────
async function fetchEvents(): Promise<void> {
  error.value = null
  try {
    const res = await fetch('/drawings/listEvents()')
    if (!res.ok) throw new Error(`listEvents failed: ${res.status}`)
    const data = await res.json() as { value: DrawEvent[] }
    events.value = data.value
    if (data.value.length > 0) {
      selectedEventId.value = data.value[0].legacyId
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function fetchPool(eventId: number): Promise<void> {
  poolLoading.value = true
  error.value = null
  try {
    const res = await fetch(`/drawings/pool(eventId=${eventId})`)
    if (!res.ok) throw new Error(`pool failed: ${res.status}`)
    const data = await res.json() as PoolResult
    eligibleCount.value = data.eligibleCount
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    eligibleCount.value = null
  } finally {
    poolLoading.value = false
  }
}

async function doDraw(): Promise<void> {
  if (selectedEventId.value === null) return
  loading.value = true
  error.value = null
  winner.value = null
  try {
    const res = await fetch(`/drawings/draw(eventId=${selectedEventId.value})`)
    if (!res.ok) throw new Error(`draw failed: ${res.status}`)
    const data = await res.json() as DrawResult
    eligibleCount.value = data.eligibleCount
    if (data.winner === null) {
      winner.value = 'empty'
    } else {
      winner.value = data.winner
      drawCount.value++
      burst()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

// ── Watch event selection ─────────────────────────
watch(selectedEventId, (id) => {
  winner.value = null
  if (id !== null) {
    void fetchPool(id)
  } else {
    eligibleCount.value = null
  }
})

// ── Assets ────────────────────────────────────────
// Public-folder assets are served at BASE_URL; construct the path
// so the bundler doesn't try to resolve it as a module.
const kasimirSrc = import.meta.env.BASE_URL + 'kasimir-tuxedo.png'

// ── Mount ─────────────────────────────────────────
onMounted(async () => {
  await fetchEvents()
  if (selectedEventId.value !== null) {
    await fetchPool(selectedEventId.value)
  }
})
</script>

<template>
  <div class="drawings-app">
    <!-- SAP Horizon token layer -->

    <!-- Confetti Overlay -->
    <div v-if="confettiActive" class="confetti-overlay">
      <div
        v-for="p in confettiParticles"
        :key="p.id"
        class="confetti-particle"
        :class="p.shape"
        :style="{
          left: p.x + '%',
          top: p.y + '%',
          '--c-color': p.color,
          '--c-size': p.size + 'px',
          '--c-rotation': p.rotation + 'deg',
          '--c-delay': p.delay + 's',
        }"
      ></div>
    </div>

    <!-- Error Banner -->
    <div v-if="error" class="error-banner" role="alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" aria-hidden="true">
        <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      {{ error }}
    </div>

    <!-- Main layout -->
    <div class="main-layout">

      <!-- ── Control Panel ───────────────────────────── -->
      <aside class="control-panel">
        <div class="panel-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28" aria-hidden="true">
            <path d="M12 3v1m0 16v1M3 12h1m16 0h1m-3.343-7.657-.707.707M6.05 17.95l-.707.707m0-12.314.707.707M17.95 17.95l.707.707M8 12a4 4 0 118 0 4 4 0 01-8 0z"/>
          </svg>
          <span class="panel-title">Daily Drawing</span>
        </div>

        <!-- Event selector -->
        <div class="field-group">
          <label class="field-label" for="event-select">Event</label>
          <select
            id="event-select"
            v-model="selectedEventId"
            class="event-select"
            :disabled="events.length === 0"
          >
            <option v-if="events.length === 0" :value="null">Loading events…</option>
            <option v-for="ev in events" :key="ev.legacyId" :value="ev.legacyId">
              {{ ev.name }}
            </option>
          </select>
        </div>

        <!-- Pool size -->
        <div class="pool-info">
          <template v-if="poolLoading">
            <span class="pool-count pool-count--loading">Checking pool…</span>
          </template>
          <template v-else-if="eligibleCount !== null">
            <span class="pool-count" :class="{ 'pool-count--empty': poolEmpty }">
              <strong>{{ eligibleCount }}</strong> eligible
            </span>
          </template>
        </div>

        <!-- Empty pool notice -->
        <p v-if="poolEmpty && !poolLoading" class="empty-notice">
          No prize claims scanned yet for this event.
        </p>

        <!-- Draw button -->
        <button
          class="draw-btn"
          :disabled="drawDisabled"
          :aria-busy="loading"
          @click="doDraw"
        >
          <svg v-if="loading" class="spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke-opacity="0.3"/>
            <path d="M12 3a9 9 0 019 9"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22" aria-hidden="true">
            <path d="M12 2a10 10 0 110 20A10 10 0 0112 2zm0 5l-1 4-4 1 4 1 1 4 1-4 4-1-4-1-1-4z"/>
          </svg>
          {{ loading ? 'Drawing…' : 'Draw Winner' }}
        </button>
      </aside>

      <!-- ── Reveal Stage ────────────────────────────── -->
      <section class="reveal-stage" aria-live="polite" aria-label="Winner reveal">

        <!-- Idle state -->
        <div v-if="!showWinner && !showEmptyPool" class="idle-state">
          <div class="idle-icon" aria-hidden="true">🎟️</div>
          <p class="idle-text">Select an event and press <strong>Draw Winner</strong></p>
        </div>

        <!-- Winner reveal -->
        <Transition name="winner-fade">
          <div v-if="showWinner" :key="drawCount" class="winner-reveal">
            <img
              class="mascot"
              :src="kasimirSrc"
              alt="Kasimir the mascot celebrating"
              width="220"
            />
            <div class="winner-card">
              <div class="winner-label">Winner</div>
              <div class="winner-name">{{ winnerName }}</div>
              <div class="winner-email">{{ winnerEmail }}</div>
            </div>
          </div>
        </Transition>

        <!-- Empty pool (draw returned null) -->
        <div v-if="winner === 'empty'" class="empty-state">
          <div class="empty-icon" aria-hidden="true">🫙</div>
          <p class="empty-text">No prize claims scanned yet for this event.</p>
        </div>

      </section>
    </div>
  </div>
</template>

<style>
/* ── SAP Horizon tokens ────────────────────────── */
:root {
  --sapBackgroundColor: #f5f6f7;
  --sapBaseColor: #fff;
  --sapBrandColor: #0070f2;
  --sapHighlightColor: #0064d9;
  --sapShellColor: #354a5f;
  --sapShell_TextColor: #fff;
  --sapTextColor: #32363a;
  --sapNeutralTextColor: #6a6d70;
  --sapNeutralBorderColor: #d9d9d9;
  --sapNeutralBackground: #f5f6f7;
  --sapPositiveColor: #107e3e;
  --sapNegativeColor: #b00;
  --sapCriticalColor: #e9730c;
  --sapFontFamily: '72', '72full', Arial, Helvetica, sans-serif;
  --sapButton_BorderCornerRadius: 0.5rem;
  --sapContent_Shadow0: 0 1px 4px rgba(0,0,0,.06);
  --sapContent_Shadow2: 0 0.25rem 1rem rgba(0,0,0,.15);
  --sapContent_ContrastTextColor: #fff;

  /* Drawings semantic aliases */
  --dw-bg: var(--sapBackgroundColor);
  --dw-surface: var(--sapBaseColor);
  --dw-accent: var(--sapBrandColor);
  --dw-text: var(--sapTextColor);
  --dw-text-dim: var(--sapNeutralTextColor);
  --dw-border: var(--sapNeutralBorderColor);
  --dw-shadow: var(--sapContent_Shadow0);
  --dw-shadow-elevated: var(--sapContent_Shadow2);
  --dw-positive: var(--sapPositiveColor);
  --dw-negative: var(--sapNegativeColor);
  --dw-hero-gradient: linear-gradient(135deg, #354a5f 0%, #2c3e50 40%, #1a252f 100%);

  /* Confetti colours */
  --d-confetti-1: #0070f2;
  --d-confetti-2: #107e3e;
  --d-confetti-3: #e9730c;
}

/* ── Reset ─────────────────────────────────────── */
* { margin: 0; padding: 0; box-sizing: border-box; }

.drawings-app {
  font-family: var(--sapFontFamily);
  background: var(--dw-bg);
  color: var(--dw-text);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}

/* ── Error banner ──────────────────────────────── */
.error-banner {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: #ffeaef;
  color: #880000;
  border-bottom: 2px solid #b00;
  padding: 0.625rem 1.25rem;
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.9rem; font-weight: 600;
}

/* ── Confetti overlay ──────────────────────────── */
.confetti-overlay {
  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 200;
  overflow: hidden;
}

.confetti-particle {
  position: absolute;
  background: var(--c-color);
  width: var(--c-size);
  height: var(--c-size);
  animation: confetti-fall 3.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) var(--c-delay) forwards;
  opacity: 0;
}
.confetti-particle.square { border-radius: 2px; }
.confetti-particle.circle { border-radius: 50%; }
.confetti-particle.strip  { width: calc(var(--c-size) * 0.35); border-radius: 1px; }

@keyframes confetti-fall {
  0%   { opacity: 1; transform: translateY(0) rotate(var(--c-rotation)) scale(0); }
  10%  { opacity: 1; transform: translateY(-20px) rotate(var(--c-rotation)) scale(1); }
  90%  { opacity: 0.6; }
  100% { opacity: 0; transform: translateY(100vh) rotate(calc(var(--c-rotation) + 720deg)) scale(0.5); }
}

/* ── Main layout ───────────────────────────────── */
.main-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* ── Control panel (left sidebar) ─────────────── */
.control-panel {
  width: clamp(280px, 26vw, 380px);
  background: var(--dw-hero-gradient);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 2rem 1.75rem;
  box-shadow: 4px 0 12px rgba(0,0,0,0.15);
  z-index: 10;
}

.panel-header {
  display: flex; align-items: center; gap: 0.75rem;
  color: #fff;
  border-bottom: 1px solid rgba(255,255,255,0.15);
  padding-bottom: 1.25rem;
}

.panel-title {
  font-size: clamp(1.1rem, 2vw, 1.4rem);
  font-weight: 700;
  letter-spacing: 0.02em;
}

/* Event selector */
.field-group {
  display: flex; flex-direction: column; gap: 0.4rem;
}

.field-label {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.65);
}

.event-select {
  width: 100%;
  padding: 0.625rem 0.875rem;
  border-radius: var(--sapButton_BorderCornerRadius);
  border: 1px solid rgba(255,255,255,0.25);
  background: rgba(255,255,255,0.1);
  color: #fff;
  font-family: var(--sapFontFamily);
  font-size: clamp(0.875rem, 1.4vw, 1.1rem);
  cursor: pointer;
  outline: none;
  transition: border-color 0.2s, background 0.2s;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.7)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.75rem center;
  background-size: 16px;
  padding-right: 2.25rem;
}
.event-select:focus { border-color: rgba(255,255,255,0.6); background: rgba(255,255,255,0.15); }
.event-select:disabled { opacity: 0.5; cursor: not-allowed; }
.event-select option { background: #354a5f; color: #fff; }

/* Pool info */
.pool-info { min-height: 1.5rem; }

.pool-count {
  font-size: clamp(0.9rem, 1.5vw, 1.15rem);
  color: rgba(255,255,255,0.85);
  font-weight: 500;
}
.pool-count strong {
  font-size: clamp(1.2rem, 2vw, 1.6rem);
  font-weight: 700;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.pool-count--empty strong { color: #f0ab00; }
.pool-count--loading { color: rgba(255,255,255,0.5); font-style: italic; }

/* Empty notice */
.empty-notice {
  font-size: 0.875rem;
  color: #f0ab00;
  line-height: 1.4;
  background: rgba(240,171,0,0.1);
  border: 1px solid rgba(240,171,0,0.3);
  border-radius: 0.375rem;
  padding: 0.625rem 0.875rem;
}

/* Draw button */
.draw-btn {
  margin-top: auto;
  display: flex; align-items: center; justify-content: center; gap: 0.6rem;
  padding: 0.875rem 1.5rem;
  border: none;
  border-radius: var(--sapButton_BorderCornerRadius);
  background: var(--sapBrandColor);
  color: #fff;
  font-family: var(--sapFontFamily);
  font-size: clamp(1rem, 1.8vw, 1.3rem);
  font-weight: 700;
  cursor: pointer;
  letter-spacing: 0.02em;
  transition: background 0.2s, transform 0.1s, opacity 0.2s;
  box-shadow: 0 4px 12px rgba(0,112,242,0.35);
}
.draw-btn:hover:not(:disabled) { background: #0064d9; transform: translateY(-1px); }
.draw-btn:active:not(:disabled) { transform: translateY(0); }
.draw-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; transform: none; }

.spin-icon {
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Reveal stage (right) ──────────────────────── */
.reveal-stage {
  flex: 1;
  display: flex; align-items: center; justify-content: center;
  background: var(--dw-bg);
  position: relative;
  overflow: hidden;
}

/* Idle */
.idle-state {
  display: flex; flex-direction: column; align-items: center; gap: 1.25rem;
  opacity: 0.45;
}
.idle-icon { font-size: clamp(3rem, 6vw, 5rem); }
.idle-text {
  font-size: clamp(1rem, 2vw, 1.5rem);
  color: var(--dw-text-dim);
  text-align: center;
}
.idle-text strong { color: var(--dw-accent); }

/* Winner reveal */
.winner-fade-enter-active { transition: opacity 0.5s ease, transform 0.5s ease; }
.winner-fade-leave-active  { transition: opacity 0.3s ease, transform 0.3s ease; }
.winner-fade-enter-from { opacity: 0; transform: translateY(24px) scale(0.95); }
.winner-fade-leave-to   { opacity: 0; transform: translateY(-12px) scale(0.98); }

.winner-reveal {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2rem;
  text-align: center;
  padding: 2rem;
}

.mascot {
  width: clamp(140px, 18vw, 260px);
  height: auto;
  filter: drop-shadow(0 8px 24px rgba(0,112,242,0.2));
  animation: mascot-bounce 1s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

@keyframes mascot-bounce {
  0%  { transform: scale(0.5) translateY(30px); opacity: 0; }
  60% { transform: scale(1.05) translateY(-6px); opacity: 1; }
  80% { transform: scale(0.97) translateY(2px); }
  100%{ transform: scale(1) translateY(0); opacity: 1; }
}

.winner-card {
  display: flex; flex-direction: column; gap: 0.75rem;
  background: var(--dw-surface);
  border: 1px solid var(--dw-border);
  border-radius: 1rem;
  padding: clamp(1.5rem, 3vw, 2.5rem) clamp(2rem, 4vw, 4rem);
  box-shadow: var(--dw-shadow-elevated);
}

.winner-label {
  font-size: clamp(0.75rem, 1.2vw, 1rem);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--dw-text-dim);
}

.winner-name {
  font-size: clamp(2.5rem, 7vw, 6.5rem);
  font-weight: 700;
  color: var(--dw-accent);
  line-height: 1.05;
  letter-spacing: -0.01em;
  animation: name-slide 0.6s 0.15s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes name-slide {
  from { opacity: 0; transform: translateX(-18px); }
  to   { opacity: 1; transform: translateX(0); }
}

.winner-email {
  font-size: clamp(1rem, 2vw, 1.75rem);
  color: var(--dw-text-dim);
  font-weight: 400;
  font-style: italic;
  animation: name-slide 0.6s 0.3s cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* Empty draw state */
.empty-state {
  display: flex; flex-direction: column; align-items: center; gap: 1rem;
}
.empty-icon { font-size: clamp(3rem, 6vw, 5rem); opacity: 0.5; }
.empty-text {
  font-size: clamp(1rem, 2vw, 1.5rem);
  color: var(--dw-text-dim);
  text-align: center;
  max-width: 400px;
  line-height: 1.5;
}
</style>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useEventStream, type Bucket } from './useEventStream'

const isDark = ref(document.documentElement.dataset.theme === 'dark')
const activeTheme = ref<'joule' | 'sapphire' | null>(null)

const eventId = ref<number | null>(null)
const bucketCount = ref<number | null>(null)
const isDemo = ref(false)

const {
  buckets,
  totalCount,
  connectionState,
  errorMessage,
  connect,
  startDemo,
  disconnect,
} = useEventStream()

const displayedCount = ref(0)
let animationFrame: number | null = null

watch(totalCount, (newVal) => {
  const start = displayedCount.value
  const diff = newVal - start
  if (diff === 0) return
  const duration = Math.min(1500, Math.max(300, diff * 50))
  const startTime = performance.now()

  function animate(now: number) {
    const elapsed = now - startTime
    const progress = Math.min(elapsed / duration, 1)
    const eased = 1 - Math.pow(1 - progress, 3)
    displayedCount.value = Math.round(start + diff * eased)
    if (progress < 1) {
      animationFrame = requestAnimationFrame(animate)
    }
  }
  if (animationFrame) cancelAnimationFrame(animationFrame)
  animationFrame = requestAnimationFrame(animate)
})

const maxCount = computed(() => {
  if (buckets.value.length === 0) return 1
  return buckets.value[0]?.count ?? 1
})

const visibleBuckets = computed(() => {
  const all = buckets.value as Bucket[]
  if (!bucketCount.value || all.length <= bucketCount.value) return all

  const top = all.slice(0, bucketCount.value)
  const rest = all.slice(bucketCount.value)
  const otherCount = rest.reduce((sum, b) => sum + b.count, 0)
  const otherUpdated = rest.some(b => b.justUpdated)

  return [
    ...top,
    { name: 'Other', count: otherCount, justUpdated: otherUpdated },
  ]
})

const eventLabel = computed(() => {
  if (activeTheme.value === 'sapphire') return 'SAP Sapphire'
  if (activeTheme.value === 'joule') return 'SAP TechEd'
  return 'Event'
})

const showSetup = computed(() =>
  !isDemo.value && !eventId.value
)

function barWidth(count: number): string {
  if (maxCount.value === 0) return '0%'
  return `${(count / maxCount.value) * 100}%`
}

function formatCount(n: number): string {
  return n.toLocaleString()
}

onMounted(() => {
  const params = new URLSearchParams(window.location.search)

  const theme = params.get('theme')
  if (theme === 'joule' || theme === 'sapphire') activeTheme.value = theme

  isDemo.value = params.get('demo') === 'true'
  const eid = params.get('eventId')
  if (eid) eventId.value = parseInt(eid, 10)
  const bc = params.get('bucketCount')
  if (bc) bucketCount.value = parseInt(bc, 10)

  if (isDemo.value) {
    startDemo()
  } else if (eventId.value) {
    connect('', eventId.value)
  }
})
</script>

<template>
  <div
    class="event-display"
    :data-theme="activeTheme ?? undefined"
    :data-dark="isDark ? '' : undefined"
  >
    <!-- Setup prompt when missing params -->
    <div v-if="showSetup" class="setup-prompt">
      <div class="setup-card">
        <div class="fd-message-strip fd-message-strip--information" role="note">
          <p class="fd-message-strip__text">
            Configure the display via URL parameters.
          </p>
        </div>
        <h2>Event Display Setup</h2>
        <p>Add the following URL parameters to get started:</p>
        <table class="fd-table">
          <thead class="fd-table__header">
            <tr class="fd-table__row">
              <th class="fd-table__cell fd-table__cell--header">Parameter</th>
              <th class="fd-table__cell fd-table__cell--header">Required</th>
              <th class="fd-table__cell fd-table__cell--header">Description</th>
            </tr>
          </thead>
          <tbody class="fd-table__body">
            <tr class="fd-table__row">
              <td class="fd-table__cell"><code>demo=true</code></td>
              <td class="fd-table__cell">-</td>
              <td class="fd-table__cell">Run with simulated data</td>
            </tr>
            <tr class="fd-table__row">
              <td class="fd-table__cell"><code>eventId</code></td>
              <td class="fd-table__cell">Yes</td>
              <td class="fd-table__cell">Event ID (e.g. 38)</td>
            </tr>
            <tr class="fd-table__row">
              <td class="fd-table__cell"><code>bucketCount</code></td>
              <td class="fd-table__cell">No</td>
              <td class="fd-table__cell">Max tags to show individually (rest grouped as "Other")</td>
            </tr>
            <tr class="fd-table__row">
              <td class="fd-table__cell"><code>theme</code></td>
              <td class="fd-table__cell">No</td>
              <td class="fd-table__cell">joule | sapphire</td>
            </tr>
          </tbody>
        </table>
        <div class="setup-examples">
          <p><strong>Examples:</strong></p>
          <code>?demo=true</code><br />
          <code>?eventId=38&bucketCount=6&theme=sapphire</code>
        </div>
      </div>
    </div>

    <!-- Main display -->
    <template v-else>
      <!-- Hero -->
      <section class="hero">
        <div class="hero-content">
          <p class="hero-label">{{ isDemo ? 'Demo Mode' : eventLabel }} &mdash; Live</p>
          <div class="hero-counter">{{ formatCount(displayedCount) }}</div>
          <p class="hero-subtitle">tutorials completed</p>
        </div>
      </section>

      <!-- Connection status -->
      <div
        v-if="connectionState === 'reconnecting'"
        class="fd-message-strip fd-message-strip--warning status-strip"
        role="alert"
      >
        <p class="fd-message-strip__text">Reconnecting to event stream&hellip;</p>
      </div>
      <div
        v-else-if="connectionState === 'error'"
        class="fd-message-strip fd-message-strip--error status-strip"
        role="alert"
      >
        <p class="fd-message-strip__text">{{ errorMessage || 'Connection error' }}</p>
      </div>
      <div
        v-else-if="connectionState === 'connecting'"
        class="fd-message-strip fd-message-strip--information status-strip"
        role="status"
      >
        <p class="fd-message-strip__text">Connecting to event stream&hellip;</p>
      </div>

      <!-- Bucket grid -->
      <section class="bucket-section">
        <div class="bucket-grid">
          <div
            v-for="bucket in visibleBuckets"
            :key="bucket.name"
            class="bucket-card"
            :class="{ 'bucket-pulse': bucket.justUpdated }"
          >
            <div class="bucket-header">
              <span class="bucket-name">{{ bucket.name }}</span>
              <span class="bucket-count">{{ formatCount(bucket.count) }}</span>
            </div>
            <div class="bucket-bar-track">
              <div
                class="bucket-bar-fill"
                :style="{ width: barWidth(bucket.count) }"
              />
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.event-display {
  font-family: var(--sapFontFamily, '72', '72full', Arial, Helvetica, sans-serif);
  color: var(--sapTextColor, #32363a);
  background: var(--sapBackgroundColor, #f5f6f7);
  min-height: 100vh;
}

/* ── Setup Prompt ─────────────────────────────── */
.setup-prompt {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 3rem 1.5rem;
}

.setup-card {
  background: var(--sapTile_Background, #fff);
  border-radius: 0.75rem;
  box-shadow: var(--sapContent_Shadow2, 0 0.25rem 1rem rgba(0, 0, 0, 0.15));
  padding: 2rem;
  max-width: 700px;
  width: 100%;
}

.setup-card h2 {
  margin: 1.5rem 0 0.5rem;
  font-size: 1.25rem;
  color: var(--sapTextColor);
}

.setup-card p {
  color: var(--sapNeutralTextColor);
  margin: 0.5rem 0;
}

.setup-examples {
  margin-top: 1.5rem;
  padding: 1rem;
  background: var(--sapNeutralBackground, #f5f6f7);
  border-radius: 0.5rem;
}

.setup-examples code {
  font-size: 0.8125rem;
  color: var(--sapBrandColor);
  word-break: break-all;
}

/* ── Hero Section ─────────────────────────────── */
.hero {
  background: linear-gradient(135deg, var(--sapShellColor, #354a5f) 0%, #2c3e50 100%);
  color: var(--sapShell_TextColor, #fff);
  text-align: center;
  padding: 3.5rem 1.5rem 3rem;
}

.hero-content {
  max-width: 800px;
  margin: 0 auto;
}

.hero-label {
  font-size: 1rem;
  opacity: 0.85;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  margin: 0 0 1rem;
}

.hero-counter {
  font-size: clamp(4rem, 12vw, 10rem);
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.hero-subtitle {
  font-size: 1.25rem;
  opacity: 0.8;
  margin: 0.75rem 0 0;
  font-weight: 300;
}

/* ── Status Strip ─────────────────────────────── */
.status-strip {
  margin: 1rem 1.5rem 0;
  border-radius: 0.5rem;
}

/* ── Bucket Section ───────────────────────────── */
.bucket-section {
  padding: 1.5rem;
  max-width: 1400px;
  margin: 0 auto;
}

.bucket-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.bucket-card {
  background: var(--sapTile_Background, #fff);
  border-radius: 0.75rem;
  box-shadow: var(--sapContent_Shadow0, 0 1px 4px rgba(0, 0, 0, 0.06));
  padding: 1.25rem 1.5rem;
  transition: box-shadow 0.3s ease, transform 0.3s ease;
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
}

.bucket-card:hover {
  box-shadow: var(--sapContent_Shadow2, 0 0.25rem 1rem rgba(0, 0, 0, 0.15));
}

.bucket-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.75rem;
}

.bucket-name {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  margin-right: 1rem;
}

.bucket-count {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--sapBrandColor, #0070f2);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.bucket-bar-track {
  height: 8px;
  background: var(--sapNeutralBackground, #f5f6f7);
  border-radius: 4px;
  overflow: hidden;
}

.bucket-bar-fill {
  height: 100%;
  background: var(--sapBrandColor, #0070f2);
  border-radius: 4px;
  transition: width 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  min-width: 4px;
}

/* ── Pulse Animation ──────────────────────────── */
.bucket-pulse {
  animation: cardPulse 1.2s ease-out;
}

@keyframes cardPulse {
  0% {
    box-shadow: 0 0 0 0 rgba(0, 112, 242, 0.4);
    transform: scale(1);
  }
  15% {
    box-shadow: 0 0 0 8px rgba(0, 112, 242, 0.15);
    transform: scale(1.02);
  }
  100% {
    box-shadow: var(--sapContent_Shadow0, 0 1px 4px rgba(0, 0, 0, 0.06));
    transform: scale(1);
  }
}

/* ── Joule Theme ──────────────────────────────── */
.event-display[data-theme="joule"] .hero {
  background: linear-gradient(135deg, #5D36FF 0%, #7B42F0 40%, #A100C2 100%);
}

.event-display[data-theme="joule"] .bucket-count {
  color: #7B42F0;
}

.event-display[data-theme="joule"] .bucket-bar-fill {
  background: linear-gradient(90deg, #5D36FF, #A100C2);
}

.event-display[data-theme="joule"] .bucket-pulse {
  animation-name: cardPulseJoule;
}

@keyframes cardPulseJoule {
  0% {
    box-shadow: 0 0 0 0 rgba(123, 66, 240, 0.4);
    transform: scale(1);
  }
  15% {
    box-shadow: 0 0 0 8px rgba(123, 66, 240, 0.15);
    transform: scale(1.02);
  }
  100% {
    box-shadow: var(--sapContent_Shadow0);
    transform: scale(1);
  }
}

/* Joule Dark */
.event-display[data-theme="joule"][data-dark] .hero {
  background: linear-gradient(135deg, #2A1066 0%, #4B1A8A 40%, #6B0080 100%);
}

.event-display[data-theme="joule"][data-dark] .bucket-count {
  color: #B78AFF;
}

.event-display[data-theme="joule"][data-dark] .bucket-bar-fill {
  background: linear-gradient(90deg, #7B42F0, #B78AFF);
}

/* ── Sapphire Theme ───────────────────────────── */
.event-display[data-theme="sapphire"] .hero {
  background: linear-gradient(135deg, #1B90FF 0%, #0070F2 45%, #002A86 100%);
}

.event-display[data-theme="sapphire"] .bucket-count {
  color: #0070F2;
}

.event-display[data-theme="sapphire"] .bucket-bar-fill {
  background: linear-gradient(90deg, #1B90FF, #0070F2);
}

.event-display[data-theme="sapphire"] .bucket-pulse {
  animation-name: cardPulseSapphire;
}

@keyframes cardPulseSapphire {
  0% {
    box-shadow: 0 0 0 0 rgba(0, 112, 242, 0.4);
    transform: scale(1);
  }
  15% {
    box-shadow: 0 0 0 8px rgba(0, 112, 242, 0.15);
    transform: scale(1.02);
  }
  100% {
    box-shadow: var(--sapContent_Shadow0);
    transform: scale(1);
  }
}

/* Sapphire Dark */
.event-display[data-theme="sapphire"][data-dark] .hero {
  background: linear-gradient(135deg, #002A86 0%, #00144A 60%, #0A0030 100%);
}

.event-display[data-theme="sapphire"][data-dark] .bucket-count {
  color: #6CB4FF;
}

.event-display[data-theme="sapphire"][data-dark] .bucket-bar-fill {
  background: linear-gradient(90deg, #4DB1FF, #1B90FF);
}

/* ── Responsive ───────────────────────────────── */
@media (max-width: 600px) {
  .hero {
    padding: 2rem 1rem;
  }

  .hero-counter {
    font-size: 4rem;
  }

  .bucket-grid {
    grid-template-columns: 1fr;
  }

  .bucket-section {
    padding: 1rem;
  }
}

@media (min-width: 1800px) {
  .bucket-grid {
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  }
}
</style>

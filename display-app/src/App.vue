<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useEventStream } from './event-stream'
import { numberToWords, LANGUAGES, type Language } from './number-words'
import { useConfetti } from './composables/useConfetti'
import QrcodeVue from 'qrcode.vue'
import FlipCounter from './components/FlipCounter.vue'
import ActivityTicker from './components/ActivityTicker.vue'
import DonutChart from './components/DonutChart.vue'
import GoalRing from './components/GoalRing.vue'
import TrendingView from './components/TrendingView.vue'

const {
  buckets, totalCount, connectionState, errorMessage,
  speed, recentEvents, bucketVelocity,
  connect, startDemo,
} = useEventStream()

// ── URL Parameters ───────────────────────────────
const eventId = ref<number | null>(null)
const isDemo = ref(false)
const rotationTime = ref(10000)
const chartCount = ref(5)
const rankCount = ref(5)
const startView = ref(0)
const theme = ref<'horizon' | 'joule' | 'sapphire'>('horizon')
const participateUrl = ref('')
const isDark = ref(false)
const goalTarget = ref(5000)

// ── Rotation State ───────────────────────────────
const activeViewIndex = ref(0)
const prevViewIndex = ref(-1)
const activeLangIndex = ref(0)
let rotationTimer: ReturnType<typeof setTimeout> | null = null

const activeLang = computed<Language>(() => LANGUAGES[activeLangIndex.value % LANGUAGES.length])
const VIEW_COUNT = 8

function rotateViews() {
  rotationTimer = setTimeout(() => {
    prevViewIndex.value = activeViewIndex.value
    activeViewIndex.value = (activeViewIndex.value + 1) % VIEW_COUNT
    activeLangIndex.value = (activeLangIndex.value + 1) % LANGUAGES.length
    setTimeout(() => { prevViewIndex.value = -1 }, 1200)
    rotateViews()
  }, rotationTime.value)
}

// ── Animated Counter ─────────────────────────────
const displayedCount = ref(0)
let animFrame: number | null = null

watch(totalCount, (to) => {
  const from = displayedCount.value
  const diff = to - from
  if (diff === 0) return
  const duration = Math.min(1500, Math.max(300, diff * 50))
  const t0 = performance.now()
  function tick(now: number) {
    const p = Math.min((now - t0) / duration, 1)
    displayedCount.value = Math.round(from + diff * (1 - Math.pow(1 - p, 3)))
    if (p < 1) animFrame = requestAnimationFrame(tick)
  }
  if (animFrame) cancelAnimationFrame(animFrame)
  animFrame = requestAnimationFrame(tick)
})

// ── Confetti ─────────────────────────────────────
const { particles: confettiParticles, active: confettiActive } = useConfetti(totalCount, isDemo)

// ── Computed Data ────────────────────────────────
const writtenOut = computed(() => numberToWords(displayedCount.value, activeLang.value))

const chartBuckets = computed(() => {
  const sorted = [...buckets.value].sort((a, b) => b.count - a.count)
  if (sorted.length <= chartCount.value) return sorted
  const top = sorted.slice(0, chartCount.value - 1)
  const rest = sorted.slice(chartCount.value - 1)
  const otherCount = rest.reduce((s, b) => s + b.count, 0)
  return [...top, { name: 'Others', count: otherCount, justUpdated: false }]
})

const chartMax = computed(() => {
  if (chartBuckets.value.length === 0) return 1
  return chartBuckets.value[0]?.count ?? 1
})

const leaderBuckets = computed(() => {
  return [...buckets.value].sort((a, b) => b.count - a.count).slice(0, rankCount.value)
})

const speedMax = ref(1000)
let speedMaxTs = 0
const SPEED_COOLDOWN = 10

watch(speed, (s) => {
  const now = Date.now() / 1000
  if (s > speedMax.value || speedMaxTs + SPEED_COOLDOWN < now) {
    speedMax.value = roundUp(s * 1.3, 100)
    speedMaxTs = now
  }
})

function roundUp(n: number, base: number): number {
  const r = Math.ceil(n)
  return r + (base - r % base)
}

function rankSuffix(i: number): string {
  const n = i + 1
  if (n === 1) return 'st'
  if (n === 2) return 'nd'
  if (n === 3) return 'rd'
  return 'th'
}

function rankClass(i: number): string {
  if (i === 0) return 'gold'
  if (i === 1) return 'silver'
  if (i === 2) return 'bronze'
  return 'other'
}

function fmt(n: number): string { return n.toLocaleString() }

function barPct(count: number): string {
  return chartMax.value === 0 ? '0%' : `${(count / chartMax.value) * 100}%`
}

function speedPct(): string {
  if (speedMax.value === 0) return '100%'
  const w = (speedMax.value - speed.value) / speedMax.value * 100
  return (w > 0 ? w : 0) + '%'
}

function viewClass(index: number): string {
  if (activeViewIndex.value === index) return 'view-enter'
  if (prevViewIndex.value === index) return 'view-leave'
  return ''
}

const showTicker = computed(() => {
  const v = activeViewIndex.value
  return v !== 0 && v !== 4
})

// ── Setup Prompt ─────────────────────────────────
const showSetup = computed(() =>
  !isDemo.value && !eventId.value
)

const qrUrl = computed(() => participateUrl.value || 'https://developers.sap.com/app-space.html')
const qrFg = computed(() => isDark.value ? '#eaecee' : '#32363a')
const qrBg = computed(() => isDark.value ? '#1c2228' : '#ffffff')

// ── Init ─────────────────────────────────────────
onMounted(() => {
  const p = new URLSearchParams(window.location.search)
  isDemo.value = p.get('demo') === 'true' || p.get('demoMode') === 'on'
  const eid = p.get('eventId')
  if (eid) eventId.value = parseInt(eid, 10)
  rotationTime.value = parseInt(p.get('rotationTime') ?? '') || 10000
  chartCount.value = parseInt(p.get('chartCount') ?? '') || 5
  rankCount.value = parseInt(p.get('rankCount') ?? '') || 5
  startView.value = parseInt(p.get('startView') ?? '') || 0
  participateUrl.value = p.get('participateUrl') ?? ''
  goalTarget.value = parseInt(p.get('goalTarget') ?? '') || 5000
  const t = p.get('theme')
  if (t === 'joule' || t === 'sapphire') theme.value = t

  isDark.value = p.get('dark') === 'true' || window.matchMedia('(prefers-color-scheme: dark)').matches

  activeViewIndex.value = startView.value % VIEW_COUNT

  if (isDemo.value) {
    startDemo()
  } else if (eventId.value) {
    connect('', eventId.value)
  }

  if (!showSetup.value) rotateViews()
})
</script>

<template>
  <div
    class="display-app"
    :data-theme="theme !== 'horizon' ? theme : undefined"
    :data-dark="isDark ? '' : undefined"
  >
    <!-- Setup prompt -->
    <div v-if="showSetup" class="setup">
      <div class="setup-card">
        <div class="setup-header">
          <div class="setup-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
              <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h1>Tutorial Display</h1>
        </div>
        <p class="setup-desc">Configure the kiosk display via URL parameters:</p>
        <table>
          <thead><tr><th>Parameter</th><th>Default</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>demo=true</code></td><td>&mdash;</td><td>Run with simulated data</td></tr>
            <tr><td><code>eventId</code></td><td>&mdash;</td><td>Event ID</td></tr>
            <tr><td><code>rotationTime</code></td><td>10000</td><td>View rotation interval (ms)</td></tr>
            <tr><td><code>chartCount</code></td><td>5</td><td>Max bars in chart view</td></tr>
            <tr><td><code>rankCount</code></td><td>5</td><td>Max items in leaderboard</td></tr>
            <tr><td><code>startView</code></td><td>0</td><td>Starting view (0&ndash;7)</td></tr>
            <tr><td><code>theme</code></td><td>horizon</td><td>joule | sapphire</td></tr>
            <tr><td><code>dark</code></td><td>auto</td><td>true | false (or prefers-color-scheme)</td></tr>
            <tr><td><code>goalTarget</code></td><td>5000</td><td>Target count for the goal ring view</td></tr>
            <tr><td><code>participateUrl</code></td><td>&mdash;</td><td>URL for participate view</td></tr>
          </tbody>
        </table>
        <div class="setup-examples">
          <strong>Quick start:</strong>
          <code>?demo=true</code>
          <code>?eventId=38&amp;chartCount=6&amp;theme=sapphire</code>
        </div>
      </div>
    </div>

    <!-- Main display -->
    <template v-else>
      <!-- Connection status -->
      <div v-if="connectionState === 'reconnecting'" class="status-bar status-bar--warning">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        Reconnecting&hellip;
      </div>
      <div v-else-if="connectionState === 'error'" class="status-bar status-bar--error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        {{ errorMessage || 'Connection error' }}
      </div>
      <div v-else-if="connectionState === 'connecting'" class="status-bar status-bar--info">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        Connecting&hellip;
      </div>

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

      <!-- View 0: Counter (Hero) -->
      <div class="view" :class="viewClass(0)">
        <div class="hero-view">
          <div class="hero-left">
            <FlipCounter :value="totalCount" size="hero" color="hero" />
            <div class="counter-subtitle">Finished Tutorials</div>
          </div>
          <div class="hero-right">
            <div class="written-out" :class="'lines-' + writtenOut.length">
              <div v-for="(line, i) in writtenOut" :key="i" class="written-line">{{ line }}</div>
            </div>
            <div class="lang-label">{{ activeLang }}</div>
          </div>
        </div>
      </div>

      <!-- View 1: Bar Chart -->
      <div class="view subview" :class="viewClass(1)">
        <h1 class="view-title">Finished by Topic</h1>
        <div class="view-body">
          <div class="left-content">
            <div class="chart">
              <div v-for="b in chartBuckets" :key="b.name" class="chart-row" :class="{ 'chart-row--pulse': b.justUpdated }">
                <div class="chart-label">{{ b.name }}</div>
                <div class="chart-bar-track">
                  <div class="chart-bar-fill" :style="{ width: barPct(b.count) }">
                    <span class="chart-bar-value">{{ fmt(b.count) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="right-sidebar">
            <FlipCounter :value="totalCount" size="sidebar" color="accent" />
            <div class="sidebar-label">tutorials</div>
            <div class="sidebar-written" :class="'lines-' + writtenOut.length">
              <div v-for="(line, i) in writtenOut" :key="i" class="written-line">{{ line }}</div>
            </div>
            <div class="sidebar-qr">
              <qrcode-vue :value="qrUrl" :size="100" level="M" render-as="svg" :foreground="qrFg" :background="qrBg" />
            </div>
          </div>
        </div>
      </div>

      <!-- View 2: Leaderboard -->
      <div class="view subview" :class="viewClass(2)">
        <h1 class="view-title">Most Popular Tracks</h1>
        <div class="view-body">
          <div class="left-content">
            <TransitionGroup name="lb-move" tag="div" class="leaderboard">
              <div v-for="(b, i) in leaderBuckets" :key="b.name" class="lb-row" :class="[rankClass(i), { 'lb-row--pulse': b.justUpdated }]">
                <span class="lb-rank">
                  <span class="lb-pos">{{ i + 1 }}</span>
                  <span class="lb-suffix">{{ rankSuffix(i) }}</span>
                </span>
                <span class="lb-name">{{ b.name }}</span>
                <span class="lb-count">{{ fmt(b.count) }}</span>
              </div>
            </TransitionGroup>
          </div>
          <div class="right-sidebar">
            <FlipCounter :value="totalCount" size="sidebar" color="accent" />
            <div class="sidebar-label">tutorials</div>
            <div class="sidebar-written" :class="'lines-' + writtenOut.length">
              <div v-for="(line, i) in writtenOut" :key="i" class="written-line">{{ line }}</div>
            </div>
            <div class="sidebar-qr">
              <qrcode-vue :value="qrUrl" :size="100" level="M" render-as="svg" :foreground="qrFg" :background="qrBg" />
            </div>
          </div>
        </div>
      </div>

      <!-- View 3: Speedometer -->
      <div class="view subview" :class="viewClass(3)">
        <h1 class="view-title">Tutorials Per Hour</h1>
        <div class="view-body">
          <div class="left-content">
            <div class="speedometer">
              <div class="speed-value">{{ speed }}</div>
              <div class="speed-unit">per hour</div>
              <div class="speed-band">
                <div class="speed-fill" :style="{ right: speedPct() }"></div>
                <div class="speed-labels">
                  <span>0</span>
                  <span>{{ Math.round(speedMax / 2) }}</span>
                  <span>{{ speedMax }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="right-sidebar">
            <FlipCounter :value="totalCount" size="sidebar" color="accent" />
            <div class="sidebar-label">total</div>
            <div class="sidebar-written" :class="'lines-' + writtenOut.length">
              <div v-for="(line, i) in writtenOut" :key="i" class="written-line">{{ line }}</div>
            </div>
            <div class="sidebar-qr">
              <qrcode-vue :value="qrUrl" :size="100" level="M" render-as="svg" :foreground="qrFg" :background="qrBg" />
            </div>
          </div>
        </div>
      </div>

      <!-- View 4: Participate -->
      <div class="view subview" :class="viewClass(4)">
        <h1 class="view-title">Join In</h1>
        <div class="view-body">
          <div class="left-content participate-content">
            <div class="participate-qr">
              <qrcode-vue :value="qrUrl" :size="280" level="M" render-as="svg" :foreground="qrFg" :background="qrBg" />
            </div>
            <p class="participate-text">
              Scan the code or visit the link below
            </p>
            <a class="participate-link" :href="qrUrl" target="_blank">
              {{ participateUrl || 'developers.sap.com/app-space.html' }}
            </a>
          </div>
          <div class="right-sidebar">
            <FlipCounter :value="totalCount" size="sidebar" color="accent" />
            <div class="sidebar-label">completed</div>
            <div class="sidebar-written" :class="'lines-' + writtenOut.length">
              <div v-for="(line, i) in writtenOut" :key="i" class="written-line">{{ line }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- View 5: Donut Chart -->
      <div class="view subview" :class="viewClass(5)">
        <h1 class="view-title">Topic Distribution</h1>
        <div class="view-body">
          <div class="left-content">
            <DonutChart
              :buckets="buckets"
              :chart-count="chartCount"
              :total-count="displayedCount"
              :is-active="activeViewIndex === 5"
            />
          </div>
          <div class="right-sidebar">
            <FlipCounter :value="totalCount" size="sidebar" color="accent" />
            <div class="sidebar-label">tutorials</div>
            <div class="sidebar-written" :class="'lines-' + writtenOut.length">
              <div v-for="(line, i) in writtenOut" :key="i" class="written-line">{{ line }}</div>
            </div>
            <div class="sidebar-qr">
              <qrcode-vue :value="qrUrl" :size="100" level="M" render-as="svg" :foreground="qrFg" :background="qrBg" />
            </div>
          </div>
        </div>
      </div>

      <!-- View 6: Goal Progress Ring -->
      <div class="view subview" :class="viewClass(6)">
        <h1 class="view-title">Event Goal</h1>
        <div class="view-body">
          <div class="left-content" style="align-items: center;">
            <GoalRing :current="displayedCount" :target="goalTarget" />
          </div>
          <div class="right-sidebar">
            <FlipCounter :value="totalCount" size="sidebar" color="accent" />
            <div class="sidebar-label">completed</div>
            <div class="sidebar-written" :class="'lines-' + writtenOut.length">
              <div v-for="(line, i) in writtenOut" :key="i" class="written-line">{{ line }}</div>
            </div>
            <div class="sidebar-qr">
              <qrcode-vue :value="qrUrl" :size="100" level="M" render-as="svg" :foreground="qrFg" :background="qrBg" />
            </div>
          </div>
        </div>
      </div>

      <!-- View 7: Trending / On Fire -->
      <div class="view subview" :class="viewClass(7)">
        <h1 class="view-title">Who's on Fire</h1>
        <div class="view-body">
          <div class="left-content">
            <TrendingView
              :buckets="buckets"
              :velocity="bucketVelocity"
              :rank-count="rankCount"
            />
          </div>
          <div class="right-sidebar">
            <FlipCounter :value="totalCount" size="sidebar" color="accent" />
            <div class="sidebar-label">total</div>
            <div class="sidebar-written" :class="'lines-' + writtenOut.length">
              <div v-for="(line, i) in writtenOut" :key="i" class="written-line">{{ line }}</div>
            </div>
            <div class="sidebar-qr">
              <qrcode-vue :value="qrUrl" :size="100" level="M" render-as="svg" :foreground="qrFg" :background="qrBg" />
            </div>
          </div>
        </div>
      </div>

      <!-- Activity Ticker -->
      <ActivityTicker :events="recentEvents" :visible="showTicker" />
    </template>
  </div>
</template>

<style>
/* ═════════════════════════════════════════════════════════════
   SAP Horizon Light Tokens
   ═════════════════════════════════════════════════════════════ */
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
  --sapLinkColor: #0064d9;
  --sapContent_LabelColor: #556b82;
  --sapContent_ContrastTextColor: #fff;
  --sapContent_Shadow0: 0 1px 4px rgba(0, 0, 0, 0.06);
  --sapContent_Shadow2: 0 0.25rem 1rem rgba(0, 0, 0, 0.15);
  --sapFontFamily: '72', '72full', Arial, Helvetica, sans-serif;
  --sapTile_Background: #fff;
  --sapPositiveColor: #107e3e;
  --sapNegativeColor: #b00;
  --sapCriticalColor: #e9730c;
  --sapInformationBorderColor: #0070f2;
  --sapButton_BorderCornerRadius: 0.5rem;

  /* Display semantic aliases */
  --d-hero-gradient: linear-gradient(135deg, #354a5f 0%, #2c3e50 40%, #1a252f 100%);
  --d-hero-text: #fff;
  --d-accent: var(--sapBrandColor);
  --d-surface: var(--sapBaseColor);
  --d-bg: var(--sapBackgroundColor);
  --d-text: var(--sapTextColor);
  --d-text-dim: var(--sapNeutralTextColor);
  --d-border: var(--sapNeutralBorderColor);
  --d-bar-fill: linear-gradient(90deg, #0070f2, #0064d9);
  --d-bar-track: var(--sapNeutralBackground);
  --d-speed-gradient: linear-gradient(90deg, #107e3e, #8ab83a 40%, #e9730c 70%, #b00);
  --d-gold: #c78b00;
  --d-silver: #6a6d70;
  --d-bronze: #a0522d;
  --d-gold-bg: rgba(199, 139, 0, 0.08);
  --d-silver-bg: rgba(106, 109, 112, 0.06);
  --d-bronze-bg: rgba(160, 82, 45, 0.06);
  --d-shadow: var(--sapContent_Shadow0);
  --d-shadow-elevated: var(--sapContent_Shadow2);
  --d-sidebar-bg: var(--sapTile_Background);
  --d-sidebar-border: var(--sapNeutralBorderColor);
  --d-status-warning-bg: #fff3cd;
  --d-status-warning-text: #7a4510;
  --d-status-warning-border: #e9730c;
  --d-status-error-bg: #ffeaef;
  --d-status-error-text: #880000;
  --d-status-error-border: #b00;
  --d-status-info-bg: #e1f4ff;
  --d-status-info-text: #004a99;
  --d-status-info-border: #0070f2;

  /* Confetti */
  --d-confetti-1: #0070f2;
  --d-confetti-2: #0064d9;
  --d-confetti-3: #107e3e;

  /* Ticker */
  --d-ticker-bg: rgba(245, 246, 247, 0.92);
  --d-ticker-dot: var(--sapPositiveColor);

  /* Flip counter */
  --d-flap-bg: rgba(0, 0, 0, 0.06);
  --d-flap-border: var(--sapNeutralBorderColor);

  /* Donut segments */
  --d-chart-1: #0070f2;
  --d-chart-2: #0064d9;
  --d-chart-3: #107e3e;
  --d-chart-4: #e9730c;
  --d-chart-5: #c78b00;
  --d-chart-6: #6a6d70;

  /* Goal ring */
  --d-ring-track: var(--sapNeutralBackground);
  --d-ring-fill: var(--sapBrandColor);
}

/* ═════════════════════════════════════════════════════════════
   SAP Horizon Dark Tokens
   ═════════════════════════════════════════════════════════════ */
[data-dark] {
  --sapBackgroundColor: #12171c;
  --sapBaseColor: #1c2228;
  --sapBrandColor: #4db1ff;
  --sapHighlightColor: #4db1ff;
  --sapShellColor: #1c2228;
  --sapShell_TextColor: #eaecee;
  --sapTextColor: #eaecee;
  --sapNeutralTextColor: #a9b4be;
  --sapNeutralBorderColor: #3c4854;
  --sapNeutralBackground: #1c2228;
  --sapLinkColor: #4db1ff;
  --sapContent_LabelColor: #8396a8;
  --sapContent_ContrastTextColor: #1c2228;
  --sapContent_Shadow0: 0 1px 4px rgba(0, 0, 0, 0.3);
  --sapContent_Shadow2: 0 0.25rem 1rem rgba(0, 0, 0, 0.4);
  --sapTile_Background: #1c2228;
  --sapPositiveColor: #57b520;
  --sapNegativeColor: #ff758c;
  --sapCriticalColor: #f0ab00;
  --sapInformationBorderColor: #4db1ff;

  --d-hero-gradient: linear-gradient(135deg, #1c2228 0%, #12171c 50%, #0d1117 100%);
  --d-hero-text: #eaecee;
  --d-accent: var(--sapBrandColor);
  --d-surface: var(--sapBaseColor);
  --d-bg: var(--sapBackgroundColor);
  --d-text: var(--sapTextColor);
  --d-text-dim: var(--sapNeutralTextColor);
  --d-border: var(--sapNeutralBorderColor);
  --d-bar-fill: linear-gradient(90deg, #4db1ff, #0070f2);
  --d-bar-track: #29394b;
  --d-speed-gradient: linear-gradient(90deg, #57b520, #8ab83a 40%, #f0ab00 70%, #ff758c);
  --d-gold: #e8a400;
  --d-silver: #a9b4be;
  --d-bronze: #b87333;
  --d-gold-bg: rgba(232, 164, 0, 0.12);
  --d-silver-bg: rgba(169, 180, 190, 0.08);
  --d-bronze-bg: rgba(184, 115, 51, 0.08);
  --d-shadow: var(--sapContent_Shadow0);
  --d-shadow-elevated: var(--sapContent_Shadow2);
  --d-sidebar-bg: #1c2228;
  --d-sidebar-border: #3c4854;
  --d-status-warning-bg: rgba(240, 171, 0, 0.12);
  --d-status-warning-text: #f0ab00;
  --d-status-warning-border: #f0ab00;
  --d-status-error-bg: rgba(255, 117, 140, 0.12);
  --d-status-error-text: #ff758c;
  --d-status-error-border: #ff758c;
  --d-status-info-bg: rgba(77, 177, 255, 0.12);
  --d-status-info-text: #4db1ff;
  --d-status-info-border: #4db1ff;

  --d-confetti-1: #4db1ff;
  --d-confetti-2: #57b520;
  --d-confetti-3: #f0ab00;

  --d-ticker-bg: rgba(28, 34, 40, 0.92);
  --d-ticker-dot: var(--sapPositiveColor);

  --d-flap-bg: rgba(255, 255, 255, 0.08);
  --d-flap-border: #3c4854;

  --d-chart-1: #4db1ff;
  --d-chart-2: #57b520;
  --d-chart-3: #f0ab00;
  --d-chart-4: #ff758c;
  --d-chart-5: #a9b4be;
  --d-chart-6: #8396a8;

  --d-ring-track: #29394b;
  --d-ring-fill: var(--sapBrandColor);
}

/* ═════════════════════════════════════════════════════════════
   Joule Theme — Light
   ═════════════════════════════════════════════════════════════ */
[data-theme="joule"] {
  --d-hero-gradient: linear-gradient(135deg, #5D36FF 0%, #7B42F0 40%, #A100C2 100%);
  --d-accent: #5D36FF;
  --d-bar-fill: linear-gradient(90deg, #5D36FF, #A100C2);
  --d-speed-gradient: linear-gradient(90deg, #107e3e, #5D36FF 40%, #A100C2 70%, #b00);
  --d-gold: #5D36FF;
  --d-silver: #7B42F0;
  --d-bronze: #A100C2;
  --d-gold-bg: rgba(93, 54, 255, 0.08);
  --d-silver-bg: rgba(123, 66, 240, 0.06);
  --d-bronze-bg: rgba(161, 0, 194, 0.06);
  --d-confetti-1: #5D36FF;
  --d-confetti-2: #7B42F0;
  --d-confetti-3: #A100C2;
  --d-chart-1: #5D36FF;
  --d-chart-2: #7B42F0;
  --d-chart-3: #A100C2;
  --d-chart-4: #107e3e;
  --d-chart-5: #e9730c;
  --d-chart-6: #6a6d70;
  --d-ring-fill: #5D36FF;
}

/* Joule — Dark */
[data-theme="joule"][data-dark] {
  --d-hero-gradient: linear-gradient(135deg, #2a1066 0%, #1a0040 50%, #0f0025 100%);
  --d-accent: #b78aff;
  --d-bar-fill: linear-gradient(90deg, #7B42F0, #A100C2);
  --d-speed-gradient: linear-gradient(90deg, #57b520, #7B42F0 40%, #A100C2 70%, #ff758c);
  --d-gold: #b78aff;
  --d-silver: #8060c0;
  --d-bronze: #a050d0;
  --d-gold-bg: rgba(183, 138, 255, 0.12);
  --d-silver-bg: rgba(128, 96, 192, 0.08);
  --d-bronze-bg: rgba(160, 80, 208, 0.08);
  --d-confetti-1: #b78aff;
  --d-confetti-2: #8060c0;
  --d-confetti-3: #a050d0;
  --d-chart-1: #b78aff;
  --d-chart-2: #8060c0;
  --d-chart-3: #a050d0;
  --d-chart-4: #57b520;
  --d-chart-5: #f0ab00;
  --d-chart-6: #a9b4be;
  --d-ring-fill: #b78aff;
}

/* ═════════════════════════════════════════════════════════════
   Sapphire Theme — Light
   ═════════════════════════════════════════════════════════════ */
[data-theme="sapphire"] {
  --d-hero-gradient: linear-gradient(135deg, #1B90FF 0%, #0070F2 40%, #002A86 100%);
  --d-accent: #1B90FF;
  --d-bar-fill: linear-gradient(90deg, #1B90FF, #0070F2);
  --d-speed-gradient: linear-gradient(90deg, #107e3e, #1B90FF 40%, #0070F2 70%, #b00);
  --d-gold: #1B90FF;
  --d-silver: #0070F2;
  --d-bronze: #002A86;
  --d-gold-bg: rgba(27, 144, 255, 0.08);
  --d-silver-bg: rgba(0, 112, 242, 0.06);
  --d-bronze-bg: rgba(0, 42, 134, 0.06);
  --d-confetti-1: #1B90FF;
  --d-confetti-2: #0070F2;
  --d-confetti-3: #002A86;
  --d-chart-1: #1B90FF;
  --d-chart-2: #0070F2;
  --d-chart-3: #002A86;
  --d-chart-4: #107e3e;
  --d-chart-5: #e9730c;
  --d-chart-6: #6a6d70;
  --d-ring-fill: #1B90FF;
}

/* Sapphire — Dark */
[data-theme="sapphire"][data-dark] {
  --d-hero-gradient: linear-gradient(135deg, #002A86 0%, #001550 50%, #000a30 100%);
  --d-accent: #4db1ff;
  --d-bar-fill: linear-gradient(90deg, #4db1ff, #1B90FF);
  --d-speed-gradient: linear-gradient(90deg, #57b520, #4db1ff 40%, #1B90FF 70%, #ff758c);
  --d-gold: #4db1ff;
  --d-silver: #3080c0;
  --d-bronze: #205090;
  --d-gold-bg: rgba(77, 177, 255, 0.12);
  --d-silver-bg: rgba(48, 128, 192, 0.08);
  --d-bronze-bg: rgba(32, 80, 144, 0.08);
  --d-confetti-1: #4db1ff;
  --d-confetti-2: #3080c0;
  --d-confetti-3: #205090;
  --d-chart-1: #4db1ff;
  --d-chart-2: #3080c0;
  --d-chart-3: #205090;
  --d-chart-4: #57b520;
  --d-chart-5: #f0ab00;
  --d-chart-6: #a9b4be;
  --d-ring-fill: #4db1ff;
}

/* ═════════════════════════════════════════════════════════════
   Base Reset & Layout
   ═════════════════════════════════════════════════════════════ */
* { margin: 0; padding: 0; box-sizing: border-box; }

.display-app {
  font-family: var(--sapFontFamily);
  background: var(--d-bg);
  color: var(--d-text);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  position: relative;
  transition: background-color 0.4s ease, color 0.4s ease;
}

/* ═════════════════════════════════════════════════════════════
   Status Bar (Fiori message-strip pattern)
   ═════════════════════════════════════════════════════════════ */
.status-bar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  padding: 0.625rem 1.25rem;
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  font-size: 0.875rem; font-weight: 600;
  border-bottom: 2px solid;
}
.status-bar svg { flex-shrink: 0; }

.status-bar--warning {
  background: var(--d-status-warning-bg);
  color: var(--d-status-warning-text);
  border-color: var(--d-status-warning-border);
}
.status-bar--error {
  background: var(--d-status-error-bg);
  color: var(--d-status-error-text);
  border-color: var(--d-status-error-border);
}
.status-bar--info {
  background: var(--d-status-info-bg);
  color: var(--d-status-info-text);
  border-color: var(--d-status-info-border);
}

/* ═════════════════════════════════════════════════════════════
   Confetti Overlay
   ═════════════════════════════════════════════════════════════ */
.confetti-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 200;
  overflow: hidden;
}

.confetti-particle {
  position: absolute;
  background: var(--c-color);
  width: var(--c-size);
  height: var(--c-size);
  animation: confetti-fall 3s cubic-bezier(0.25, 0.46, 0.45, 0.94) var(--c-delay) forwards;
  opacity: 0;
}
.confetti-particle.square { border-radius: 2px; }
.confetti-particle.circle { border-radius: 50%; }
.confetti-particle.strip { width: calc(var(--c-size) * 0.35); border-radius: 1px; }

@keyframes confetti-fall {
  0% {
    opacity: 1;
    transform: translateY(0) rotate(var(--c-rotation)) scale(0);
  }
  10% {
    opacity: 1;
    transform: translateY(-20px) rotate(var(--c-rotation)) scale(1);
  }
  90% {
    opacity: 0.6;
  }
  100% {
    opacity: 0;
    transform: translateY(100vh) rotate(calc(var(--c-rotation) + 720deg)) scale(0.5);
  }
}

/* ═════════════════════════════════════════════════════════════
   Views — Directional Transitions
   ═════════════════════════════════════════════════════════════ */
.view {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  opacity: 0; pointer-events: none;
  transform: translateX(6%) scale(0.97);
  transition: opacity 1s cubic-bezier(0.4, 0, 0.2, 1),
              transform 1s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform, opacity;
}

.view.view-enter {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0) scale(1);
}

.view.view-leave {
  opacity: 0;
  pointer-events: none;
  transform: translateX(-6%) scale(0.97);
}

/* ═════════════════════════════════════════════════════════════
   View 0 — Counter Hero with Ambient Gradient
   ═════════════════════════════════════════════════════════════ */
.hero-view {
  flex: 1;
  display: flex; align-items: center; justify-content: center; gap: 6vw;
  background: var(--d-hero-gradient);
  background-size: 300% 300%;
  animation: gradient-breathe 30s ease infinite;
  padding: 3rem;
}

@keyframes gradient-breathe {
  0% { background-position: 0% 50%; }
  33% { background-position: 100% 50%; }
  66% { background-position: 50% 0%; }
  100% { background-position: 0% 50%; }
}

.hero-left { text-align: center; }

.counter-subtitle {
  font-size: clamp(1.2rem, 2.5vw, 2rem);
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: rgba(255, 255, 255, 0.7);
  margin-top: 0.75rem;
}

.hero-right { max-width: 50vw; overflow: hidden; }

.written-out {
  text-transform: uppercase;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.95);
  line-height: 1.1;
}
.written-line { white-space: nowrap; }
.lines-1 .written-line { font-size: clamp(3rem, 8vw, 8rem); }
.lines-2 .written-line { font-size: clamp(2.5rem, 6vw, 6rem); }
.lines-3 .written-line { font-size: clamp(2rem, 4.5vw, 4.5rem); }
.lines-4 .written-line { font-size: clamp(1.5rem, 3.5vw, 3.5rem); }

.lang-label {
  margin-top: 1rem;
  font-size: clamp(0.75rem, 1.2vw, 1rem);
  text-transform: capitalize;
  color: rgba(255, 255, 255, 0.5);
  letter-spacing: 0.1em;
}

/* ═════════════════════════════════════════════════════════════
   Subview Layout (Views 1-7 except Hero/JoinIn)
   ═════════════════════════════════════════════════════════════ */
.subview { background: var(--d-bg); }

.subview .view-title {
  font-size: clamp(1.5rem, 3.5vw, 2.75rem);
  font-weight: 700;
  color: var(--d-accent);
  padding: 2.5rem 3rem 0;
  letter-spacing: 0.01em;
}

.view-body {
  flex: 1; display: flex; gap: 3rem;
  padding: 1.5rem 3rem 2rem;
}

.left-content {
  flex: 1;
  display: flex; flex-direction: column; justify-content: center;
}

.right-sidebar {
  width: 28%; min-width: 260px; max-width: 380px;
  display: flex; flex-direction: column; align-items: flex-end; justify-content: center;
  text-align: right;
  background: var(--d-sidebar-bg);
  border-left: 1px solid var(--d-sidebar-border);
  border-radius: var(--sapButton_BorderCornerRadius);
  padding: 2rem;
  box-shadow: var(--d-shadow);
}

.sidebar-label {
  font-size: clamp(0.875rem, 1.5vw, 1.125rem);
  color: var(--d-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-top: 0.25rem;
  font-weight: 600;
}

.sidebar-written {
  text-transform: uppercase;
  font-weight: 700;
  color: var(--d-accent);
  line-height: 1.15;
  margin-top: 1rem;
  opacity: 0.8;
}
.sidebar-written .written-line { white-space: nowrap; }
.sidebar-written.lines-1 .written-line { font-size: clamp(1.5rem, 3vw, 2.5rem); }
.sidebar-written.lines-2 .written-line { font-size: clamp(1.2rem, 2.5vw, 2rem); }
.sidebar-written.lines-3 .written-line { font-size: clamp(1rem, 2vw, 1.75rem); }
.sidebar-written.lines-4 .written-line { font-size: clamp(0.9rem, 1.5vw, 1.4rem); }

.sidebar-qr {
  margin-top: 1.25rem;
  padding: 0.5rem;
  background: var(--d-surface);
  border-radius: var(--sapButton_BorderCornerRadius);
  border: 1px solid var(--d-border);
  line-height: 0;
  opacity: 0.7;
  transition: opacity 0.3s ease;
}
.sidebar-qr:hover { opacity: 1; }

/* ═════════════════════════════════════════════════════════════
   Bar Chart (View 1)
   ═════════════════════════════════════════════════════════════ */
.chart { display: flex; flex-direction: column; gap: 1.125rem; }

.chart-row {
  display: flex; flex-direction: column; gap: 0.3rem;
  transition: transform 0.3s ease;
}
.chart-row--pulse { animation: pulse-row 0.6s ease; }

.chart-label {
  font-size: clamp(0.9rem, 1.5vw, 1.25rem);
  color: var(--d-text-dim);
  font-weight: 600;
}

.chart-bar-track {
  height: clamp(2rem, 3.5vw, 3.25rem);
  background: var(--d-bar-track);
  border-radius: var(--sapButton_BorderCornerRadius);
  overflow: hidden;
  border: 1px solid var(--d-border);
}

.chart-bar-fill {
  height: 100%;
  background: var(--d-bar-fill);
  border-radius: var(--sapButton_BorderCornerRadius);
  display: flex; align-items: center; justify-content: flex-end;
  padding-right: 0.875rem;
  transition: width 1s ease;
  min-width: 3.5rem;
  position: relative;
}

.chart-bar-value {
  font-size: clamp(0.8rem, 1.3vw, 1.125rem);
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

@keyframes pulse-row {
  0% { transform: scale(1); }
  50% { transform: scale(1.01); }
  100% { transform: scale(1); }
}

/* ═════════════════════════════════════════════════════════════
   Leaderboard (View 2) — with TransitionGroup
   ═════════════════════════════════════════════════════════════ */
.leaderboard { display: flex; flex-direction: column; gap: 1rem; }

.lb-move-move {
  transition: transform 0.8s cubic-bezier(0.22, 1, 0.36, 1);
}

.lb-row {
  display: flex; align-items: center; gap: 1.5rem;
  font-size: clamp(1.2rem, 2.5vw, 2rem);
  padding: 0.75rem 1.25rem;
  border-radius: var(--sapButton_BorderCornerRadius);
  transition: background-color 0.3s ease, transform 0.3s ease;
}
.lb-row--pulse { animation: pulse-row 0.6s ease; }

.lb-rank {
  display: inline-flex; align-items: baseline;
  min-width: 3.5rem;
}

.lb-pos {
  font-size: clamp(2rem, 4vw, 3.5rem);
  font-weight: 700;
}

.lb-suffix {
  font-size: clamp(0.8rem, 1.5vw, 1.25rem);
  font-weight: 700;
  vertical-align: super;
}

.lb-name {
  flex: 1;
  font-weight: 500;
  color: var(--d-text);
}

.lb-count {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--d-text-dim);
  font-size: clamp(1rem, 2vw, 1.5rem);
}

.lb-row.gold { background: var(--d-gold-bg); }
.lb-row.gold .lb-rank { color: var(--d-gold); }
.lb-row.gold .lb-pos { font-size: clamp(2.5rem, 5vw, 4.5rem); }

.lb-row.silver { background: var(--d-silver-bg); }
.lb-row.silver .lb-rank { color: var(--d-silver); }

.lb-row.bronze { background: var(--d-bronze-bg); }
.lb-row.bronze .lb-rank { color: var(--d-bronze); }

.lb-row.other .lb-rank { color: var(--d-text-dim); }

/* ═════════════════════════════════════════════════════════════
   Speedometer (View 3)
   ═════════════════════════════════════════════════════════════ */
.speedometer {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1rem;
}

.speed-value {
  font-size: clamp(5rem, 12vw, 10rem);
  font-weight: 700;
  color: var(--d-accent);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.speed-unit {
  font-size: clamp(1rem, 2vw, 1.5rem);
  color: var(--d-text-dim);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-top: -0.5rem;
}

.speed-band {
  width: 100%; max-width: 60vw;
  height: clamp(2.5rem, 4vw, 3.5rem);
  background: var(--d-speed-gradient);
  border-radius: var(--sapButton_BorderCornerRadius);
  position: relative; overflow: hidden;
  margin-top: 1rem;
  border: 1px solid var(--d-border);
}

.speed-fill {
  position: absolute; top: 0; right: 0; bottom: 0;
  background: var(--d-bg);
  transition: right 1s ease;
  border-left: 3px solid var(--d-accent);
  opacity: 0.85;
}

.speed-labels {
  position: absolute; bottom: -2rem; left: 0; right: 0;
  display: flex; justify-content: space-between;
  font-size: 0.875rem; color: var(--d-text-dim);
  font-weight: 600;
}

/* ═════════════════════════════════════════════════════════════
   Participate (View 4)
   ═════════════════════════════════════════════════════════════ */
.participate-content {
  align-items: center; gap: 1.5rem;
}

.participate-qr {
  padding: 1.25rem;
  background: var(--d-surface);
  border-radius: var(--sapButton_BorderCornerRadius);
  box-shadow: var(--d-shadow-elevated);
  border: 1px solid var(--d-border);
  line-height: 0;
}

.participate-text {
  font-size: clamp(1.25rem, 2.5vw, 2rem);
  color: var(--d-text-dim);
  font-weight: 300;
  max-width: 600px;
  line-height: 1.5;
  text-align: center;
}

.participate-link {
  display: inline-block;
  font-size: clamp(1.2rem, 2vw, 1.8rem);
  color: var(--d-accent);
  text-decoration: none;
  font-weight: 700;
  word-break: break-all;
  padding: 0.75rem 1.5rem;
  border: 2px solid var(--d-accent);
  border-radius: var(--sapButton_BorderCornerRadius);
  transition: background-color 0.2s ease, color 0.2s ease;
  margin-top: 1rem;
}
.participate-link:hover {
  background: var(--d-accent);
  color: var(--sapContent_ContrastTextColor);
}

/* ═════════════════════════════════════════════════════════════
   Setup Page (Fiori card/table pattern)
   ═════════════════════════════════════════════════════════════ */
.setup {
  display: flex; justify-content: center; align-items: flex-start;
  padding: 3rem 1.5rem; min-height: 100vh;
  background: var(--d-bg);
}

.setup-card {
  background: var(--d-surface);
  border-radius: var(--sapButton_BorderCornerRadius);
  padding: 2.5rem;
  max-width: 720px; width: 100%;
  border: 1px solid var(--d-border);
  box-shadow: var(--d-shadow-elevated);
}

.setup-header {
  display: flex; align-items: center; gap: 1rem;
  margin-bottom: 1.25rem;
}
.setup-icon {
  width: 48px; height: 48px;
  display: flex; align-items: center; justify-content: center;
  background: var(--d-accent);
  color: var(--sapContent_ContrastTextColor);
  border-radius: var(--sapButton_BorderCornerRadius);
}

.setup-card h1 {
  font-size: 1.375rem;
  font-weight: 700;
  color: var(--d-text);
}

.setup-desc {
  color: var(--d-text-dim);
  margin-bottom: 1.25rem;
  font-size: 0.9375rem;
}

.setup-card table {
  width: 100%; border-collapse: collapse; margin: 1rem 0;
}
.setup-card th, .setup-card td {
  padding: 0.625rem 0.875rem; text-align: left;
  border-bottom: 1px solid var(--d-border);
  font-size: 0.875rem;
}
.setup-card th {
  color: var(--d-accent); font-weight: 700;
  background: var(--d-bar-track);
}
.setup-card code {
  background: var(--d-bar-track);
  padding: 0.15em 0.5em;
  border-radius: 4px;
  font-size: 0.8125rem;
  color: var(--d-accent);
  font-family: 'Consolas', 'Monaco', monospace;
}

.setup-examples {
  margin-top: 1.5rem;
  padding: 1.25rem;
  background: var(--d-bar-track);
  border-radius: var(--sapButton_BorderCornerRadius);
  border: 1px solid var(--d-border);
}
.setup-examples strong {
  display: block;
  margin-bottom: 0.5rem;
  color: var(--d-text);
}
.setup-examples code {
  display: block;
  margin: 0.375rem 0;
  word-break: break-all;
}
</style>

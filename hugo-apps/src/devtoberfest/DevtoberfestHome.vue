<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { HomeState, MountConfig, StatusResponse } from './types'
import { buildTicker } from './ticker'
import { formatCountdown } from './countdown'
import { formatViewerLocal } from '../devtoberfest-schedule-shared/format-session-time'
import TermsDialog from './TermsDialog.vue'

// Legal T&C target — the fixed "THE RULES" rail route (see railItems below).
const RULES_URL = '/devtoberfest/rules/'
// Explanatory tooltip text (issue #1725). The banner artwork bakes a date, but
// the window below is the exact contest instant in the viewer's local zone, so
// the displayed day can differ from the picture — this explains why.
const WINDOW_TIP =
  'These are the technical start and end times of the contest, shown in your ' +
  'local time zone. Activity completion only earns points during this window.'

const props = defineProps<{ config: MountConfig }>()

const state = ref<HomeState>('loading')
const status = ref<StatusResponse | null>(null)
const errorMsg = ref<string>('')
const ctaHint = ref<string>('')
const dialogOpen = ref<boolean>(false)

async function fetchStatus(): Promise<void> {
  state.value = 'loading'
  ctaHint.value = ''
  errorMsg.value = ''
  try {
    const res = await fetch(props.config.apiStatus, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (res.status === 503) {
      state.value = 'event-missing'
      return
    }
    if (!res.ok) {
      console.warn('[devtoberfest] /status', res.status)
      errorMsg.value = `Couldn't reach the Devtoberfest service (HTTP ${res.status}).`
      state.value = 'error'
      return
    }
    const data = (await res.json()) as StatusResponse
    status.value = data
    if (data.joined) {
      state.value = 'registered'
      return
    }
    // Probe /me to distinguish anonymous vs unregistered.
    // /me requires auth — a 401 or 403 means anonymous.
    if (data.termsRequired) {
      // TODO(follow-up): /status should return `authenticated` so we
      //   don't need the /me probe. Tracked as a Phase-2 hardening.
      try {
        const meRes = await fetch(props.config.apiMe, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })
        // 401 and 403 both mean "no usable session" → anonymous
        if (meRes.status === 401 || meRes.status === 403) {
          state.value = 'anonymous'
        } else if (meRes.ok) {
          state.value = 'unregistered'
        } else {
          console.warn('[devtoberfest] /me probe non-ok', meRes.status)
          errorMsg.value = `Couldn't determine your registration state (HTTP ${meRes.status}).`
          state.value = 'error'
        }
      } catch (meErr) {
        console.warn('[devtoberfest] /me probe failed', meErr)
        errorMsg.value = "Couldn't determine your registration state."
        state.value = 'error'
      }
    } else {
      // termsRequired=false but joined=false → defensive fallback,
      // shouldn't normally happen since /status ties termsRequired to !joined
      state.value = 'unregistered'
    }
  } catch (err) {
    console.warn('[devtoberfest] fetchStatus failed', err)
    errorMsg.value = "Couldn't reach the Devtoberfest service."
    state.value = 'error'
  }
}

const eventName = computed<string>(() => status.value?.event?.name || 'Devtoberfest')
const hasBanner = computed<boolean>(() => !!status.value?.bannerUrl)
const bannerUrl = computed<string>(() => status.value?.bannerUrl || '')

function fmtDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const eventWindow = computed<string>(() => {
  const ev = status.value?.event
  if (!ev) return ''
  const s = fmtDate(ev.startDate)
  const e = fmtDate(ev.endDate)
  if (!s || !e) return ''
  return `${s} – ${e}`
})

// Full viewer-local start/end (date + time + tz abbreviation). Reuses the
// well-tested shared formatter so the banner window carries the exact contest
// instant in the visitor's own zone — the fix for issue #1725's date mismatch.
const startLocal = computed<string>(() =>
  formatViewerLocal(status.value?.event?.startDate || ''),
)
const endLocal = computed<string>(() =>
  formatViewerLocal(status.value?.event?.endDate || ''),
)

// Live countdown. `nowMs` ticks once a second (see startCountdown); the pure
// phase/label logic lives in ./countdown.ts so it is unit-testable off-clock.
const nowMs = ref<number>(Date.now())
const countdown = computed(() =>
  formatCountdown(
    nowMs.value,
    status.value?.event?.startDate || '',
    status.value?.event?.endDate || '',
  ),
)
const countdownText = computed<string>(() => {
  switch (countdown.value.phase) {
    case 'before':
    case 'during':
      return countdown.value.label
    case 'ended':
      return `${eventName.value} has ended`
    default:
      return ''
  }
})

const ctaLabel = computed<string>(() => {
  switch (state.value) {
    case 'registered':
      return "You're in! \u{1F389}"
    case 'unregistered':
      return 'Join the Fest'
    case 'anonymous':
      return 'Join the Fest'
    case 'event-missing':
      return 'Coming soon'
    case 'error':
      return '—'
    case 'loading':
    default:
      return 'Loading…'
  }
})

const ctaDisabled = computed<boolean>(
  () =>
    state.value === 'registered' ||
    state.value === 'loading' ||
    state.value === 'event-missing' ||
    state.value === 'error'
)

interface RailItem {
  label: string
  href: string
}

// Fixed internal navigation — independent of admin-entered config URLs.
// Order is intentional (spec 2026-08-02). All targets are stable Hugo routes.
const railItems: RailItem[] = [
  { label: 'THE WEEKS',   href: '/devtoberfest/calendar/' },
  { label: 'ACTIVITIES',  href: '/devtoberfest/schedule/' },
  { label: 'SESSIONS',    href: '/devtoberfest/sessions/' },
  { label: 'ARCADE',      href: '/devtoberfest/arcade/' },
  { label: 'LEADERBOARD', href: '/devtoberfest/gameboard/' },
  { label: 'THE RULES',   href: '/devtoberfest/rules/' },
  { label: 'FAQ',         href: '/devtoberfest/faq/' },
]

// Show the full welcome intro on the visitor-facing states (the empty-column
// problem is worst for people who haven't joined yet). Registered players get
// the shorter "head to the Gameboard" nudge instead.
const showIntro = computed<boolean>(
  () =>
    state.value === 'anonymous' ||
    state.value === 'unregistered' ||
    state.value === 'registered',
)

// Rotating "insert coin"-style ticker under the intro — echoes the arcade
// strip's blinking INSERT_COIN. Tips are static; the event window (when known)
// is spliced in so the line also carries one real fact. No fabricated stats.
// Builder lives in ./ticker.ts so it's unit-testable without mounting the SFC.
const ticker = computed<string[]>(() => buildTicker(eventWindow.value))

const tipIndex = ref<number>(0)
const currentTip = computed<string>(
  () => ticker.value[tipIndex.value % ticker.value.length] || '',
)

let tipTimer: ReturnType<typeof setInterval> | undefined
const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

function startTicker(): void {
  // Respect reduced-motion: show the first tip, don't cycle.
  if (prefersReducedMotion || tipTimer) return
  tipTimer = setInterval(() => {
    tipIndex.value = (tipIndex.value + 1) % ticker.value.length
  }, 4500)
}

let countdownTimer: ReturnType<typeof setInterval> | undefined
function startCountdown(): void {
  // The countdown is functional info, not decoration, so it ticks regardless
  // of reduced-motion. It updates a text node only — no vestibular motion.
  if (countdownTimer) return
  countdownTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
}

function onCtaClick(): void {
  if (state.value === 'anonymous') {
    // Tom's spec: auth flows via shellbar user menu; CTA is a no-op with hint.
    ctaHint.value = 'Log in via the user menu (top-right) to join.'
    return
  }
  if (state.value === 'unregistered') {
    dialogOpen.value = true
    return
  }
  // registered/loading/event-missing — disabled
}

function onJoined(): void {
  dialogOpen.value = false
  state.value = 'registered'
  // Optimistic update; status object also gets a partial refresh.
  if (status.value) {
    status.value = { ...status.value, joined: true, termsRequired: false }
  }
}

onMounted(async () => {
  await fetchStatus()
  startTicker()
  startCountdown()
})

onUnmounted(() => {
  if (tipTimer) clearInterval(tipTimer)
  if (countdownTimer) clearInterval(countdownTimer)
})

defineExpose({ fetchStatus })
</script>

<template>
  <article class="dtf-home" :data-state="state">
    <header class="dtf-header" :data-has-banner="hasBanner ? 'true' : 'false'">
      <img
        v-if="hasBanner"
        :src="bannerUrl"
        :alt="eventName"
        class="dtf-banner-img"
      />
      <div v-if="!hasBanner" class="dtf-brand">
        <img
          v-if="config.imgDevtoberfest"
          :src="config.imgDevtoberfest"
          alt=""
          class="dtf-brand-logo"
          aria-hidden="true"
        />
        <div class="dtf-brand-text">
          <h1 class="dtf-brand-title">{{ eventName }}</h1>
          <p v-if="eventWindow" class="dtf-brand-window">{{ eventWindow }}</p>
        </div>
        <img
          v-if="config.imgTeched"
          :src="config.imgTeched"
          alt=""
          class="dtf-brand-teched"
          aria-hidden="true"
        />
      </div>
      <div class="dtf-cta-wrap" :class="{ 'dtf-cta-overlay': hasBanner }">
        <button
          type="button"
          class="dtf-cta"
          :disabled="ctaDisabled"
          @click="onCtaClick"
        >
          {{ ctaLabel }}
        </button>
        <p v-if="ctaHint" class="dtf-cta-hint" role="status">{{ ctaHint }}</p>
      </div>
    </header>

    <div class="dtf-arcade-strip" aria-hidden="true">
      <span class="dtf-arcade-chunk">READY_PLAYER_1</span>
      <span v-if="eventWindow" class="dtf-arcade-chunk">{{ eventWindow }}</span>
      <span class="dtf-arcade-chunk">INSERT_COIN</span>
    </div>

    <!-- Authoritative, accessible contest window: exact start/end in the
         viewer's local zone (date + time + tz), a live countdown, and an
         info tooltip explaining the mismatch with the banner artwork (#1725). -->
    <div v-if="startLocal && endLocal" class="dtf-window">
      <p class="dtf-window-dates">
        <span class="dtf-window-label">Contest window:</span>
        <time :datetime="status?.event?.startDate">{{ startLocal }}</time>
        <span class="dtf-window-sep" aria-hidden="true">&ndash;</span>
        <time :datetime="status?.event?.endDate">{{ endLocal }}</time>
        <span class="dtf-window-help">
          <button
            type="button"
            class="dtf-window-info"
            aria-label="About the contest times"
            aria-describedby="dtf-window-tip"
          >i</button>
          <span id="dtf-window-tip" role="tooltip" class="dtf-window-tip">
            {{ WINDOW_TIP }}
            <a class="dtf-window-tip-link" :href="RULES_URL">See Legal Terms &amp; Conditions</a>
          </span>
        </span>
      </p>
      <p
        v-if="countdownText"
        class="dtf-window-countdown"
        :data-phase="countdown.phase"
      >{{ countdownText }}</p>
    </div>

    <section class="dtf-body">
      <div class="dtf-content">
        <h2 class="dtf-welcome">Welcome to Devtoberfest</h2>
        <p v-if="state === 'loading'" class="dtf-msg">Loading event information&hellip;</p>
        <p v-else-if="state === 'event-missing'" class="dtf-msg">
          No active Devtoberfest event right now. Check back soon!
        </p>
        <p v-else-if="state === 'anonymous'" class="dtf-msg">
          Log in via the user menu in the top-right corner to join the fest.
        </p>
        <p v-else-if="state === 'unregistered'" class="dtf-msg">
          Click <strong>Join the Fest</strong> to accept the terms and start playing.
        </p>
        <div v-if="state === 'unregistered'" class="dtf-cta-body-wrap">
          <button
            type="button"
            class="dtf-cta dtf-cta-body"
            :disabled="ctaDisabled"
            @click="onCtaClick"
          >
            {{ ctaLabel }}
          </button>
        </div>
        <p v-else-if="state === 'registered'" class="dtf-msg">
          You're registered — head to the Gameboard to start scoring!
        </p>

        <!-- Static welcome intro (Option A) + rotating arcade ticker (Option D).
             Shown on the visitor + registered states to fill the column. -->
        <div v-if="showIntro" class="dtf-intro">
          <p class="dtf-msg">
            One month. Every corner of the SAP developer world. Devtoberfest is
            our annual community celebration — a season of hands-on sessions,
            tutorials, and challenges where building something is the whole point.
          </p>
          <p class="dtf-msg">
            Rack up points as you go, watch your name climb the
            <strong>leaderboard</strong>, and blow off steam in the
            <strong>arcade</strong> between rounds. Whether you're shipping your
            first AI Agent or your hundredth, there's a spot on the board with
            your name on it.
          </p>
          <p class="dtf-ticker" role="status" aria-live="polite">
            <span class="dtf-ticker-prompt" aria-hidden="true">&gt;</span>
            <span :key="currentTip" class="dtf-ticker-text">{{ currentTip }}</span>
          </p>
        </div>

        <p v-if="state === 'error'" class="dtf-error">
          {{ errorMsg || "Something went wrong loading Devtoberfest." }}
          <button class="dtf-error-retry" @click="fetchStatus">Retry</button>
        </p>
        <img
          v-if="config.imgKasimir"
          :src="config.imgKasimir"
          alt=""
          class="dtf-kasimir"
          aria-hidden="true"
        />
      </div>
      <aside class="dtf-rail" aria-label="Devtoberfest links">
        <a
          v-for="(item, i) in railItems"
          :key="item.label"
          :href="item.href"
          class="dtf-rail-item"
          :style="{ '--rail-i': i }"
        >
          <span class="dtf-rail-label">{{ item.label }}</span>
        </a>
      </aside>
    </section>

    <TermsDialog
      :open="dialogOpen"
      :api-terms="config.apiTerms"
      :api-join="config.apiJoin"
      :img-kasimir="config.imgKasimir"
      @close="dialogOpen = false"
      @joined="onJoined"
    />
  </article>
</template>

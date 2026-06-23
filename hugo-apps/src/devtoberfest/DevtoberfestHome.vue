<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { HomeState, MountConfig, StatusResponse } from './types'
import TermsDialog from './TermsDialog.vue'

const props = defineProps<{ config: MountConfig }>()

const state = ref<HomeState>('loading')
const status = ref<StatusResponse | null>(null)
const errorMsg = ref<string>('')
const ctaHint = ref<string>('')
const dialogOpen = ref<boolean>(false)

async function fetchStatus(): Promise<void> {
  state.value = 'loading'
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

const railItems = computed<RailItem[]>(() => {
  const s = status.value
  if (!s) return []
  return [
    { label: 'THE RULES', href: s.contentRulesUrl || '#' },
    { label: 'THE WEEKS', href: s.activitiesUrl   || '#' },
    { label: 'FAQ',       href: s.faqUrl          || '#' },
    { label: 'GAMEBOARD', href: s.gameboardUrl    || '#' },
  ]
})

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

onMounted(fetchStatus)

defineExpose({ fetchStatus })
</script>

<template>
  <article class="dtf-home" :data-state="state">
    <header class="dtf-header">
      <div class="dtf-brand">
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
      <div class="dtf-cta-wrap">
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
        <p v-else-if="state === 'registered'" class="dtf-msg">
          You're registered — head to the Gameboard to start scoring!
        </p>
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

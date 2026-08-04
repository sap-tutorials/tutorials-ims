<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { MountConfig, MyGameboard } from './types'
import Scene from './Scene.vue'
const props = defineProps<{ config: MountConfig }>()

// Whether the caller is signed in. getMyGameboard is auth-gated: a 401 means
// anonymous ('log in'); a 2xx means authenticated (then the CTA keys off
// personalized.status — join vs no-event vs progress).
const authState = ref<'unknown' | 'anonymous' | 'authenticated'>('unknown')
const board = ref<MyGameboard>({ userId: '', score: 0, level: 0, avatarIndex: props.config.demoAvatar, breakdown: [] })

const joined = computed(() => board.value.status === 'joined')

// The CTA message + behavior, keyed on (auth | status | empty-activities) —
// the SAME contract the leaderboard cabinet uses:
//   anonymous            → "Log in"
//   authenticated + not_joined → "Join Devtoberfest" (→ joinUrl)
//   no active event      → "isn't running right now"
//   active event + 0 activities → "coming soon" empty-state
//   joined               → none (render the player scene)
type Cta = { kind: 'login' | 'join' | 'no_event' | 'coming_soon' | 'none'; text: string }
const cta = computed<Cta>(() => {
  if (authState.value === 'anonymous') {
    return { kind: 'login', text: 'Log in (user menu, top-right) to play Devtoberfest and track your progress.' }
  }
  if (joined.value) return { kind: 'none', text: '' }
  const status = board.value.status
  if (status === 'no_event' || board.value.hasActiveEvent === false) {
    return { kind: 'no_event', text: "Devtoberfest isn't running right now — check back soon!" }
  }
  if (board.value.hasActiveEvent && (board.value.activityCount ?? 0) === 0) {
    return { kind: 'coming_soon', text: 'Activities are coming soon — check back when Devtoberfest kicks off!' }
  }
  // authenticated + not_joined
  return { kind: 'join', text: 'Join Devtoberfest to start earning points and climbing the levels!' }
})

// Scene runs in "demo" mode whenever the player isn't a joined participant.
const demo = computed(() => !joined.value)

defineExpose({ authState, board, cta, demo })

onMounted(async () => {
  try {
    const res = await fetch(props.config.apiMyGameboard, { credentials: 'include', headers: { accept: 'application/json' } })
    if (!res.ok) { authState.value = 'anonymous'; return }   // 401 anonymous → log in
    const data = await res.json()
    board.value = data
    authState.value = 'authenticated'
  } catch { authState.value = 'anonymous' }                  // fail-soft → log in
})
</script>
<template>
  <div class="arcade-root">
    <Scene :board="board" :config="config" :demo="demo" />
    <div v-if="cta.kind !== 'none'" class="arcade-cta">
      <a v-if="cta.kind === 'join'" :href="config.joinUrl" class="arcade-cta-btn">Join the Fest</a>
      <p v-else class="arcade-cta-msg" :class="`arcade-cta-${cta.kind}`">{{ cta.text }}</p>
    </div>
  </div>
</template>

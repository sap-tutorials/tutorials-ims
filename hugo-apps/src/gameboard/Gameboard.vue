<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { MountConfig, LeaderboardRow, GameboardConfig, MyGameboard } from './types'
import { useGameboardStream } from './useGameboardStream'
import Leaderboard from './Leaderboard.vue'

const props = defineProps<{ config: MountConfig }>()

const rows = ref<LeaderboardRow[]>([])
const board = ref<GameboardConfig | null>(null)
const state = ref<'loading' | 'ready' | 'error'>('loading')
const { connect, disconnect } = useGameboardStream()

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function loadLeaderboard(): Promise<void> {
  const data = await fetchJson<{ value: LeaderboardRow[] }>(
    `${props.config.apiLeaderboard}(top=${props.config.top})`,
  )
  rows.value = data.value ?? []
}

async function loadBoard(): Promise<void> {
  // Public board config — always fetched (scnId unused by the anon UI; pass empty).
  board.value = await fetchJson<GameboardConfig>(`${props.config.apiGameboard}(scnId='')`)
}

async function loadMine(): Promise<void> {
  // Personalized arm is a SEPARATE authenticated endpoint. Anonymous callers get
  // 401/403 — swallow it (public board stands, cabinet shows a sign-in invite).
  try {
    const mine = await fetchJson<MyGameboard>(`${props.config.apiMyGameboard}()`)
    if (board.value) board.value = { ...board.value, personalized: mine }
  } catch (e) {
    // 401/403 (anonymous) or a soft failure — leave personalized null.
    console.debug('[gameboard] getMyGameboard unavailable (likely anonymous)', e)
  }
}

async function loadAll(): Promise<void> {
  state.value = 'loading'
  try {
    await Promise.all([loadLeaderboard(), loadBoard()])
    await loadMine()            // after board so we can merge onto it
    state.value = 'ready'
  } catch (e) {
    console.warn('[gameboard] load failed', e)
    state.value = 'error'       // fail-soft: keep whatever loaded, show retry
  }
}

onMounted(async () => {
  await loadAll()
  // Same-origin socket receives the active event's global completions; the
  // 'active' context is a stable channel key (backend broadcasts on it).
  connect(props.config.ws, 'active', () => { loadLeaderboard().catch(() => {}) })
})
onUnmounted(disconnect)
</script>

<template>
  <div class="gb-root">
    <h1 class="gb-title">Devtoberfest Gameboard</h1>

    <!-- Cabinet region (arcade personality) — filled in Task 5 -->
    <section class="cabinet" aria-label="Arcade cabinet">
      <!-- CabinetFrame + level/avatar art mounts here in Task 5 -->
    </section>

    <!-- Real accessible leaderboard -->
    <section class="gb-leaderboard-region" aria-label="Leaderboard">
      <Leaderboard :rows="rows" />
      <p v-if="state === 'error'" class="gb-error" role="status">
        Couldn't reach the gameboard.
        <button type="button" data-testid="gameboard-retry" @click="loadAll">Retry</button>
      </p>
    </section>
  </div>
</template>

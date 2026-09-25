<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { MountConfig, LeaderboardRow, LeaderboardPage, GameboardConfig, MyGameboard } from './types'
import { useGameboardStream } from './useGameboardStream'
import Leaderboard from './Leaderboard.vue'
import CabinetFrame from './CabinetFrame.vue'

const props = defineProps<{ config: MountConfig }>()

const rows = ref<LeaderboardRow[]>([])
const total = ref(0)                 // full field size (issue #2510) — powers counter + paging
const offset = ref(0)                // 0-based start of the visible page
const board = ref<GameboardConfig | null>(null)
const state = ref<'loading' | 'ready' | 'error'>('loading')
// Whether the caller is signed in. getMyGameboard is auth-gated: a 401 means
// anonymous ('log in'); a 2xx (any status) means authenticated (then the
// message keys off personalized.status — join vs progress).
const authState = ref<'unknown' | 'anonymous' | 'authenticated'>('unknown')
const { connect, disconnect } = useGameboardStream()

const pageSize = computed(() => props.config.top || 25)
const page = computed(() => Math.floor(offset.value / pageSize.value) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
// The caller's personalized standing (rank/total live here after loadMine).
const myGameboard = computed<MyGameboard | null>(() => board.value?.personalized ?? null)

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function loadLeaderboard(atOffset = offset.value): Promise<void> {
  // getLeaderboard returns the LeaderboardPage object as the body DIRECTLY
  // (a structured-return CAP function is not wrapped under `value`). Tolerate a
  // legacy `{ value: [...] }` array shape too, so a stale backend degrades
  // gracefully rather than blanking the board.
  const data = await fetchJson<LeaderboardPage & { value?: LeaderboardRow[] }>(
    `${props.config.apiLeaderboard}(top=${pageSize.value},offset=${atOffset})`,
  )
  if (Array.isArray(data.rows)) {
    rows.value = data.rows
    total.value = typeof data.total === 'number' ? data.total : data.rows.length
  } else if (Array.isArray(data.value)) {
    rows.value = data.value            // legacy bare-array backend
    total.value = data.value.length
  } else {
    rows.value = []
    total.value = 0
  }
  offset.value = atOffset
}

function goToPage(target: number): void {
  const clamped = Math.min(Math.max(1, target), pageCount.value)
  loadLeaderboard((clamped - 1) * pageSize.value).catch((e) => {
    console.warn('[gameboard] page load failed', e)
  })
}

async function loadBoard(): Promise<void> {
  // Public board config — always fetched (scnId unused by the anon UI; pass empty).
  board.value = await fetchJson<GameboardConfig>(`${props.config.apiGameboard}(scnId='')`)
}

async function loadMine(): Promise<void> {
  // Personalized arm is a SEPARATE authenticated endpoint. A 401/403 → anonymous
  // (cabinet shows "log in"); a 2xx → authenticated (cabinet keys off the
  // returned status: 'joined' → progress, 'not_joined' → "Join Devtoberfest").
  try {
    const mine = await fetchJson<MyGameboard>(`${props.config.apiMyGameboard}()`)
    authState.value = 'authenticated'
    if (board.value) board.value = { ...board.value, personalized: mine }
  } catch (e) {
    // 401/403 (anonymous) or a soft failure — treat as anonymous, personalized null.
    authState.value = 'anonymous'
    console.debug('[gameboard] getMyGameboard unavailable (likely anonymous)', e)
  }
}

async function loadAll(): Promise<void> {
  state.value = 'loading'
  try {
    await Promise.all([loadLeaderboard(offset.value), loadBoard()])
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
  // 'active' context is a stable channel key (backend broadcasts on it). On a
  // completion we refresh the CURRENT page (same offset) — NOT reset to page 1 —
  // so a browsing user isn't yanked back to the top every 30s.
  connect(props.config.ws, 'active', () => { loadLeaderboard(offset.value).catch(() => {}) })
})
onUnmounted(disconnect)
</script>

<template>
  <div class="gb-root">
    <h1 class="gb-title">Devtoberfest Gameboard</h1>

    <!-- Cabinet region (arcade personality, confined) -->
    <CabinetFrame v-if="board" :board="board" :img-base="config.imgBase" :auth-state="authState" join-url="/devtoberfest/#join" />

    <!-- Real accessible leaderboard -->
    <section class="gb-leaderboard-region" aria-label="Leaderboard">
      <Leaderboard
        :rows="rows"
        :total="total"
        :page="page"
        :page-count="pageCount"
        :mine="myGameboard"
        @prev="goToPage(page - 1)"
        @next="goToPage(page + 1)"
      />
      <p v-if="state === 'error'" class="gb-error" role="status">
        Couldn't reach the gameboard.
        <button type="button" data-testid="gameboard-retry" @click="loadAll">Retry</button>
      </p>
    </section>
  </div>
</template>

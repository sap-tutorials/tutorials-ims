# Devtoberfest Gameboard — Plan C: Gameboard UI (modernized arcade)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Invoke the **`dataviz`** skill BEFORE writing any leaderboard/progress visual code (Task 4/5).

**Goal:** Ship the public Devtoberfest gameboard as a **Hugo page + Vue island** in the tutorial-ims repo (`hugo-apps`), rendering a modernized-arcade board that reads live data from the new gameboard backend via the approuter (`/gameboard/getLeaderboard`, `/gameboard/getGameboard`) and refreshes in realtime off the **existing** `/ws/event-stream` socket. The arcade personality (CRT frame, pixel headings, scanline/glow, avatar/level art) is confined to a CSS "cabinet" region; the leaderboard and per-week/track progress are **real accessible semantic components** (tables/cards), never baked images.

**Repo:** `tutorials-ims` (= this working tree `D:\projects\tutorials-poc`). Plan C touches ONLY the tutorial repo (Hugo + `hugo-apps`) and consumes the new backend's HTTP endpoints. No gameboard-MTA code here.

**Tech Stack:** Hugo (static page + layout), Vue 3 + TypeScript islands built by Vite (`hugo-apps/`, output `hugo/static/js/gameboard.js`), SAP Horizon CSS tokens + Fundamental Styles for layout/typography, `socket.io-client` (already a dep, `^4.8.0`) for realtime, Vitest (`unit` project, happy-dom + `@vue/test-utils`) for island unit tests, Vitest + `playwright-core` (`e2e` project) for the committed e2e spec.

## Global Constraints

- **This is a Hugo island, NOT the gameboard MTA.** The public page is built in `hugo-apps` and served by the tutorial approuter's static catch-all (`hugo/layouts/devtoberfest/list.html:2-17` is the sibling precedent). It fetches from `/gameboard/*`, which Plan A Task 6 routes through the approuter to `gameboard-srv`. No approuter/MTA change is required for the frontend itself (the `/gameboard/*` route already lands via Plan A).
- **Realtime reuses the EXISTING socket.** Connect to `/ws/event-stream` exactly as `hugo-apps/src/event-display/useEventStream.ts:83-106` does: `io(\`${url}/ws/event-stream\`, {transports:['websocket'],reconnection:true})`, `socket.emit('wsContext',{context})` on connect, `socket.on('tutorialCompleted', …)`. Anonymous `/ws/*` + `/socket.io/*` approuter routes already exist (design §4.4, §6.3). Do NOT add socket infra.
- **Consume Plan A/B contracts verbatim.** `getLeaderboard(top)` → `{value:[{rank,displayName,score,level,communityUrl}]}` (frozen in Plan A `Interface Contracts`, lines 51-63). `getGameboard(scnId)` → `GameboardConfig` (public), `getMyGameboard()` → `MyGameboard` (authenticated-only), `refreshGameboardCache()` → Boolean — **Plan B's frozen contract**, reproduced verbatim in the Interface Contracts block below. Plan B is authoritative; this plan does not restate or alter it.
- **Arcade confined to a `.cabinet` region.** Layout/containers/typography use Horizon tokens (`--sapFontFamily`, `--sapTextColor`, …) + Fundamental Styles utility classes. Pixel font, CRT border, scanline, and glow apply ONLY inside `.cabinet` (design §7.1, lines 232-240). The glow precedent is the aurora/scanline in `hugo-apps/src/devtoberfest/styles.css:36-71` (the `.dtf-header::before` scanline + `.dtf-header::after` + `@keyframes dtfHeroAurora`). NOTE: a literal `cta-glow` class does not exist in the repo (grep-confirmed) — the design's "`cta-glow` precedent" means this scanline/aurora technique; reuse it, do not invent a new engine.
- **Leaderboard + progress are semantic, accessible components** — a real `<table>` for the leaderboard, cards/meters for progress — NOT SVG-string sprites and NOT baked PNGs (design §7.1, lines 237-239; §5.4). Avatar/level art are carried as static assets and positioned by live `score → level`, not sprite-string math.
- **Respect `prefers-reduced-motion` and mute audio by default.** Every animation (scanline shimmer, glow drift, score tick) MUST be disabled under `@media (prefers-reduced-motion: reduce)` (precedent `styles.css:234-236`, `673-680`). Any arcade audio is opt-in and `muted` by default (the old app auto-played `8bit.mp3` at `sap-community-activity-badges/srv/html/devtoberfest_header.html:19` — do NOT autoplay).
- **User-facing UI changes want a committed e2e Playwright spec** (repo convention, CLAUDE.md "User-facing UI changes want a committed e2e spec"; issue #1378). Task 6 adds `test/e2e/gameboard.test.js`. Islands do NOT need an `applicationVersion` bump (that's UI5-only; islands are cache-busted by the Vite content hash on chunks and the approuter static bundle rebuild).
- **Served pages render `<main>` + `<h1>`, never `<article>`** (CLAUDE.md; `test/e2e/tutorial-serve.test.js:31-34`). The gameboard layout mounts into `<main id="gameboard-mount">` and the island's root heading is an `<h1>`.
- **Vite entry registration is required** — an island that isn't in `hugo-apps/vite.config.ts` `rollupOptions.input` (lines 236-274) never builds. `entryFileNames:'[name].js'` (line 276) means the `gameboard` entry emits `/js/gameboard.js`.
- **Island unit tests** live at `hugo-apps/src/**/*.{test,spec}.{js,ts}` and run in the `unit` project (`vitest.config.ts:43`), first line `// @vitest-environment happy-dom`, using `@vue/test-utils` `mount` (precedent `hugo-apps/src/devtoberfest/__tests__/DevtoberfestHome.banner.test.ts:1-4`).
- **Fetch fail-soft:** a `/gameboard/*` fetch error or socket drop degrades to an empty-but-valid board with a visible retry, never a blank crash (mirrors design §6.4 fail-open and `DevtoberfestHome.vue:69-73`).

## Interface Contracts (consumed here)

**Backend HTTP (through the approuter, same origin as the page) — Plan B's frozen contract, verbatim:**

```
GET /gameboard/getLeaderboard(top=<n>)                      // @requires 'any'
  → { value: [ { rank:Integer, displayName:String, score:Integer, level:Integer, communityUrl:String|null } ] }

GET /gameboard/getGameboard(scnId='<id>')                   // @requires 'any' — PUBLIC board config
  → GameboardConfig
GET /gameboard/getMyGameboard()                             // @requires 'authenticated-user' — anon → 401/403
  → MyGameboard
POST /gameboard/refreshGameboardCache()                     // cache-bust seam → Boolean

type LevelThreshold     { level:Integer; minScore:Integer; label?:String }
  // B seeds thresholds from points.json: {1:3000, 2:14000, 3:22000, 4:30000}
type WeekTrackTotal     { week:String; trackId:String; totalPoints:Integer; totalCount:Integer }
type WeekTrackBreakdown { week:String; trackId:String; earnedPoints:Integer; earnedCount:Integer;
                          remainingPoints:Integer; remainingCount:Integer }
type MyGameboard        { userId:String; score:Integer; level:Integer; avatarIndex:Integer;   // avatarIndex 0..37
                          breakdown: array of WeekTrackBreakdown }
type TrackRef           { trackId:String; title:String }
type GameboardConfig    { thresholds: array of LevelThreshold; totals: array of WeekTrackTotal;
                          tracks: array of TrackRef;           // trackId -> title lookup
                          personalized: MyGameboard }   // personalized null unless caller authenticated & a participant
```

> **Contract source:** Plan B is authoritative for `getGameboard`/`getMyGameboard`/the types above; Plan A froze only `getLeaderboard`. Three shape corrections vs the design-only draft are propagated throughout this plan: (1) per-week/track is a single flat `totals: WeekTrackTotal[]` (group by `.week` client-side), not `weeks[]`+`tracks[]`; (2) the personalized slice is a **separate** `getMyGameboard()` endpoint (and `GameboardConfig.personalized`), not an inline `personal` field via `scnId`; (3) the avatar is `avatarIndex: Integer` (0..37), not a filename — the client maps index→art file. Track **titles** are carried by `GameboardConfig.tracks: TrackRef[]` (a `trackId → title` lookup), so meters render human-readable titles.

**Island fetch strategy:** the island ALWAYS calls `getGameboard(scnId='')` for the public board; it additionally calls `getMyGameboard()` and, on 200, merges the personalized slice (a 401/403 means anonymous — swallow it, render the public board with a sign-in invite).

**Realtime:** `/ws/event-stream` Socket.IO namespace, `emit('wsContext',{context:<eventId>})`, `on('tutorialCompleted', …)` (`hugo-apps/src/event-display/useEventStream.ts:83-106`).

**Mount-node data attributes (layout → island):**

```
data-api-leaderboard    /gameboard/getLeaderboard
data-api-gameboard      /gameboard/getGameboard
data-api-my-gameboard   /gameboard/getMyGameboard
data-ws                 (empty → same-origin) or an absolute base for /ws/event-stream
data-img-base           /images/devtoberfest         (avatar/level art root)
data-top                25                            (leaderboard slice size)
```

---

### Task 1: Hugo content + layout (mount node + data attrs)

**Files:**
- Create: `hugo/content/devtoberfest/gameboard/_index.md`
- Create: `hugo/layouts/devtoberfest/gameboard.html`

**Interfaces:**
- Consumes: nothing yet (island not built until Task 3).
- Produces: a `/devtoberfest/gameboard/` page rendering `<main id="gameboard-mount">` with the data attrs above + `<script type="module" src="/js/gameboard.js">`.

- [ ] **Step 1: Write the content file**

`hugo/content/devtoberfest/gameboard/_index.md` (mirrors `hugo/content/devtoberfest/_index.md:1-6`, but selects the new `gameboard` layout):

```markdown
---
title: Devtoberfest Gameboard
description: Live leaderboard and progress board for Devtoberfest — score points by completing tutorials.
type: devtoberfest
layout: gameboard
---
```

- [ ] **Step 2: Write the layout with the mount node**

`hugo/layouts/devtoberfest/gameboard.html` (mirrors `hugo/layouts/devtoberfest/list.html:1-18`; note `<main>`+`<h1>` served-page convention — the island renders the `<h1>`, and `<noscript>` provides a static one):

```html
{{ define "main" }}
<main id="gameboard-mount"
      data-api-leaderboard="/gameboard/getLeaderboard"
      data-api-gameboard="/gameboard/getGameboard"
      data-api-my-gameboard="/gameboard/getMyGameboard"
      data-ws=""
      data-img-base="/images/devtoberfest"
      data-top="25"></main>
<noscript>
  <div class="ds-noscript-fallback">
    <h1>Devtoberfest Gameboard</h1>
    <p>The live leaderboard needs JavaScript. Enable it and refresh to see scores update in real time.</p>
  </div>
</noscript>
<script type="module" src="{{ "/js/gameboard.js" | relURL }}"></script>
{{ end }}
```

- [ ] **Step 3: Verify the page renders (before the island exists)**

Run: `cd D:/projects/tutorials-poc && npm run fetch-tutorials >/dev/null 2>&1; npm run dev` (or `hugo server`) and open `http://localhost:1313/devtoberfest/gameboard/`.
Expected: page loads, `<main id="gameboard-mount">` present in the DOM, `/js/gameboard.js` 404s (island not built yet — acceptable at this step). The `<noscript>` `<h1>` proves the served-page `<main>`+`<h1>` contract holds even before hydration.

- [ ] **Step 4: Commit**

```bash
git add hugo/content/devtoberfest/gameboard/_index.md hugo/layouts/devtoberfest/gameboard.html
git commit -m "feat(gameboard): Hugo gameboard page + layout with island mount node"
```

---

### Task 2: Island types + realtime composable (TDD)

**Files:**
- Create: `hugo-apps/src/gameboard/types.ts`
- Create: `hugo-apps/src/gameboard/useGameboardStream.ts`
- Test: `hugo-apps/src/gameboard/__tests__/useGameboardStream.test.ts`

**Interfaces:**
- Consumes: `/ws/event-stream` (via `socket.io-client`), and the leaderboard fetch (injected callback).
- Produces: `useGameboardStream()` composable exposing `connectionState`, `connect(baseUrl, eventId, onCompleted)`, `disconnect()`; debounces `tutorialCompleted` bursts before invoking `onCompleted`.

- [ ] **Step 1: Write `types.ts`**

```ts
export interface LeaderboardRow {
  rank: number
  displayName: string
  score: number
  level: number
  communityUrl: string | null
}

// ---- Plan B's getGameboard/getMyGameboard contract (verbatim field names) ----
export interface LevelThreshold { level: number; minScore: number; label?: string }
export interface WeekTrackTotal { week: string; trackId: string; totalPoints: number; totalCount: number }
export interface TrackRef { trackId: string; title: string }
export interface WeekTrackBreakdown {
  week: string; trackId: string
  earnedPoints: number; earnedCount: number
  remainingPoints: number; remainingCount: number
}
export interface MyGameboard {
  userId: string
  score: number
  level: number
  avatarIndex: number            // 0..37 — client maps to Group-<n>.png
  breakdown: WeekTrackBreakdown[]
}
export interface GameboardConfig {
  thresholds: LevelThreshold[]
  totals: WeekTrackTotal[]        // flat; group by .week client-side
  tracks: TrackRef[]              // trackId -> title lookup (fail-soft [])
  personalized: MyGameboard | null  // null unless caller authenticated & a participant
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface MountConfig {
  apiLeaderboard: string
  apiGameboard: string
  apiMyGameboard: string
  ws: string          // '' → same-origin
  imgBase: string
  top: number
}
```

- [ ] **Step 2: Write the failing composable test**

`hugo-apps/src/gameboard/__tests__/useGameboardStream.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock socket.io-client so no real connection is attempted.
const handlers: Record<string, (...a: unknown[]) => void> = {}
const emit = vi.fn()
const disconnect = vi.fn()
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb },
    emit,
    disconnect,
  }),
}))

import { useGameboardStream } from '../useGameboardStream'

describe('useGameboardStream', () => {
  beforeEach(() => { vi.useFakeTimers(); for (const k in handlers) delete handlers[k]; emit.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  it('joins wsContext on connect and debounces tutorialCompleted', async () => {
    const onCompleted = vi.fn()
    const { connect, connectionState } = useGameboardStream()
    connect('', 'evt-1', onCompleted)
    handlers['connect']()
    expect(emit).toHaveBeenCalledWith('wsContext', { context: 'evt-1' })
    expect(connectionState.value).toBe('connected')

    handlers['tutorialCompleted']({ bucketName: 'x' })
    handlers['tutorialCompleted']({ bucketName: 'y' })
    expect(onCompleted).not.toHaveBeenCalled()   // still within debounce window
    vi.advanceTimersByTime(1500)
    expect(onCompleted).toHaveBeenCalledTimes(1)  // burst collapsed to one refetch
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd D:/projects/tutorials-poc && npx vitest run hugo-apps/src/gameboard/__tests__/useGameboardStream.test.ts --project unit`
Expected: FAIL — module `../useGameboardStream` does not exist.

- [ ] **Step 4: Implement `useGameboardStream.ts`**

Modeled on `hugo-apps/src/event-display/useEventStream.ts:26-107,121-133` (same `io(...)`, `emit('wsContext',...)`, `on('tutorialCompleted',...)`, `onUnmounted(disconnect)`), reduced to a refetch-trigger with debounce:

```ts
import { ref, readonly, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import type { ConnectionState } from './types'

const DEBOUNCE_MS = 1200

export function useGameboardStream() {
  const connectionState = ref<ConnectionState>('idle')
  let socket: Socket | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function connect(baseUrl: string, eventId: string, onCompleted: () => void) {
    connectionState.value = 'connecting'
    const url = String(baseUrl || '').replace(/\/+$/, '') // '' → same-origin
    socket = io(`${url}/ws/event-stream`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    })
    socket.on('connect', () => {
      connectionState.value = 'connected'
      socket!.emit('wsContext', { context: String(eventId) })
    })
    socket.on('disconnect', () => { connectionState.value = 'reconnecting' })
    socket.on('connect_error', () => { connectionState.value = 'error' })
    socket.on('tutorialCompleted', () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { debounceTimer = null; onCompleted() }, DEBOUNCE_MS)
    })
  }

  function disconnect() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    if (socket) { socket.disconnect(); socket = null }
    connectionState.value = 'idle'
  }

  onUnmounted(disconnect)
  return { connectionState: readonly(connectionState), connect, disconnect }
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run hugo-apps/src/gameboard/__tests__/useGameboardStream.test.ts --project unit`
Expected: PASS — `wsContext` joined, burst debounced to one `onCompleted`.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/gameboard/types.ts hugo-apps/src/gameboard/useGameboardStream.ts \
        hugo-apps/src/gameboard/__tests__/useGameboardStream.test.ts
git commit -m "feat(gameboard): island types + realtime stream composable (debounced refetch)"
```

---

### Task 3: main.ts entry + vite registration + Gameboard.vue shell (TDD)

**Files:**
- Create: `hugo-apps/src/gameboard/main.ts`
- Create: `hugo-apps/src/gameboard/Gameboard.vue`
- Create: `hugo-apps/src/gameboard/styles.css` (imported by main.ts; filled in Task 5)
- Modify: `hugo-apps/vite.config.ts` (register the `gameboard` entry)
- Test: `hugo-apps/src/gameboard/__tests__/Gameboard.test.ts`

**Interfaces:**
- Consumes: `MountConfig` (Task 2), `/gameboard/getLeaderboard`, `/gameboard/getGameboard`.
- Produces: mounted island reading the mount node's data attrs; fetches both endpoints on mount; renders `<h1>` + regions (leaderboard/cabinet filled in Tasks 4/5).

- [ ] **Step 1: Register the vite entry**

In `hugo-apps/vite.config.ts`, add to `rollupOptions.input` (alongside `devtoberfest:` at line 239):

```ts
        gameboard: resolve(__dirname, 'src/gameboard/main.ts'),
```

(`entryFileNames: '[name].js'` at line 276 makes this emit `hugo/static/js/gameboard.js`, served at `/js/gameboard.js`.)

- [ ] **Step 2: Write the failing shell test**

`hugo-apps/src/gameboard/__tests__/Gameboard.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Gameboard from '../Gameboard.vue'
import type { MountConfig } from '../types'

const CONFIG: MountConfig = {
  apiLeaderboard: '/gameboard/getLeaderboard',
  apiGameboard: '/gameboard/getGameboard',
  apiMyGameboard: '/gameboard/getMyGameboard',
  ws: '', imgBase: '/images/devtoberfest', top: 25,
}

// Route the fetch mock by URL: leaderboard, public board, personalized (401 by default).
function stub(opts: {
  leaderboard: unknown[]
  board: Record<string, unknown>
  myStatus?: number
  my?: Record<string, unknown>
}) {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    if (u.includes('getLeaderboard')) return { ok: true, status: 200, json: async () => ({ value: opts.leaderboard }) }
    if (u.includes('getMyGameboard')) {
      const status = opts.myStatus ?? 401
      return { ok: status === 200, status, json: async () => opts.my ?? {} }
    }
    return { ok: true, status: 200, json: async () => opts.board } // getGameboard
  }))
}

describe('Gameboard.vue', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders an h1 and populates the leaderboard table from getLeaderboard', async () => {
    stub({
      leaderboard: [{ rank: 1, displayName: 'Tom J.', score: 120, level: 2, communityUrl: null }],
      board: { thresholds: [], totals: [], tracks: [], personalized: null },
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.findAll('tbody tr').length).toBe(1)
    expect(wrapper.text()).toContain('Tom J.')
    expect(wrapper.text()).toContain('120')
  })

  it('calls all three endpoints and swallows a 401 from getMyGameboard (anonymous)', async () => {
    stub({
      leaderboard: [],
      board: { thresholds: [], totals: [{ week: '1', trackId: 't1', totalPoints: 3000, totalCount: 5 }], tracks: [{ trackId: 't1', title: 'ABAP' }], personalized: null },
      myStatus: 401,
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0])
    expect(calls.some(u => u.includes('getLeaderboard'))).toBe(true)
    expect(calls.some(u => u.includes('getGameboard'))).toBe(true)
    expect(calls.some(u => u.includes('getMyGameboard'))).toBe(true)
    // anonymous → no crash, board still ready, no retry shown
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gameboard-retry"]').exists()).toBe(false)
  })

  it('degrades to an empty-but-valid board with a retry on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gameboard-retry"]').exists()).toBe(true)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run hugo-apps/src/gameboard/__tests__/Gameboard.test.ts --project unit`
Expected: FAIL — `../Gameboard.vue` does not exist.

- [ ] **Step 4: Write `Gameboard.vue` (shell + data fetch)**

Sub-components `Leaderboard`/`CabinetFrame` land in Tasks 4/5; here the shell holds state, fetches both endpoints fail-soft, renders the `<h1>` and a minimal inline table so the test passes. (Precedent for fetch + state machine: `DevtoberfestHome.vue:14-74`.)

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { MountConfig, LeaderboardRow, GameboardConfig, MyGameboard } from './types'
import { useGameboardStream } from './useGameboardStream'

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

    <!-- Real accessible leaderboard (Task 4 extracts to Leaderboard.vue) -->
    <section class="gb-leaderboard" aria-label="Leaderboard">
      <table class="fd-table" aria-label="Devtoberfest leaderboard">
        <thead>
          <tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Score</th><th scope="col">Level</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.rank">
            <td>{{ r.rank }}</td>
            <td>
              <a v-if="r.communityUrl" :href="r.communityUrl" rel="noopener">{{ r.displayName }}</a>
              <span v-else>{{ r.displayName }}</span>
            </td>
            <td>{{ r.score }}</td>
            <td>{{ r.level }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="state === 'error'" class="gb-error" role="status">
        Couldn't reach the gameboard.
        <button type="button" data-testid="gameboard-retry" @click="loadAll">Retry</button>
      </p>
    </section>
  </div>
</template>
```

- [ ] **Step 5: Write `main.ts`**

Mirrors `hugo-apps/src/devtoberfest/main.ts:1-18` (read mount node, parse data attrs, mount):

```ts
import { createApp } from 'vue'
import Gameboard from './Gameboard.vue'
import './styles.css'
import type { MountConfig } from './types'

const mount = document.getElementById('gameboard-mount') as HTMLElement | null
if (mount) {
  const config: MountConfig = {
    apiLeaderboard: mount.dataset.apiLeaderboard || '/gameboard/getLeaderboard',
    apiGameboard:   mount.dataset.apiGameboard   || '/gameboard/getGameboard',
    apiMyGameboard: mount.dataset.apiMyGameboard || '/gameboard/getMyGameboard',
    ws:             mount.dataset.ws             || '',
    imgBase:        mount.dataset.imgBase        || '/images/devtoberfest',
    top:            Number(mount.dataset.top) || 25,
  }
  createApp(Gameboard, { config }).mount(mount)
}
```

- [ ] **Step 6: Create an empty `styles.css` placeholder (filled in Task 5)**

`hugo-apps/src/gameboard/styles.css`:

```css
/* Gameboard island styles — arcade cabinet confined to .cabinet; leaderboard/progress
 * are Horizon/Fundamental semantic components. Full styling in Plan C Task 5. */
.gb-root { max-width: 1200px; margin: 0 auto; padding: 1rem; }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run hugo-apps/src/gameboard/__tests__/Gameboard.test.ts --project unit`
Expected: PASS — `<h1>` present, one leaderboard row rendered, retry button on failure.

- [ ] **Step 8: Verify the island builds**

Run: `cd D:/projects/tutorials-poc/hugo-apps && npx vite build 2>&1 | tail -5 && test -f ../hugo/static/js/gameboard.js && echo "gameboard.js emitted"`
Expected: build succeeds, `gameboard.js emitted` prints.

- [ ] **Step 9: Commit**

```bash
git add hugo-apps/vite.config.ts hugo-apps/src/gameboard/main.ts hugo-apps/src/gameboard/Gameboard.vue \
        hugo-apps/src/gameboard/styles.css hugo-apps/src/gameboard/__tests__/Gameboard.test.ts
git commit -m "feat(gameboard): island entry + vite registration + Gameboard shell with fail-soft fetch"
```

---

### Task 4: Leaderboard.vue — accessible semantic component + dataviz (TDD)

**Files:**
- Create: `hugo-apps/src/gameboard/Leaderboard.vue`
- Modify: `hugo-apps/src/gameboard/Gameboard.vue` (use `<Leaderboard>`)
- Test: `hugo-apps/src/gameboard/__tests__/Leaderboard.test.ts`

**Interfaces:**
- Consumes: `LeaderboardRow[]` prop.
- Produces: an accessible `<table>` with a caption, ranked rows, community links, and a score bar per row (dataviz-guided, accessible in light/dark).

- [ ] **Step 1: Invoke the `dataviz` skill**

Before writing any visual, call the `dataviz` skill (Skill tool, `skill: "dataviz"`) and follow its color/mark/legend guidance for the leaderboard score bars and the Task 5 progress meters. Use its accessible palette (light + dark) via CSS custom properties; do not hardcode brand hexes that fail contrast.

- [ ] **Step 2: Write the failing test**

`hugo-apps/src/gameboard/__tests__/Leaderboard.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Leaderboard from '../Leaderboard.vue'
import type { LeaderboardRow } from '../types'

const ROWS: LeaderboardRow[] = [
  { rank: 1, displayName: 'Tom J. (community)', score: 300, level: 3, communityUrl: 'https://community.sap.com/u/1' },
  { rank: 2, displayName: 'Ann K.', score: 150, level: 2, communityUrl: null },
]

describe('Leaderboard.vue', () => {
  it('renders a captioned accessible table with a community link and score bars scaled to the leader', () => {
    const w = mount(Leaderboard, { props: { rows: ROWS } })
    expect(w.find('table caption').exists()).toBe(true)
    expect(w.findAll('th[scope="col"]').length).toBeGreaterThanOrEqual(4)
    expect(w.findAll('tbody tr').length).toBe(2)
    const link = w.find('tbody tr:first-child a')
    expect(link.attributes('href')).toBe('https://community.sap.com/u/1')
    expect(link.attributes('rel')).toContain('noopener')
    // score bar width is proportional to the top score (300 → 100%)
    const topBar = w.find('tbody tr:first-child [data-testid="score-bar"]')
    expect(topBar.attributes('style') || '').toContain('100%')
  })

  it('shows an empty state when there are no rows', () => {
    const w = mount(Leaderboard, { props: { rows: [] } })
    expect(w.text().toLowerCase()).toContain('no scores yet')
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run hugo-apps/src/gameboard/__tests__/Leaderboard.test.ts --project unit`
Expected: FAIL — component missing.

- [ ] **Step 4: Write `Leaderboard.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { LeaderboardRow } from './types'

const props = defineProps<{ rows: LeaderboardRow[] }>()
const maxScore = computed(() => Math.max(1, ...props.rows.map(r => r.score)))
function barWidth(score: number): string {
  return `${Math.round((score / maxScore.value) * 100)}%`
}
</script>

<template>
  <div class="gb-leaderboard">
    <table class="fd-table gb-lb-table" aria-describedby="gb-lb-cap">
      <caption id="gb-lb-cap" class="gb-lb-caption">Devtoberfest leaderboard — live</caption>
      <thead>
        <tr>
          <th scope="col" class="gb-lb-rank">Rank</th>
          <th scope="col">Player</th>
          <th scope="col">Score</th>
          <th scope="col">Level</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.rank">
          <td class="gb-lb-rank">{{ r.rank }}</td>
          <td>
            <a v-if="r.communityUrl" :href="r.communityUrl" rel="noopener noreferrer" target="_blank">{{ r.displayName }}</a>
            <span v-else>{{ r.displayName }}</span>
          </td>
          <td>
            <span class="gb-score-num">{{ r.score }}</span>
            <span class="gb-score-track" aria-hidden="true">
              <span class="gb-score-bar" data-testid="score-bar" :style="{ width: barWidth(r.score) }"></span>
            </span>
          </td>
          <td>{{ r.level }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!rows.length" class="gb-lb-empty" role="status">No scores yet — be the first to complete a tutorial!</p>
  </div>
</template>
```

- [ ] **Step 5: Wire it into `Gameboard.vue`**

Replace the inline `<table>` block in `Gameboard.vue` (Task 3 Step 4) with `<Leaderboard :rows="rows" />` and add `import Leaderboard from './Leaderboard.vue'`. Keep the error/retry `<p>` in `Gameboard.vue`.

- [ ] **Step 6: Run both island suites**

Run: `npx vitest run hugo-apps/src/gameboard --project unit`
Expected: PASS — Leaderboard tests + the existing Gameboard tests still green (Gameboard test asserts `tbody tr` count, which `<Leaderboard>` still renders).

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/gameboard/Leaderboard.vue hugo-apps/src/gameboard/Gameboard.vue \
        hugo-apps/src/gameboard/__tests__/Leaderboard.test.ts
git commit -m "feat(gameboard): accessible Leaderboard component with dataviz score bars"
```

---

### Task 5: CabinetFrame.vue + modernized-arcade styles (cabinet region, reduced-motion) (TDD)

**Files:**
- Create: `hugo-apps/src/gameboard/CabinetFrame.vue`
- Modify: `hugo-apps/src/gameboard/Gameboard.vue` (mount `<CabinetFrame>` with level/avatar + progress)
- Modify: `hugo-apps/src/gameboard/styles.css` (CRT frame, scanline, glow, pixel font, progress meters — all reduced-motion-guarded)
- Test: `hugo-apps/src/gameboard/__tests__/CabinetFrame.test.ts`

**Interfaces:**
- Consumes: `GameboardConfig` (`thresholds`, `totals: WeekTrackTotal[]`, `tracks: TrackRef[]`, `personalized: MyGameboard|null`) + `imgBase`.
- Produces: the contained arcade "cabinet" — pixel heading, CRT border, scanline/glow, avatar art positioned by `personalized.avatarIndex` (0..37), and per-week/track progress (from `totals` grouped by week, labelled via the `tracks` title lookup, personalized via `MyGameboard.breakdown`) rendered as accessible meters (NOT baked images).

- [ ] **Step 1: Write the failing test**

`hugo-apps/src/gameboard/__tests__/CabinetFrame.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CabinetFrame from '../CabinetFrame.vue'
import type { GameboardConfig } from '../types'

const BOARD: GameboardConfig = {
  thresholds: [{ level: 0, minScore: 0 }, { level: 1, minScore: 3000 }, { level: 2, minScore: 14000 }],
  totals: [
    { week: '1', trackId: 't1', totalPoints: 3000, totalCount: 5 },
    { week: '1', trackId: 't2', totalPoints: 2000, totalCount: 4 },
    { week: '2', trackId: 't1', totalPoints: 1500, totalCount: 3 },
  ],
  tracks: [
    { trackId: 't1', title: 'ABAP' },
    { trackId: 't2', title: 'BTP' },
  ],
  personalized: {
    userId: 'u1', score: 3500, level: 1, avatarIndex: 3,
    breakdown: [
      { week: '1', trackId: 't1', earnedPoints: 3000, earnedCount: 3, remainingPoints: 0, remainingCount: 2 },
      { week: '2', trackId: 't1', earnedPoints: 500, earnedCount: 1, remainingPoints: 1000, remainingCount: 2 },
    ],
  },
}

describe('CabinetFrame.vue', () => {
  it('confines arcade styling to a .cabinet region and maps avatarIndex→art file', () => {
    const w = mount(CabinetFrame, { props: { board: BOARD, imgBase: '/images/devtoberfest' } })
    expect(w.find('.cabinet').exists()).toBe(true)
    // avatarIndex 3 → Group-3.png under imgBase (static asset, not an inline SVG string)
    const img = w.find('.cabinet img')
    expect(img.attributes('src')).toBe('/images/devtoberfest/avatars/Group-3.png')
    // alt text uses the personalized level
    expect(img.attributes('alt')).toContain('level 1')
    // per-week progress rendered as accessible meters (progressbar role), not baked images.
    // BOARD has weeks '1' and '2' → at least two week meters.
    const bars = w.findAll('[role="progressbar"]')
    expect(bars.length).toBeGreaterThanOrEqual(2)
    expect(bars[0].attributes('aria-valuenow')).toBeDefined()
    // meters are labelled by the resolved track TITLE, not the trackId GUID
    expect(w.text()).toContain('ABAP')
    expect(w.text()).not.toContain('t1')
    expect(w.text()).toContain('Level 1')
  })

  it('renders a public (no-personalized) cabinet without throwing', () => {
    const w = mount(CabinetFrame, { props: { board: { ...BOARD, personalized: null }, imgBase: '/images/devtoberfest' } })
    expect(w.find('.cabinet').exists()).toBe(true)
    expect(w.text().toLowerCase()).toContain('log in') // invite to sign in for a personal slice
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run hugo-apps/src/gameboard/__tests__/CabinetFrame.test.ts --project unit`
Expected: FAIL — component missing.

- [ ] **Step 3: Write `CabinetFrame.vue`**

Avatar art comes from static assets under `imgBase`, indexed by `avatarIndex` (0..37): the old app shipped `avatars/Group-0.png`..`Group-37.png` (verified — 38 files; note `Group-34.PNG` has an uppercase extension, normalize it to lowercase `.png` when carrying the assets over in Step 6 so the `Group-${i}.png` mapping is uniform). Per-week/track progress uses native accessible `role="progressbar"` meters (NOT sprites). `GameboardConfig.totals` is flat — grouped by `.week` client-side. Track meters are labelled with the human-readable **title** resolved from `GameboardConfig.tracks` (a `trackId → title` lookup), falling back to the raw `trackId` only when the id is absent (defensive — `tracks` is fail-soft `[]`).

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { GameboardConfig, WeekTrackTotal, WeekTrackBreakdown } from './types'

const props = defineProps<{ board: GameboardConfig; imgBase: string }>()

const personalized = computed(() => props.board.personalized)

// avatarIndex (0..37) → Group-<n>.png. Clamp defensively to the shipped range.
const avatarSrc = computed(() => {
  const idx = Math.min(37, Math.max(0, personalized.value?.avatarIndex ?? 0))
  return `${props.imgBase}/avatars/Group-${idx}.png`
})

// trackId → title lookup from board.tracks (fail-soft []). Falls back to the raw
// id only when the track isn't found (defensive; keeps meters labelled).
const trackTitles = computed<Map<string, string>>(() => {
  const m = new Map<string, string>()
  for (const t of props.board.tracks ?? []) m.set(t.trackId, t.title)
  return m
})
function trackTitle(trackId: string): string {
  return trackTitles.value.get(trackId) ?? trackId
}

// Group the flat totals by week for display: Map<week, WeekTrackTotal[]>.
const weeks = computed<Array<{ week: string; tracks: WeekTrackTotal[] }>>(() => {
  const byWeek = new Map<string, WeekTrackTotal[]>()
  for (const t of props.board.totals) {
    const arr = byWeek.get(t.week) ?? []
    arr.push(t)
    byWeek.set(t.week, arr)
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([week, tracks]) => ({ week, tracks }))
})

// Personalized earned/total per week+track, keyed for O(1) lookup.
const earnedByKey = computed<Map<string, WeekTrackBreakdown>>(() => {
  const m = new Map<string, WeekTrackBreakdown>()
  for (const b of personalized.value?.breakdown ?? []) m.set(`${b.week}|${b.trackId}`, b)
  return m
})

// Progress % for a track cell: earnedPoints / totalPoints (0 when no personal data).
function pct(week: string, t: WeekTrackTotal): number {
  if (!t.totalPoints) return 0
  const earned = earnedByKey.value.get(`${week}|${t.trackId}`)?.earnedPoints ?? 0
  return Math.min(100, Math.round((earned / t.totalPoints) * 100))
}
function earnedPoints(week: string, t: WeekTrackTotal): number {
  return earnedByKey.value.get(`${week}|${t.trackId}`)?.earnedPoints ?? 0
}
</script>

<template>
  <section class="cabinet" aria-label="Devtoberfest arcade cabinet">
    <div class="cabinet-screen">
      <p class="cabinet-title">DEVTOBERFEST</p>

      <div v-if="personalized" class="cabinet-player">
        <img :src="avatarSrc" :alt="`Your avatar, level ${personalized.level}`" class="cabinet-avatar" width="96" height="96" />
        <p class="cabinet-level">Level {{ personalized.level }} · {{ personalized.score }} pts</p>
      </div>
      <p v-else class="cabinet-anon">Log in via the user menu (top-right) to see your level and progress.</p>

      <div class="cabinet-progress">
        <div v-for="wk in weeks" :key="wk.week" class="cabinet-week">
          <h2 class="cabinet-sub">Week {{ wk.week }}</h2>
          <ul class="cabinet-meters">
            <li v-for="t in wk.tracks" :key="t.trackId">
              <!-- Label by resolved track TITLE (falls back to trackId only if unknown). -->
              <span class="cabinet-meter-label">{{ trackTitle(t.trackId) }}</span>
              <span class="cabinet-meter" role="progressbar"
                    :aria-valuenow="earnedPoints(wk.week, t)" :aria-valuemin="0" :aria-valuemax="t.totalPoints"
                    :aria-label="`Week ${wk.week}, ${trackTitle(t.trackId)}: ${earnedPoints(wk.week, t)} of ${t.totalPoints} points`">
                <span class="cabinet-meter-fill" :style="{ width: pct(wk.week, t) + '%' }"></span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
```

- [ ] **Step 4: Wire it into `Gameboard.vue`**

Replace the empty `<section class="cabinet">` placeholder from Task 3 with `<CabinetFrame v-if="board" :board="board" :img-base="config.imgBase" />` and add `import CabinetFrame from './CabinetFrame.vue'`.

- [ ] **Step 5: Fill `styles.css` — arcade confined to `.cabinet`, reduced-motion guarded**

Append to `hugo-apps/src/gameboard/styles.css`. Base layout uses Horizon tokens; the CRT/scanline/glow reuse the `styles.css:36-71` technique (repeating-linear-gradient scanline + radial-gradient glow + a keyframe), scoped to `.cabinet`. Leaderboard bars use dataviz palette custom props. All animation disabled under `prefers-reduced-motion` (precedent `styles.css:234-236,673-680`):

```css
/* ---- Leaderboard (Horizon/Fundamental semantic) ---- */
.gb-title { font-family: var(--sapFontHeaderFamily, var(--sapFontFamily)); color: var(--sapTextColor, #1d2d3e); }
.gb-lb-table { width: 100%; border-collapse: collapse; }
.gb-lb-caption { text-align: left; font-weight: 600; padding: .5rem 0; color: var(--sapTextColor, #1d2d3e); }
.gb-score-track { display: inline-block; width: 120px; height: 8px; margin-left: .5rem;
  background: var(--gb-track-bg, rgba(0,0,0,.08)); border-radius: 4px; vertical-align: middle; }
.gb-score-bar { display: block; height: 100%; border-radius: 4px;
  background: var(--gb-accent, #0070f2); } /* swap for dataviz palette var */
.gb-lb-empty { color: var(--sapContent_LabelColor, #556b82); }

/* ---- Cabinet region (arcade personality, contained) ---- */
.cabinet { margin: 1.5rem 0; border-radius: 14px; padding: 4px;
  background: linear-gradient(165deg, #5D36FF 0%, #7B42F0 45%, #A100C2 100%);
  box-shadow: 0 4px 16px rgba(0,0,0,.18); isolation: isolate; }
.cabinet-screen { position: relative; border-radius: 10px; padding: 1.25rem 1.5rem;
  background: #0b1020; color: #e8f0ff; overflow: hidden; }
/* CRT scanline overlay (from styles.css:36-50 precedent) */
.cabinet-screen::before { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background-image: repeating-linear-gradient(to bottom,
    rgba(255,255,255,.05) 0, rgba(255,255,255,.05) 1px, transparent 1px, transparent 3px);
  mix-blend-mode: overlay; }
/* Drifting glow (from styles.css:53-71 precedent) */
.cabinet-screen::after { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background: radial-gradient(ellipse at 20% 120%, rgba(128,0,220,.5), transparent 55%),
              radial-gradient(ellipse at 85% -10%, rgba(241,172,255,.3), transparent 55%);
  filter: blur(28px); opacity: .85; animation: gbGlow 14s ease-in-out infinite alternate; }
.cabinet-screen > * { position: relative; z-index: 1; }
@keyframes gbGlow { from { transform: translate3d(-3%,0,0) scale(1.05); } to { transform: translate3d(3%,-2%,0) scale(1.12); } }
/* Pixel font for cabinet headings only (system pixel stack; no external font dependency) */
.cabinet-title, .cabinet-sub { font-family: "Press Start 2P", "Courier New", monospace;
  letter-spacing: .06em; text-transform: uppercase; }
.cabinet-title { font-size: 1.1rem; margin: 0 0 .75rem; text-shadow: 0 0 8px rgba(129,140,248,.7); }
.cabinet-sub { font-size: .7rem; margin: 1rem 0 .5rem; opacity: .9; }
.cabinet-avatar { image-rendering: pixelated; border: 2px solid rgba(255,255,255,.25); border-radius: 8px; }
.cabinet-meter { display: inline-block; width: 160px; height: 10px; margin-left: .5rem; vertical-align: middle;
  background: rgba(255,255,255,.15); border-radius: 5px; overflow: hidden; }
.cabinet-meter-fill { display: block; height: 100%; background: var(--gb-accent, #7858ff); border-radius: 5px;
  transition: width .4s ease; }
.cabinet-meters { list-style: none; padding: 0; margin: 0; display: grid; gap: .4rem; }

/* ---- Reduced motion: kill ALL cabinet animation/transition ---- */
@media (prefers-reduced-motion: reduce) {
  .cabinet-screen::after { animation: none; }
  .cabinet-meter-fill { transition: none; }
}
```

- [ ] **Step 6: Carry over the static avatar/level art**

Copy the avatar art the cabinet indexes by `avatarIndex` (0..37) into the Hugo static tree (source `D:\projects\sap-community-activity-badges\srv\images\devtoberfest\avatars\`; the layout's `data-img-base` is `/images/devtoberfest`, so target `hugo/static/images/devtoberfest/avatars/`). The old app shipped exactly `Group-0.png`..`Group-37.png` (38 files), but `Group-34.PNG` uses an uppercase extension — normalize it to lowercase so the `Group-${idx}.png` mapping in `CabinetFrame.vue` is uniform:

```bash
mkdir -p D:/projects/tutorials-poc/hugo/static/images/devtoberfest/avatars
src="D:/projects/sap-community-activity-badges/srv/images/devtoberfest/avatars"
dst="D:/projects/tutorials-poc/hugo/static/images/devtoberfest/avatars"
for i in $(seq 0 37); do
  # tolerate .png / .PNG in the source; always write lowercase .png to the target
  f=$(ls "$src/Group-$i".* 2>/dev/null | head -1)
  [ -n "$f" ] && cp -n "$f" "$dst/Group-$i.png"
done
ls "$dst" | grep -c "Group-.*\.png"   # expect 38
```

Verify `hugo/static/images/devtoberfest/avatars/` isn't already populated by the sibling devtoberfest island before copying. Level-cloud PNGs (`levels/`) are optional decorative extras — not required by `CabinetFrame.vue`.

- [ ] **Step 7: Run the island suite + build**

Run: `npx vitest run hugo-apps/src/gameboard --project unit && cd hugo-apps && npx vite build 2>&1 | tail -3`
Expected: PASS + `gameboard.js` rebuilds.

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/gameboard/CabinetFrame.vue hugo-apps/src/gameboard/Gameboard.vue \
        hugo-apps/src/gameboard/styles.css hugo-apps/src/gameboard/__tests__/CabinetFrame.test.ts \
        hugo/static/images/devtoberfest/avatars/
git commit -m "feat(gameboard): CRT cabinet with pixel headings, accessible progress meters, reduced-motion guards"
```

---

### Task 6: Committed Playwright e2e spec

**Files:**
- Create: `test/e2e/gameboard.test.js`

**Interfaces:**
- Consumes: the deployed approuter (`PLAYWRIGHT_BASE_URL`/`SMOKE_BASE_URL`), the built `/js/gameboard.js`, and the `/gameboard/*` backend route (Plan A Task 6).
- Produces: an e2e spec that self-skips without a base URL (repo convention), asserting the board renders, the leaderboard populates, the cabinet is visible, and reduced-motion is respected.

- [ ] **Step 1: Write the spec** (mirrors `test/e2e/tutorial-serve.test.js:1-39` — `describe.skipIf(!hasBaseUrl())`, `_browser.js`/`e2e.config.js` helpers, vitest + playwright-core; runs in the `e2e` project, `vitest.config.ts:181-182`)

`test/e2e/gameboard.test.js`:

```js
// e2e: public Devtoberfest gameboard (Plan C). Anonymous.
// Path: browser → approuter /devtoberfest/gameboard/ (static) → /js/gameboard.js
//       → island fetch /gameboard/getLeaderboard + /gameboard/getGameboard (→ gameboard-srv)
//       → realtime via existing /ws/event-stream.
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: devtoberfest gameboard (anonymous)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('renders the board, cabinet, and a populated leaderboard', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/gameboard/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // Served page convention: <main> + <h1> (never <article>).
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('h1').count(), 'gameboard should render a heading').toBeGreaterThan(0);

      // Island hydrates the arcade cabinet region.
      await page.locator('.cabinet').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('.cabinet').count()).toBeGreaterThan(0);

      // Leaderboard table hydrates; either populated rows OR a visible empty-state
      // (a fresh event legitimately has zero scores — both are a valid render).
      await page.locator('table').first().waitFor({ state: 'visible', timeout: 15_000 });
      const rowCount = await page.locator('tbody tr').count();
      const hasEmpty = await page.getByText(/no scores yet/i).count();
      expect(rowCount > 0 || hasEmpty > 0, 'leaderboard should show rows or an empty state').toBe(true);
    } finally {
      await context.close();
    }
  });

  it('respects prefers-reduced-motion (no cabinet glow animation)', async () => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await page.goto('/devtoberfest/gameboard/', { waitUntil: 'domcontentloaded' });
      await page.locator('.cabinet-screen').first().waitFor({ state: 'visible', timeout: 15_000 });
      // The ::after glow animation must be 'none' under reduced motion.
      const anim = await page.locator('.cabinet-screen').first().evaluate(
        (el) => getComputedStyle(el, '::after').animationName,
      );
      expect(anim === 'none' || anim === '' || anim == null, `glow animation should be off, got ${anim}`).toBe(true);
    } finally {
      await context.close();
    }
  });
});
```

> Note: `newPage` sets `baseURL` from `e2e.config.js:14-16`, so relative `page.goto('/devtoberfest/gameboard/')` resolves against the deployed approuter. The reduced-motion test builds its own context because `newPage` doesn't expose `reducedMotion` — acceptable, matches the `_browser.js` context-per-test model.

- [ ] **Step 2: Run it locally (self-skips without a base URL)**

Run: `cd D:/projects/tutorials-poc && npm run test:e2e`
Expected: SKIPPED (no `PLAYWRIGHT_BASE_URL`/`SMOKE_BASE_URL`) — proving the guard. It exercises for real post-DEV-deploy in the `e2e` CI job.

- [ ] **Step 3: (Optional, when a DEV deploy carrying Plans A–C exists) run against DEV**

Run: `PLAYWRIGHT_BASE_URL=https://<tutorial-approuter-host> npm run test:e2e -- test/e2e/gameboard.test.js`
Expected: PASS — board + cabinet + leaderboard render; reduced-motion glow off.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/gameboard.test.js
git commit -m "test(e2e): committed gameboard spec (board, cabinet, leaderboard, reduced-motion)"
```

---

### Task 7: Full island suite + build gate + PR

**Files:** none new — verification + PR.

- [ ] **Step 1: Run the whole unit project (islands + repo units)**

Run: `cd D:/projects/tutorials-poc && npx vitest run --project unit`
Expected: PASS — the three gameboard island suites pass and nothing else regresses.

- [ ] **Step 2: Full production island build**

Run: `cd D:/projects/tutorials-poc/hugo-apps && npx vite build`
Expected: `../hugo/static/js/gameboard.js` emitted, no budget-plugin errors (the gameboard entry has no dedicated gzip budget — none required).

- [ ] **Step 3: Real-thing check (per Tom's #1 rule)**

Run `npm run dev` and open `http://localhost:1313/devtoberfest/gameboard/`. Manually confirm: the `<h1>` and cabinet render, the leaderboard table shows rows or a clean empty state, and toggling OS "reduce motion" stops the glow. (For live data + realtime, point at a DEV deploy carrying Plans A–C.) Do NOT call this done on unit tests alone.

- [ ] **Step 4: Open a PR (never direct-merge to main)**

```bash
git push -u origin <feature-branch>
gh pr create --title "feat(gameboard): public gameboard Hugo page + Vue island (Plan C)" \
  --body "Modernized-arcade Devtoberfest gameboard island. Consumes /gameboard/getLeaderboard + /gameboard/getGameboard through the approuter; realtime via existing /ws/event-stream. Cabinet arcade region confined + reduced-motion guarded; committed e2e spec added."
```

---

## Self-Review

**Spec coverage (design §7.1 UI portion):**
- Hugo content + layout with `#gameboard-mount` data-attrs → Task 1 (mirrors `list.html:2-17`). ✅
- Vue island `hugo-apps/src/gameboard/` (main.ts, Gameboard.vue, Leaderboard.vue, CabinetFrame.vue, types.ts, styles.css) + vite entry `gameboard:` → Tasks 2–5 (registration Task 3 Step 1, at `vite.config.ts:239` sibling). ✅
- Modernized arcade: Horizon/Fundamental layout + arcade confined to `.cabinet` (CRT border, pixel headings, scanline/glow reusing `styles.css:36-71` precedent) → Task 5. Note: literal `cta-glow` class does not exist in-repo; the aurora/scanline technique is the precedent, cited. ✅
- Leaderboard + progress as real accessible components (semantic `<table>`, `role="progressbar"` meters), NOT baked images; avatar art as static assets positioned by `avatarIndex` (0..37) → Tasks 4, 5. ✅
- Realtime `useGameboardStream.ts` modeled on `useEventStream.ts` (io `/ws/event-stream`, `wsContext`, `tutorialCompleted` → debounced refetch) → Task 2. ✅
- `dataviz` skill invoked before visuals; accessible light/dark palette → Task 4 Step 1. ✅
- Committed self-skipping Playwright e2e spec (`test/e2e/gameboard.test.js`) → Task 6. ✅
- `prefers-reduced-motion` guarded + audio muted-by-default (no autoplay) → Global Constraints + Task 5 Step 5. ✅
- Served `<main>`+`<h1>` convention; islands need no `applicationVersion` bump → Global Constraints + Task 1/6. ✅

**Placeholder scan:** No TBDs. `styles.css` starts minimal in Task 3 by design (a real one-line file, filled in Task 5) — flagged in-step, not a placeholder in the deliverable. Every code step has runnable content.

**Type consistency:** `LeaderboardRow` keys (`rank`, `displayName`, `score`, `level`, `communityUrl`) match Plan A's frozen contract and are identical across `types.ts`, `Gameboard.vue`, `Leaderboard.vue`, and both tests. `GameboardConfig`/`MyGameboard`/`WeekTrackTotal`/`WeekTrackBreakdown`/`LevelThreshold`/`TrackRef` field names are copied verbatim from Plan B and are identical across `types.ts` (Task 2), `Gameboard.vue` (Task 3), `CabinetFrame.vue` (Task 5), and the test fixtures. `MountConfig` keys (`apiLeaderboard`, `apiGameboard`, `apiMyGameboard`, `ws`, `imgBase`, `top`) match the layout data-attrs (Task 1) ↔ `main.ts` parsing (Task 3) ↔ the components.

**Plan B contract — reconciled (final).** This plan consumes Plan B's finalized contract verbatim. Corrections propagated from the earlier design-only draft:
1. `weeks[]`+`tracks[]` totals → a single flat `totals: WeekTrackTotal[]` (`week`, `trackId`, `totalPoints`, `totalCount`); `CabinetFrame.vue` groups by `.week` client-side.
2. inline `personal` field → a **separate** `getMyGameboard()` endpoint (`@requires:'authenticated-user'`) plus `GameboardConfig.personalized`; `Gameboard.vue` always calls `getGameboard(scnId='')` and additionally calls `getMyGameboard()`, swallowing 401/403 for anonymous callers.
3. `avatar` filename → `avatarIndex: Integer` (0..37); `CabinetFrame.vue` maps `avatarIndex → Group-<n>.png` (verified 38 files `Group-0..37`; `Group-34.PNG` normalized to lowercase in Task 5 Step 6). Alt text uses `personalized.level`. Breakdown uses `earnedPoints`/`remainingPoints` (not scalar `earned`/`remaining`).
4. Track **titles** are carried by `GameboardConfig.tracks: TrackRef[]` (`trackId → title`). `CabinetFrame.vue` builds a `trackTitle(trackId)` Map lookup and labels every meter (and its `aria-label`) with the title, falling back to the raw `trackId` only when the id is absent (defensive — `tracks` is fail-soft `[]`). The CabinetFrame test asserts meters show `"ABAP"`, not `"t1"`. No residual open contract items.

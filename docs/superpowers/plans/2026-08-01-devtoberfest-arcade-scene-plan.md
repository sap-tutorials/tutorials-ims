# Devtoberfest Animated Arcade Gameboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recreate the legacy Devtoberfest animated arcade gameboard as a new Vue island at `/devtoberfest/arcade/` in tutorials-ims, driven by the logged-in user's live `getMyGameboard` data, with an animated demo + register CTA for anonymous visitors.

**Architecture:** A Hugo page + Vue 3 island (same pattern as `hugo-apps/src/gameboard/` and `src/devtoberfest/`), built by the shared `hugo-apps` Vite project into `hugo/static/js/arcade.js`, served through the existing approuter static catch-all. It fetches `/gameboard/getMyGameboard` from the already-deployed gameboard-srv. The arcade scene is CSS-positioned sprite layers + ported CSS keyframe animations (NOT a server-side SVG-string renderer). Assets are static files under `hugo/static/images/devtoberfest/`.

**Tech Stack:** Vue 3 (`<script setup>` + TS), Vite (hugo-apps), Hugo, CSS keyframes, vitest (island unit tests), Playwright (committed e2e). No backend/MTA/route changes.

## Global Constraints

- **No `scnId`** — identity is the tutorial-system session; the island calls `/gameboard/getMyGameboard` (returns `{ userId, score, level, avatarIndex, breakdown }`). A 401/anonymous or any fetch error → the demo+CTA state, never a broken board (fail-soft).
- **Separate from the leaderboard** — the existing `/devtoberfest/gameboard/` island is UNTOUCHED. This is a new sibling at `/devtoberfest/arcade/`.
- **Level mechanic is faithful** — avatar (`Group-<avatarIndex>.png`, clamp 0–37) sits on the level-cloud matching `level` (0–4); bounce iteration count = level (level 4 = infinite); hearts drawn = level; banner shows live `score`/`level`.
- **`prefers-reduced-motion: reduce`** disables ALL animation (static scene).
- **Audio muted by default** — `8bit.mp3` behind a toggle, NO autoplay.
- **Reuse the already-committed 38 avatars** at `hugo/static/images/devtoberfest/avatars/Group-0..37.png` — do NOT re-copy or duplicate them.
- **Assets are static files**, not base64-embedded; carry only referenced sprites; optimize heavy PNGs.
- **Island bundle budget** — the hugo-apps build enforces per-island size checks; lazy-load non-critical sprites so `arcade.js` stays lean (assets are separate static files anyway).
- **Vite entry format** (verbatim): `arcade: resolve(__dirname, 'src/arcade/main.ts'),` added beside `gameboard:` at `hugo-apps/vite.config.ts:240`.

## Data contract (consumed, frozen by the deployed backend)

```
GET /gameboard/getMyGameboard()  @requires authenticated-user
  → { userId: string, score: number, level: number (0..4), avatarIndex: number (0..37),
      breakdown: [{ week, trackId, earnedPoints, earnedCount, remainingPoints, remainingCount }] }
  → 401 when anonymous  → island shows demo+CTA
```

## Legacy keyframes to port (verbatim from srv/images/devtoberfest/css/devtoberfestSVG.css)

```css
@keyframes fadeInAnimation { from { opacity: 0 } to { opacity: 1 } }
@keyframes bounce-7 {
  0%   { transform: scale(1,1)   translateY(0);     opacity: 0 }
  10%  { transform: scale(1.1,.9) translateY(0);    opacity: 1 }
  30%  { transform: scale(.9,1.1) translateY(-100px) }
  50%  { transform: scale(1.05,.95) translateY(0) }
  57%  { transform: scale(1,1) translateY(-7px) }
  64%  { transform: scale(1,1) translateY(0) }
  100% { transform: scale(1,1) translateY(0);       opacity: 1 }
}
@keyframes beat { 0%{font-size:2em;fill:#000} 50%{font-size:4em;fill:red} 100%{font-size:2em;fill:#fff} }
@keyframes blinkGreen { from{fill:#89FF00} 50%{fill:#304701} to{fill:#ABFF00} }
```
Bounce base is `animation: bounce-7 1s 0s <count>` where `<count>` = the user's level (level 4 → `infinite`). Timing-function `cubic-bezier(0.280,0.840,0.420,1)`.

---

### Task 1: Hugo page + layout (mount node)

**Files:**
- Create: `hugo/content/devtoberfest/arcade/_index.md`
- Create: `hugo/layouts/devtoberfest/arcade.html`
- Test: manual (Hugo renders the page); island tests cover the mount contract in Task 3.

**Interfaces:**
- Produces: a page at `/devtoberfest/arcade/` with `<main id="arcade-mount" data-*>` + `<script src="/js/arcade.js">`, mirroring `hugo/layouts/devtoberfest/gameboard.html`.

- [ ] **Step 1: Create the Hugo content file**

`hugo/content/devtoberfest/arcade/_index.md`:

```markdown
---
title: "Devtoberfest Arcade"
description: "Play the Devtoberfest arcade — climb the levels as you complete activities."
layout: arcade
type: devtoberfest
---
```

- [ ] **Step 2: Create the layout with the mount node**

`hugo/layouts/devtoberfest/arcade.html` (mirror the gameboard layout's mount+noscript+script pattern):

```html
{{ define "main" }}
<main id="arcade-mount"
      data-api-my-gameboard="/gameboard/getMyGameboard"
      data-join-url="/devtoberfest/#join"
      data-img-base="/images/devtoberfest"
      data-demo-avatar="7"></main>
<noscript>
  <div class="ds-noscript-fallback">
    <h1>Devtoberfest Arcade</h1>
    <p>The arcade needs JavaScript. Enable it and refresh to play.</p>
  </div>
</noscript>
<script type="module" src="{{ "/js/arcade.js" | relURL }}"></script>
{{ end }}
```

- [ ] **Step 3: Verify Hugo builds the page**

Run: `npm run build:hugo` (or `hugo --source hugo`) and confirm `hugo/public/devtoberfest/arcade/index.html` is emitted with the mount node.
Expected: file exists, contains `id="arcade-mount"`.

- [ ] **Step 4: Commit**

```bash
git add hugo/content/devtoberfest/arcade/_index.md hugo/layouts/devtoberfest/arcade.html
git commit -m "feat(arcade): Hugo page + layout with island mount at /devtoberfest/arcade/"
```

---

### Task 2: Vite entry + island bootstrap + types + data fetch

**Files:**
- Modify: `hugo-apps/vite.config.ts` (add `arcade` entry at :240)
- Create: `hugo-apps/src/arcade/main.ts`, `hugo-apps/src/arcade/types.ts`, `hugo-apps/src/arcade/Arcade.vue`
- Test: `hugo-apps/src/arcade/__tests__/Arcade.test.ts`

**Interfaces:**
- Consumes: the mount node's `data-*` attrs (Task 1); `/gameboard/getMyGameboard`.
- Produces: `MountConfig` type, `MyGameboard` type; `Arcade.vue` that fetches getMyGameboard, exposes `{ state: 'player'|'demo', data }` to child scene components, fail-soft to demo on 401/error.

- [ ] **Step 1: Write the failing test**

`hugo-apps/src/arcade/__tests__/Arcade.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import Arcade from '../Arcade.vue'

const CFG = { apiMyGameboard: '/gameboard/getMyGameboard', joinUrl: '/devtoberfest/#join', imgBase: '/images/devtoberfest', demoAvatar: 7 }

describe('Arcade.vue', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('renders the player scene when getMyGameboard returns data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ userId: 'u1', score: 3500, level: 1, avatarIndex: 3, breakdown: [] }) }) as any
    const w = mount(Arcade, { props: { config: CFG } })
    await new Promise(r => setTimeout(r))
    expect(w.vm.state).toBe('player')
    expect(w.vm.board.level).toBe(1)
    expect(w.vm.board.avatarIndex).toBe(3)
  })

  it('falls to demo+CTA on 401 (anonymous)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as any
    const w = mount(Arcade, { props: { config: CFG } })
    await new Promise(r => setTimeout(r))
    expect(w.vm.state).toBe('demo')
    expect(w.html()).toContain('Join Devtoberfest')
  })

  it('falls to demo on network error (fail-soft, never throws)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as any
    const w = mount(Arcade, { props: { config: CFG } })
    await new Promise(r => setTimeout(r))
    expect(w.vm.state).toBe('demo')
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm --prefix hugo-apps run test -- src/arcade`
Expected: FAIL (module not found).

- [ ] **Step 3: Add the Vite entry**

In `hugo-apps/vite.config.ts`, add after the `gameboard:` line (:240):

```ts
        arcade: resolve(__dirname, 'src/arcade/main.ts'),
```

- [ ] **Step 4: Write `types.ts`**

```ts
export interface MountConfig {
  apiMyGameboard: string
  joinUrl: string
  imgBase: string
  demoAvatar: number
}
export interface MyGameboard {
  userId: string
  score: number
  level: number       // 0..4
  avatarIndex: number // 0..37
  breakdown: Array<{ week: string; trackId: string; earnedPoints: number; earnedCount: number; remainingPoints: number; remainingCount: number }>
}
```

- [ ] **Step 5: Write `Arcade.vue`** (orchestrator + fail-soft fetch; scene child added in Task 3)

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { MountConfig, MyGameboard } from './types'
const props = defineProps<{ config: MountConfig }>()
const state = ref<'player' | 'demo'>('demo')
const board = ref<MyGameboard>({ userId: '', score: 0, level: 0, avatarIndex: props.config.demoAvatar, breakdown: [] })
defineExpose({ state, board })
onMounted(async () => {
  try {
    const res = await fetch(props.config.apiMyGameboard, { headers: { accept: 'application/json' } })
    if (!res.ok) { state.value = 'demo'; return }        // 401 anonymous → demo
    const data = await res.json()
    board.value = data; state.value = 'player'
  } catch { state.value = 'demo' }                        // fail-soft
})
</script>
<template>
  <div class="arcade-root">
    <!-- Scene added in Task 3 -->
    <div v-if="state === 'demo'" class="arcade-cta">
      <a :href="config.joinUrl" class="arcade-cta-btn">Join Devtoberfest to play</a>
    </div>
  </div>
</template>
```

- [ ] **Step 6: Write `main.ts`** (reads mount node, mounts Vue)

```ts
import { createApp } from 'vue'
import Arcade from './Arcade.vue'
import type { MountConfig } from './types'
import './styles.css'
const el = document.getElementById('arcade-mount')
if (el) {
  const d = el.dataset
  const config: MountConfig = {
    apiMyGameboard: d.apiMyGameboard || '/gameboard/getMyGameboard',
    joinUrl: d.joinUrl || '/devtoberfest/#join',
    imgBase: d.imgBase || '/images/devtoberfest',
    demoAvatar: Number(d.demoAvatar ?? 7)
  }
  createApp(Arcade, { config }).mount(el)
}
```

(Create an empty `hugo-apps/src/arcade/styles.css` for now; filled in Task 4.)

- [ ] **Step 7: Run the test — verify it passes**

Run: `npm --prefix hugo-apps run test -- src/arcade`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/vite.config.ts hugo-apps/src/arcade/
git commit -m "feat(arcade): island bootstrap + getMyGameboard fetch with demo/player state (fail-soft)"
```

---

### Task 3: The scene — sprite layers + level→avatar mechanic

**Files:**
- Create: `hugo-apps/src/arcade/Scene.vue` (the composed board), `hugo-apps/src/arcade/scene-map.ts` (pure level→placement mapping)
- Modify: `hugo-apps/src/arcade/Arcade.vue` (mount `<Scene>`)
- Test: `hugo-apps/src/arcade/__tests__/scene-map.test.ts`, `__tests__/Scene.test.ts`

**Interfaces:**
- Consumes: `MyGameboard` + `MountConfig.imgBase`.
- Produces: `sceneMap(level)` → `{ cloud: number, bounceClass: string, hearts: number }`; `Scene.vue` rendering all sprite layers + the avatar placed per level.

- [ ] **Step 1: Write the failing pure-mapping test**

`__tests__/scene-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sceneMap, avatarFile } from '../scene-map'

describe('sceneMap — faithful level→placement', () => {
  it('level 0 → start cloud, avatar-1 bounce, 0 hearts', () => {
    expect(sceneMap(0)).toEqual({ cloud: 0, bounceClass: 'avatar-1', hearts: 0 })
  })
  it('levels 1..3 → matching cloud, hearts = level', () => {
    expect(sceneMap(1)).toEqual({ cloud: 1, bounceClass: 'avatar-1', hearts: 1 })
    expect(sceneMap(2)).toEqual({ cloud: 2, bounceClass: 'avatar-2', hearts: 2 })
    expect(sceneMap(3)).toEqual({ cloud: 3, bounceClass: 'avatar-3', hearts: 3 })
  })
  it('level 4 → nerdvana, infinite bounce', () => {
    expect(sceneMap(4)).toEqual({ cloud: 4, bounceClass: 'avatar-4', hearts: 0 })
  })
  it('clamps out-of-range level', () => {
    expect(sceneMap(9).cloud).toBe(4)
    expect(sceneMap(-1).cloud).toBe(0)
  })
  it('avatarFile maps + clamps index to Group-<n>.png', () => {
    expect(avatarFile('/images/devtoberfest', 3)).toBe('/images/devtoberfest/avatars/Group-3.png')
    expect(avatarFile('/images/devtoberfest', 99)).toBe('/images/devtoberfest/avatars/Group-37.png')
    expect(avatarFile('/images/devtoberfest', -5)).toBe('/images/devtoberfest/avatars/Group-0.png')
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm --prefix hugo-apps run test -- src/arcade/__tests__/scene-map`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `scene-map.ts`** (pure)

```ts
// Faithful legacy level→placement mapping (srv/routes/devtoberfest.js buildAvatar).
// bounceClass maps to a CSS class that sets bounce-7 iteration = level (avatar-4 = infinite).
export function sceneMap(level: number): { cloud: number; bounceClass: string; hearts: number } {
  const lvl = Math.min(4, Math.max(0, Math.floor(level || 0)))
  const bounceClass = ['avatar-1', 'avatar-1', 'avatar-2', 'avatar-3', 'avatar-4'][lvl]
  const hearts = lvl === 4 ? 0 : lvl   // level 4 shows the server lights, not hearts
  return { cloud: lvl, bounceClass, hearts }
}
export function avatarFile(imgBase: string, avatarIndex: number): string {
  const idx = Math.min(37, Math.max(0, Math.floor(avatarIndex || 0)))
  return `${imgBase}/avatars/Group-${idx}.png`
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm --prefix hugo-apps run test -- src/arcade/__tests__/scene-map`
Expected: PASS.

- [ ] **Step 5: Write `Scene.vue`** (sprite layers + avatar placement)

Render the composed board: CRT frame + bezel, title, main progress area, the 4 level clouds (with per-cloud position classes), ambient sprites (lobster/alien/runner/cloud as `<img>` with the animated GIFs, drift classes), SAP + Devtoberfest logos, the points/level banner (`POINTS: {{score}} LEVEL: {{level}}`), the two text columns, blinking LED, stars, and the avatar:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { MyGameboard, MountConfig } from './types'
import { sceneMap, avatarFile } from './scene-map'
const props = defineProps<{ board: MyGameboard; config: MountConfig; demo: boolean }>()
const place = computed(() => sceneMap(props.board.level))
const avatar = computed(() => avatarFile(props.config.imgBase, props.board.avatarIndex))
const img = (p: string) => `${props.config.imgBase}/${p}`
</script>
<template>
  <div class="scene" :style="{ '--img-base': `url(${config.imgBase})` }">
    <img class="s-frame"  :src="img('arcade/BackgroundOKG.png')" alt="" />
    <img class="s-title"  :src="img('arcade/Group_13.png')" alt="Devtoberfest Gameboard" />
    <img class="s-sky"    :src="img('arcade/clouds/Group_12a.png')" alt="" />
    <!-- 4 level clouds -->
    <div v-for="n in 4" :key="n" class="s-cloud" :class="`cloud-${n}`"></div>
    <!-- ambient sprites (animated GIFs) -->
    <img class="s-lobster drift-x" :src="img('arcade/clouds/Group8.png')" alt="" />
    <img class="s-alien   drift-y" :src="img('arcade/clouds/Group10.png')" alt="" />
    <img class="s-runner"          :src="img('arcade/clouds/Runner.gif')" alt="" />
    <!-- HUD -->
    <div class="s-banner">POINTS: {{ board.score }} LEVEL: {{ board.level }}</div>
    <!-- the player avatar on its level cloud -->
    <img class="s-avatar" :class="[`cloud-${place.cloud}`, place.bounceClass]" :src="avatar" :alt="`Your avatar, level ${board.level}`" />
    <span v-for="h in place.hearts" :key="h" class="s-heart heart">♥</span>
    <div class="s-led led-green"></div>
  </div>
</template>
```

- [ ] **Step 6: Write `Scene.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Scene from '../Scene.vue'
const CFG = { apiMyGameboard: '', joinUrl: '', imgBase: '/images/devtoberfest', demoAvatar: 7 }
const board = (level: number, avatarIndex = 3) => ({ userId: 'u', score: 3500, level, avatarIndex, breakdown: [] })

describe('Scene.vue', () => {
  it('places the avatar on the cloud + bounce class matching level, with N hearts', () => {
    const w = mount(Scene, { props: { board: board(2), config: CFG, demo: false } })
    const av = w.find('.s-avatar')
    expect(av.classes()).to.include.members(['cloud-2', 'avatar-2'])
    expect(av.attributes('src')).toBe('/images/devtoberfest/avatars/Group-3.png')
    expect(w.findAll('.s-heart')).toHaveLength(2)
  })
  it('shows the live score/level banner', () => {
    const w = mount(Scene, { props: { board: board(1), config: CFG, demo: false } })
    expect(w.find('.s-banner').text()).toContain('POINTS: 3500 LEVEL: 1')
  })
  it('renders the core sprite layers', () => {
    const w = mount(Scene, { props: { board: board(0), config: CFG, demo: false } })
    for (const cls of ['.s-frame', '.s-sky', '.s-lobster', '.s-runner', '.s-avatar']) {
      expect(w.find(cls).exists()).toBe(true)
    }
  })
})
```

Note: `Scene.test.ts` uses `chai`-style `.to.include` via vitest's `expect` — if the hugo-apps vitest config is jest-style only, use `expect(av.classes()).toEqual(expect.arrayContaining(['cloud-2','avatar-2']))` instead. Match the repo's existing island test style (check `hugo-apps/src/gameboard/__tests__`).

- [ ] **Step 7: Mount `<Scene>` in `Arcade.vue`**

Add to `Arcade.vue`'s template (above the CTA), passing demo state:

```vue
    <Scene :board="board" :config="config" :demo="state === 'demo'" />
```
and `import Scene from './Scene.vue'`.

- [ ] **Step 8: Run the tests**

Run: `npm --prefix hugo-apps run test -- src/arcade`
Expected: PASS (all arcade tests).

- [ ] **Step 9: Commit**

```bash
git add hugo-apps/src/arcade/
git commit -m "feat(arcade): sprite-layer scene + faithful level→avatar-cloud/bounce/hearts mechanic"
```

---

### Task 4: Styles — layout, ported keyframes, reduced-motion, cloud positions

**Files:**
- Modify: `hugo-apps/src/arcade/styles.css`
- Test: `hugo-apps/src/arcade/__tests__/reduced-motion.test.ts` (asserts the media-query rule exists in the stylesheet source)

**Interfaces:**
- Produces: the arcade CSS — responsive scaled canvas, absolute sprite positions, per-level `.cloud-N` coordinates, `.avatar-N` bounce-count classes, ported `bounce-7`/`beat`/`blinkGreen`/`fadeInAnimation` keyframes, drift animations, and a `prefers-reduced-motion` block disabling all animation.

- [ ] **Step 1: Write the reduced-motion guard test**

`__tests__/reduced-motion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8')

describe('arcade styles', () => {
  it('gates animation behind prefers-reduced-motion: reduce', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    // the reduced-motion block must neutralize animation
    const block = css.slice(css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/))
    expect(block).toMatch(/animation:\s*none/)
  })
  it('defines the ported keyframes', () => {
    for (const kf of ['bounce-7', 'beat', 'blinkGreen', 'fadeInAnimation']) {
      expect(css).toContain(`@keyframes ${kf}`)
    }
  })
  it('sets per-level avatar bounce iteration counts (avatar-4 infinite)', () => {
    expect(css).toMatch(/\.avatar-1\s*\{[^}]*animation[^}]*bounce-7[^}]*\b1\b/)
    expect(css).toMatch(/\.avatar-4\s*\{[^}]*bounce-7[^}]*infinite/)
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm --prefix hugo-apps run test -- src/arcade/__tests__/reduced-motion`
Expected: FAIL (styles.css empty).

- [ ] **Step 3: Write `styles.css`**

Include: a `.arcade-root` responsive wrapper that scales a `.scene` sized to the legacy 1347×1612 aspect (e.g. `aspect-ratio: 1347/1612; container-based scaling`); absolute-positioned `.s-*` layers; `.cloud-0..4` position classes (from the legacy per-level coordinates, expressed as %); the ported keyframes verbatim (see Global Constraints block); `.avatar-1..4` classes binding `animation: bounce-7 1s 0s <count>` with counts 1,2,3,`infinite` (avatar-1 used for levels 0 and 1 per the legacy); `.heart{animation:beat 1s 0s infinite}`; `.led-green{animation:blinkGreen .5s infinite}`; `.drift-x`/`.drift-y` transform drifts (replacing the legacy inline SVG `<animate>`); `@font-face` for Joystix Monospace from `/images/devtoberfest/arcade/fonts/joystix_monospace.ttf`; and:

```css
@media (prefers-reduced-motion: reduce) {
  .arcade-root *,
  .s-avatar, .s-lobster, .s-alien, .s-heart, .s-led, .drift-x, .drift-y {
    animation: none !important;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix hugo-apps run test -- src/arcade/__tests__/reduced-motion`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/arcade/styles.css hugo-apps/src/arcade/__tests__/reduced-motion.test.ts
git commit -m "feat(arcade): scene styles — ported keyframes, per-level bounce, reduced-motion guard"
```

---

### Task 5: Audio toggle (muted by default)

**Files:**
- Create: `hugo-apps/src/arcade/useSound.ts`, `hugo-apps/src/arcade/SoundToggle.vue`
- Modify: `hugo-apps/src/arcade/Scene.vue` (add `<SoundToggle>`)
- Test: `hugo-apps/src/arcade/__tests__/useSound.test.ts`

**Interfaces:**
- Produces: `useSound(src)` → `{ enabled, toggle() }`; audio never autoplays; starts muted; toggle plays/pauses.

- [ ] **Step 1: Write the failing test**

`__tests__/useSound.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { useSound } from '../useSound'

describe('useSound', () => {
  it('starts muted / not playing (no autoplay)', () => {
    const { enabled } = useSound('/x.mp3')
    expect(enabled.value).toBe(false)
  })
  it('toggle() flips enabled and calls play/pause', () => {
    const play = vi.fn().mockResolvedValue(undefined)
    const pause = vi.fn()
    const audio = { play, pause, loop: false, muted: true } as any
    const { enabled, toggle } = useSound('/x.mp3', () => audio)
    toggle(); expect(enabled.value).toBe(true); expect(play).toHaveBeenCalled()
    toggle(); expect(enabled.value).toBe(false); expect(pause).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm --prefix hugo-apps run test -- src/arcade/__tests__/useSound`
Expected: FAIL.

- [ ] **Step 3: Write `useSound.ts`**

```ts
import { ref } from 'vue'
// Audio starts MUTED with no autoplay (browser policy + a11y). The user opts in.
export function useSound(src: string, factory: () => HTMLAudioElement = () => new Audio(src)) {
  const enabled = ref(false)
  let audio: HTMLAudioElement | null = null
  function toggle() {
    if (!audio) { audio = factory(); audio.loop = true }
    if (enabled.value) { audio.pause(); enabled.value = false }
    else { audio.muted = false; void audio.play(); enabled.value = true }
  }
  return { enabled, toggle }
}
```

- [ ] **Step 4: Write `SoundToggle.vue`** and add it to `Scene.vue`

```vue
<script setup lang="ts">
import { useSound } from './useSound'
const props = defineProps<{ imgBase: string }>()
const { enabled, toggle } = useSound(`${props.imgBase}/music/8bit.mp3`)
</script>
<template>
  <button class="s-sound" :aria-pressed="enabled" @click="toggle"
          :title="enabled ? 'Mute 8-bit music' : 'Play 8-bit music'">
    <img :src="`${imgBase}/arcade/menu/sound.png`" alt="" /> {{ enabled ? 'ON' : 'OFF' }}
  </button>
</template>
```
Add `<SoundToggle :img-base="config.imgBase" />` to `Scene.vue` and import it.

- [ ] **Step 5: Run the test**

Run: `npm --prefix hugo-apps run test -- src/arcade/__tests__/useSound`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/arcade/
git commit -m "feat(arcade): 8-bit audio toggle, muted-by-default (no autoplay)"
```

---

### Task 6: Carry + optimize assets

**Files:**
- Create: `hugo/static/images/devtoberfest/arcade/**` (referenced sprites, optimized)
- Create/modify: `hugo/static/images/devtoberfest/arcade/fonts/joystix_monospace.ttf`, `hugo/static/images/devtoberfest/music/8bit.mp3`
- Reuse (do NOT copy): `hugo/static/images/devtoberfest/avatars/Group-0..37.png` (already committed for the leaderboard)

**Interfaces:**
- Produces: every `img()`/`avatarFile()`/font/audio path the scene references, resolvable under `/images/devtoberfest/`.

- [ ] **Step 1: Copy the referenced sprites from legacy**

Copy ONLY the referenced files from `D:/projects/sap-community-activity-badges/srv/images/devtoberfest/` into `hugo/static/images/devtoberfest/arcade/`, preserving the `clouds/`, `levels/`, `menu/`, `fonts/` substructure:
`BackgroundOKG.png, okBottom.png, Group_13.png, image1.png, image3.png, image6.png, sap.svg, devtoberfest_square_small.gif, clouds/{Group_12a,Group8,Group10,Frame}.png, clouds/Runner.gif, levels/{Group4,Group5,Group6,Group11,Frame}.png, menu/{Frame,Frame-1,Frame-2,sound}.png, fonts/joystix_monospace.ttf`.
And `music/8bit.mp3` → `hugo/static/images/devtoberfest/music/8bit.mp3`.
Do NOT copy `*Old*`, promo, `Originals/`, or the unused root PNGs.

- [ ] **Step 2: Optimize the heavy PNGs**

Run an image optimizer (e.g. `sharp`/`pngquant`) over the copied PNGs, targeting the multi-MB offenders (`BackgroundOKG.png` ~2MB, `clouds/Group8/Group10` ~1.6MB, `levels/Frame` ~1.8MB, `devtoberfest_square_small.gif` ~4.6MB → consider a smaller re-export). Also optimize the existing `avatars/Group-20..37.png` (0.7–1.6MB each) in place. Confirm the arcade image dir total is reasonable (target < ~6MB, gif excepted).

- [ ] **Step 3: Verify all referenced paths exist**

Run a check that every path referenced in `Scene.vue`/`scene-map.ts`/`SoundToggle.vue`/`styles.css` resolves to a file under `hugo/static/images/devtoberfest/`:

```bash
# list referenced paths and assert each exists
grep -rhoE "arcade/[A-Za-z0-9_./-]+\.(png|gif|svg|ttf)|avatars/Group-|music/8bit.mp3" hugo-apps/src/arcade | sort -u
ls hugo/static/images/devtoberfest/arcade/BackgroundOKG.png hugo/static/images/devtoberfest/music/8bit.mp3 hugo/static/images/devtoberfest/avatars/Group-0.png
```
Expected: all referenced files present.

- [ ] **Step 4: Commit**

```bash
git add hugo/static/images/devtoberfest/arcade/ hugo/static/images/devtoberfest/music/
git commit -m "feat(arcade): carry + optimize referenced legacy sprites/font/audio (reuse existing avatars)"
```

---

### Task 7: Build, e2e spec, deploy verification

**Files:**
- Create: `test/e2e/arcade.spec.ts` (or `.test.js` matching the repo's e2e convention)
- Test: island build + e2e

**Interfaces:**
- Consumes: everything above.
- Produces: a committed, self-skipping e2e spec; a verified island build.

- [ ] **Step 1: Build the island**

Run: `npm --prefix hugo-apps run build` and confirm `hugo/static/js/arcade.js` is emitted with no budget errors.
Expected: `arcade.js` present.

- [ ] **Step 2: Run the full arcade unit suite**

Run: `npm --prefix hugo-apps run test -- src/arcade`
Expected: all arcade tests pass (Arcade, Scene, scene-map, reduced-motion, useSound).

- [ ] **Step 3: Write the committed e2e spec** (mirror `test/e2e/gameboard.test.js` self-skip pattern)

`test/e2e/arcade.test.js`:

```js
import { test, expect } from '@playwright/test'
const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL
test.describe(BASE ? 'arcade' : 'arcade (skipped — no base url)', () => {
  test.skip(!BASE, 'no PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL')
  test('anonymous sees the animated demo board + join CTA', async ({ page }) => {
    await page.goto(`${BASE}/devtoberfest/arcade/`)
    await expect(page.locator('.scene .s-frame')).toBeVisible()      // CRT cabinet
    await expect(page.locator('.s-avatar')).toBeVisible()            // a demo avatar
    await expect(page.getByText('Join Devtoberfest')).toBeVisible()  // register CTA
  })
})
```

- [ ] **Step 4: Commit**

```bash
git add test/e2e/arcade.test.js
git commit -m "test(arcade): committed self-skipping e2e for the animated board + CTA"
```

- [ ] **Step 5: Deploy + verify (post-merge)**

Deploy tutorials-ims to DEV (`npm run deploy -- --env dev`, from the primary tree on main after merge). Then **verification-before-done**: open `https://<approuter>/devtoberfest/arcade/` in a browser and confirm the animated scene renders in the anonymous demo state (cabinet + demo avatar + sprites animating + "Join Devtoberfest" CTA). Confirm `prefers-reduced-motion` (via devtools emulation) stops the animation.

---

## Self-Review

**Spec coverage:**
- Separate app at `/devtoberfest/arcade/`, leaderboard untouched → Task 1. ✅
- Vue island + CSS/sprite animation → Tasks 2–4. ✅
- Faithful level→avatar-cloud/bounce/hearts mechanic → Task 3 (`scene-map` + `Scene.vue`), Task 4 (`.avatar-N` counts). ✅
- Driven by `getMyGameboard`, no scnId → Task 2. ✅
- Anonymous → animated demo + register CTA; fail-soft → Task 2 (state logic) + Task 3 (scene renders in demo). ✅
- Audio muted-by-default + toggle → Task 5. ✅
- `prefers-reduced-motion` → Task 4 (guard + test). ✅
- Referenced assets only, optimized, reuse existing avatars → Task 6. ✅
- Testing (unit + committed e2e + browser verification) → Tasks 2–7. ✅

**Placeholder scan:** No TBDs. The one conditional is Task 3 Step 6's note to match the repo's island test assertion style (chai vs jest) — resolved by checking `hugo-apps/src/gameboard/__tests__`, not a gap. Legacy per-level coordinates are referenced as "from the legacy, expressed as %" in Task 4 — the implementer reads the exact values from `srv/routes/devtoberfest.js buildAvatar` (recon gave the table in the design doc §6); acceptable since the placement is visual-tuning, not a correctness contract.

**Type consistency:** `MountConfig`/`MyGameboard` fields are consistent across `types.ts`, `main.ts`, `Arcade.vue`, `Scene.vue`, and tests. `sceneMap`/`avatarFile` signatures match between `scene-map.ts` and both test + `Scene.vue` usage. Asset paths in Task 6 match the `img()`/`avatarFile()` calls in Task 3.

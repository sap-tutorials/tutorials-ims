# Selfie Generative Background + Cartoonify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two client-side "generative" capabilities to the Devtoberfest selfie composer — a themed background swap (curated vector scenes behind the cut-out person) and a cartoonify style-transfer effect (AnimeGANv2 ONNX run in-browser) — baked into the exported PNG, with nothing ever leaving the browser.

**Architecture:** Two independent, bounded units reusing existing seams. The themed background is a new bottom-most Konva layer (`bgLayer`) added in `buildStage`, driven by a `setBackground` stage method and a `BackgroundPicker.vue` mirroring the sticker/effect pickers. Cartoonify is a new async effect: `EffectId` gains `'cartoon'`, a new `applyEffectAsync` awaits an ONNX pass for cartoon and delegates all six existing CSS presets to the unchanged synchronous `applyEffect`; `exportPng` awaits `applyEffectAsync` so the bake order (effect before border) is preserved. Both fail soft to the un-modified composite.

**Tech Stack:** Vue 3 SFCs (`<script setup lang="ts">`), Konva 9, `onnxruntime-web` (new hugo-apps dep, lazy-imported), `sharp` (build-time SVG→PNG), Vitest v4 + happy-dom + `@vue/test-utils`.

## Global Constraints

- **Client-side only** — no network egress at runtime; hosted-inference cost ceiling is $0.
- **Fail-soft everywhere** — no failure path (bad image, model load fail, no execution provider, inference throw) crashes the island or blocks export; it degrades to the un-modified composite.
- **Self-host all assets** — no CDN references; served same-origin under `/vendor/` and `/images/devtoberfest/selfie/`. CSP-clean (reuses the imgly `'wasm-unsafe-eval'` + `'unsafe-eval'` posture from #1546).
- **Lazy-load** `onnxruntime-web` and the AnimeGAN model via dynamic `import()` — never on page load (imgly's `segment.ts` is the precedent).
- **Devtoberfest palette** for all generated background art: orange `#e8791a`, dark brown `#2b1a0f`, stem green `#3d7a3a`, white `#ffffff`, SAP blue `#1c3c6e`.
- **Konva stage never mutated by effects** — effects bake on the exported canvas only. The themed background IS a real stage layer (that is the feature).
- **License gate** — the AnimeGAN model binary is committed only after its permissive license (MIT/Apache/CC-family) is verified and the source URL + license recorded in the vendor script header.
- **Run selfie unit tests from the repo root:** `npm test -- --project unit hugo-apps/src/selfie` (or a single file appended). `vite build` (in `hugo-apps/`) must stay clean.

---

## File Structure

**New files:**
- `hugo-apps/src/selfie/backgrounds.ts` — themed-scene definition list + URL builder (mirrors `stickers.ts`).
- `hugo-apps/src/selfie/BackgroundPicker.vue` — scene picker component (mirrors `EffectPicker.vue`).
- `hugo-apps/src/selfie/stylize.ts` — `cartoonify(canvas)`: lazy ONNX inference, fail-soft.
- `scripts/gen-backgrounds.mjs` — hand-authored SVG → PNG scenes via sharp (mirrors `scripts/gen-stickers.mjs`).
- `scripts/vendor-animegan.mjs` — self-hosts the AnimeGAN ONNX model (mirrors `scripts/vendor-imgly.cjs`).
- `hugo/static/images/devtoberfest/selfie/backgrounds/*.png` — generated scene art (build output committed).
- Test files: `backgrounds.test.ts`, `BackgroundPicker.test.ts`, `stylize.test.ts`.

**Modified files:**
- `hugo-apps/src/selfie/effects.ts` — add `'cartoon'` to `EffectId`/`EFFECT_IDS`, a `cartoon` table entry (sync `apply` returns input; async bake lives in `applyEffectAsync`), and `applyEffectAsync`.
- `hugo-apps/src/selfie/compose.ts` — add `bgLayer` + `setBackground` to `buildStage`/`SelfieStage`; `exportPng` awaits `applyEffectAsync`.
- `hugo-apps/src/selfie/Composer.vue` — wire `BackgroundPicker` (forces `removeBg` on), cartoon-inference spinner, failure note.
- `hugo-apps/src/selfie/__tests__/effects.test.ts` — update the `EFFECT_IDS` exact-match + per-entry assertions for the new `cartoon` id; add `applyEffectAsync` coverage.
- `hugo-apps/src/selfie/__tests__/compose.test.ts` — `setBackground` layer wiring + export awaits async path.
- `hugo-apps/src/selfie/__tests__/Composer.test.ts` — background picker wiring + cartoon forwarding + failure note.
- `hugo-apps/package.json` — add `onnxruntime-web` dependency + `vendor:animegan` script; chain it into `setup`/`vendor` alongside `vendor:imgly`.

---

## Task 1: Themed background definitions module

**Files:**
- Create: `hugo-apps/src/selfie/backgrounds.ts`
- Test: `hugo-apps/src/selfie/__tests__/backgrounds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface BackgroundDef { id: string; label: string; file: string }`
  - `const BACKGROUNDS: BackgroundDef[]` — the five themed scenes, no `none` entry.
  - `const BACKGROUND_IDS: string[]` — `['none', ...BACKGROUNDS.map(b => b.id)]`, `'none'` first.
  - `function backgroundUrl(imgBase: string, file: string): string` → `` `${imgBase}/backgrounds/${file}.png` ``

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/selfie/__tests__/backgrounds.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BACKGROUNDS, BACKGROUND_IDS, backgroundUrl, type BackgroundDef } from '../backgrounds'

describe('backgrounds module', () => {
  it('lists none first in the picker order, then every scene', () => {
    expect(BACKGROUND_IDS[0]).toBe('none')
    expect(BACKGROUND_IDS.slice(1)).toEqual(BACKGROUNDS.map((b) => b.id))
  })

  it('every scene has a non-empty id, label and file', () => {
    for (const b of BACKGROUNDS as BackgroundDef[]) {
      expect(b.id).toBeTruthy()
      expect(b.label).toBeTruthy()
      expect(b.file).toBeTruthy()
    }
  })

  it('ships the five themed scenes', () => {
    expect(BACKGROUNDS.map((b) => b.id)).toEqual([
      'pumpkin-patch', 'teched-stage', 'terminal', 'autumn-gradient', 'starfield',
    ])
  })

  it('builds a per-scene PNG url under the backgrounds/ folder', () => {
    expect(backgroundUrl('/images/devtoberfest/selfie', 'pumpkin-patch'))
      .toBe('/images/devtoberfest/selfie/backgrounds/pumpkin-patch.png')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/backgrounds.test.ts`
Expected: FAIL — cannot resolve `../backgrounds`.

- [ ] **Step 3: Write minimal implementation**

Create `hugo-apps/src/selfie/backgrounds.ts`:

```ts
// Themed background scenes for the Devtoberfest selfie composer (#1520).
// "Generative" background = curated vector art (generated by scripts/gen-backgrounds.mjs),
// composited behind the cut-out person on a dedicated bottom-most Konva layer.
// The person cutout comes from the existing imgly segmentation (Tier 1 #1514).

export interface BackgroundDef {
  id: string
  label: string
  file: string // basename under `${imgBase}/backgrounds/`; URL is `${imgBase}/backgrounds/${file}.png`
}

export const BACKGROUNDS: BackgroundDef[] = [
  { id: 'pumpkin-patch',   label: 'Pumpkin patch', file: 'pumpkin-patch' },
  { id: 'teched-stage',    label: 'On stage',      file: 'teched-stage' },
  { id: 'terminal',        label: 'Terminal',      file: 'terminal' },
  { id: 'autumn-gradient', label: 'Autumn',        file: 'autumn-gradient' },
  { id: 'starfield',       label: 'Starfield',     file: 'starfield' },
]

// Picker order — 'none' (no themed background) first, then each scene.
export const BACKGROUND_IDS: string[] = ['none', ...BACKGROUNDS.map((b) => b.id)]

export function backgroundUrl(imgBase: string, file: string): string {
  return `${imgBase}/backgrounds/${file}.png`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/backgrounds.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/backgrounds.ts hugo-apps/src/selfie/__tests__/backgrounds.test.ts
git commit -m "feat(#1520): themed background definitions module"
```

---

## Task 2: Generate the themed background art

**Files:**
- Create: `scripts/gen-backgrounds.mjs`
- Create (build output, committed): `hugo/static/images/devtoberfest/selfie/backgrounds/{pumpkin-patch,teched-stage,terminal,autumn-gradient,starfield}.png`

**Interfaces:**
- Consumes: the five `file` basenames from Task 1's `BACKGROUNDS`.
- Produces: five 1080×1080 opaque PNG scenes (matches `STAGE_WIDTH`/`STAGE_HEIGHT` in `constants.ts`).

This task has no unit test — it is an asset-generation script. Its "test" is that the script runs, emits five non-trivial PNGs, and `backgrounds.test.ts` (Task 1) already asserts the filenames the picker will request. Follow the exact structure of the existing `scripts/gen-stickers.mjs` (sharp resolved from cwd via `createRequire`, SVG string → `sharp(buf,{density}).resize(...).png().toFile(...)`).

- [ ] **Step 1: Write the generator script**

Create `scripts/gen-backgrounds.mjs`:

```js
// Generates five Devtoberfest-themed selfie background scenes (1080x1080, opaque)
// via hand-authored SVG + sharp rasterization. Mirrors scripts/gen-stickers.mjs.
// Run from the repo root:  node scripts/gen-backgrounds.mjs

import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
const require = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')).href)
const sharp = require('./node_modules/sharp/dist/index.cjs')
import path from 'path'

const OUT = './hugo/static/images/devtoberfest/selfie/backgrounds'
const S = 1080

// Devtoberfest palette
const OG = '#e8791a'   // orange
const DK = '#2b1a0f'   // dark brown
const GN = '#3d7a3a'   // stem green
const WH = '#ffffff'
const BL = '#1c3c6e'   // SAP blue

function wrap(content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">${content}</svg>`
}

// A simple round pumpkin at (cx,cy) radius r.
function pumpkin(cx, cy, r) {
  return `
    <ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.9}" fill="${OG}"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${r * 0.62}" ry="${r * 0.9}" fill="none" stroke="${DK}" stroke-width="3" opacity="0.4"/>
    <rect x="${cx - r * 0.08}" y="${cy - r * 1.1}" width="${r * 0.16}" height="${r * 0.28}" rx="6" fill="${GN}"/>`
}

const SVGS = {
  // Pumpkin patch: warm sky gradient, ground band, scattered pumpkins along the base.
  'pumpkin-patch': wrap(`
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd9a0"/><stop offset="1" stop-color="${OG}"/>
    </linearGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <rect y="${S * 0.72}" width="${S}" height="${S * 0.28}" fill="${GN}"/>
    <rect y="${S * 0.72}" width="${S}" height="${S * 0.28}" fill="${DK}" opacity="0.15"/>
    ${pumpkin(150, S * 0.8, 90)}
    ${pumpkin(320, S * 0.86, 70)}
    ${pumpkin(S - 180, S * 0.82, 100)}
    ${pumpkin(S - 360, S * 0.88, 62)}`),

  // On stage: dark auditorium, spotlight cone, a bright stage floor + accent bar.
  'teched-stage': wrap(`
    <defs><radialGradient id="spot" cx="0.5" cy="0.1" r="0.9">
      <stop offset="0" stop-color="#3a4a63"/><stop offset="1" stop-color="#0b1220"/>
    </radialGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#spot)"/>
    <polygon points="${S / 2},60 ${S * 0.22},${S * 0.78} ${S * 0.78},${S * 0.78}" fill="${WH}" opacity="0.08"/>
    <rect y="${S * 0.78}" width="${S}" height="${S * 0.22}" fill="#12203a"/>
    <rect y="${S * 0.78}" width="${S}" height="14" fill="${OG}"/>`),

  // Terminal: dark editor backdrop, prompt lines, a blinking-cursor block.
  terminal: wrap(`
    <rect width="${S}" height="${S}" fill="#0d1117"/>
    <rect x="0" y="0" width="${S}" height="70" fill="#161b22"/>
    <circle cx="40" cy="35" r="12" fill="#ff5f56"/><circle cx="76" cy="35" r="12" fill="#ffbd2e"/><circle cx="112" cy="35" r="12" fill="#27c93f"/>
    ${[0, 1, 2, 3, 4, 5].map((i) => `
      <text x="50" y="${170 + i * 90}" font-family="monospace" font-size="42" fill="${i % 2 ? '#8b949e' : GN}">$ ${i % 2 ? 'npm run build:all' : 'devtoberfest --join'}</text>`).join('')}
    <rect x="50" y="${170 + 6 * 90 - 34}" width="26" height="42" fill="${OG}"/>`),

  // Autumn: soft diagonal warm gradient with falling leaf marks.
  'autumn-gradient': wrap(`
    <defs><linearGradient id="au" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffcf8f"/><stop offset="0.5" stop-color="${OG}"/><stop offset="1" stop-color="#a8431a"/>
    </linearGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#au)"/>
    ${[[180, 200], [900, 300], [500, 700], [820, 820], [260, 880], [640, 140]].map(([x, y]) => `
      <ellipse cx="${x}" cy="${y}" rx="34" ry="16" fill="${DK}" opacity="0.18" transform="rotate(35 ${x} ${y})"/>`).join('')}`),

  // Starfield: night sky, scattered stars, one large accent star.
  starfield: wrap(`
    <defs><radialGradient id="ng" cx="0.5" cy="0.4" r="0.8">
      <stop offset="0" stop-color="#1c2c52"/><stop offset="1" stop-color="#05070f"/>
    </radialGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#ng)"/>
    ${Array.from({ length: 60 }, (_, i) => {
      const x = (i * 137) % S, y = (i * 251) % S, r = 1 + (i % 3)
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${WH}" opacity="${0.4 + (i % 4) * 0.15}"/>`
    }).join('')}
    <circle cx="${S - 220}" cy="220" r="60" fill="${OG}" opacity="0.9"/>
    <circle cx="${S - 220}" cy="220" r="60" fill="none" stroke="${WH}" stroke-width="4" opacity="0.4"/>`),
}

for (const [name, svg] of Object.entries(SVGS)) {
  const outPath = path.join(OUT, `${name}.png`)
  await sharp(Buffer.from(svg), { density: 144 })
    .resize(S, S, { fit: 'cover' })
    .png()
    .toFile(outPath)
  console.log(`✓ ${name}.png`)
}
console.log('All 5 backgrounds generated.')
```

- [ ] **Step 2: Create the output directory and run the generator**

Run (from the repo root):
```bash
mkdir -p hugo/static/images/devtoberfest/selfie/backgrounds
node scripts/gen-backgrounds.mjs
```
Expected: prints `✓ pumpkin-patch.png` … `✓ starfield.png` then `All 5 backgrounds generated.`

- [ ] **Step 3: Verify the PNGs are real (not degenerate stubs)**

Run:
```bash
ls -l hugo/static/images/devtoberfest/selfie/backgrounds/
```
Expected: five files, each well over 1 KB (guards against the 1×1-stub class of bug seen in #1517). If any file is under ~1 KB, the SVG produced an empty raster — fix the SVG before committing.

- [ ] **Step 4: Commit**

```bash
git add scripts/gen-backgrounds.mjs hugo/static/images/devtoberfest/selfie/backgrounds/
git commit -m "feat(#1520): generate themed selfie background scenes"
```

---

## Task 3: `setBackground` stage method + bottom-most bgLayer

**Files:**
- Modify: `hugo-apps/src/selfie/compose.ts` (add to `SelfieStage` interface ~line 7-28; add `bgLayer` in `buildStage` ~line 68-94; add `setBackground` to the returned object ~line 99-182)
- Test: `hugo-apps/src/selfie/__tests__/compose.test.ts`

**Interfaces:**
- Consumes: `Konva` (already imported), `stageW`/`stageH` (already computed in `buildStage`).
- Produces: `setBackground(img: HTMLImageElement | null): void` on `SelfieStage`. `img` → adds/replaces a stage-filling `Konva.Image` on a dedicated bottom-most layer; `null` → clears it.

- [ ] **Step 1: Read the existing compose.test.ts Konva mock**

Read `hugo-apps/src/selfie/__tests__/compose.test.ts` in full to reuse its Konva mock shape (it mocks `konva` with `Stage`/`Layer`/`Image`/`Transformer` constructors). The new test must extend that same mock, not invent a parallel one.

- [ ] **Step 2: Write the failing test**

Add to `hugo-apps/src/selfie/__tests__/compose.test.ts` a `describe('setBackground')` block. It must assert, using the file's existing Konva mock (extend the mock so `Layer` instances record `add` calls and the `Stage` records layer insertion order):

```ts
describe('setBackground', () => {
  it('adds a background layer to the stage BEFORE the cutout layer (bottom-most)', async () => {
    // buildStage(...) resolves a stage; the mock Stage records .add(layer) order.
    // Assert the first layer added to the stage is the bg layer (added before cutoutLayer).
    // (Use the mock's recorded add-order array; the bg layer is index 0.)
  })

  it('setBackground(img) adds one Konva.Image sized to the full stage, listening(false)', async () => {
    // After stage.setBackground(fakeImg): the bg layer received an Image node with
    // x:0,y:0,width:stageW,height:stageH and listening(false) was called on it.
  })

  it('setBackground(img) called twice replaces the node, not stacks it', async () => {
    // Second call destroys/removes the first node; bg layer holds exactly one image node.
  })

  it('setBackground(null) clears the background node', async () => {
    // After setBackground(img) then setBackground(null): bg layer holds no image node.
  })
})
```

Fill in the assertion bodies against the concrete mock in the file (follow the existing tests' style of reading recorded constructor args / spy calls).

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: FAIL — `setBackground` is not a function / bg layer not added.

- [ ] **Step 4: Implement in compose.ts**

Add to the `SelfieStage` interface (after `setImage`, before `exportPng`):

```ts
  /**
   * Set (or clear) the themed background scene drawn on the bottom-most layer,
   * behind the cut-out person. Pass null to remove it. The node fills the stage
   * and is non-interactive. #1520.
   */
  setBackground(img: HTMLImageElement | null): void
```

In `buildStage`, create the bg layer and add it to the stage FIRST (bottom-most) — insert immediately after `const stage = new Konva.Stage(...)` and before the frame/cutout layer-order block:

```ts
  // Themed background scene (#1520) — bottom-most, behind everything. Added first
  // so it renders under the frame, cutout and overlays regardless of FRAME_LAYERING.
  const bgLayer = new Konva.Layer()
  bgLayer.listening(false)
  stage.add(bgLayer)
  let bgNode: Konva.Image | null = null
```

Then in the layer-order block, note the existing `stage.add(frameLayer)/stage.add(cutoutLayer)` calls now come AFTER `bgLayer` — leave them as-is; adding `bgLayer` first guarantees it is bottom-most.

Add `setBackground` to the returned object (next to `setImage`):

```ts
    setBackground(img: HTMLImageElement | null) {
      if (bgNode) { bgNode.destroy(); bgNode = null }
      if (img) {
        bgNode = new Konva.Image({
          image: img, x: 0, y: 0, width: stageW, height: stageH, listening: false,
        })
        bgLayer.add(bgNode)
      }
      bgLayer.batchDraw()
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: PASS (existing tests + the four new `setBackground` tests).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/selfie/compose.ts hugo-apps/src/selfie/__tests__/compose.test.ts
git commit -m "feat(#1520): setBackground stage method on a bottom-most bg layer"
```

---

## Task 4: `BackgroundPicker.vue` component

**Files:**
- Create: `hugo-apps/src/selfie/BackgroundPicker.vue`
- Test: `hugo-apps/src/selfie/__tests__/BackgroundPicker.test.ts`

**Interfaces:**
- Consumes: `BACKGROUNDS`, `BACKGROUND_IDS`, `backgroundUrl` from Task 1.
- Produces: a component with props `{ background: string; imgBase: string }` and emit `{ 'update:background': [id: string] }`. Renders a `None` button (`data-testid="bg-none"`) + one thumbnail per scene (`data-testid="bg-<id>"`), marks the active one with `is-active`.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/selfie/__tests__/BackgroundPicker.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BackgroundPicker from '../BackgroundPicker.vue'
import { BACKGROUNDS } from '../backgrounds'

const base = { background: 'none', imgBase: '/images/devtoberfest/selfie' }

describe('BackgroundPicker.vue', () => {
  it('renders a None option and one control per scene', () => {
    const w = mount(BackgroundPicker, { props: base })
    expect(w.find('[data-testid="bg-none"]').exists()).toBe(true)
    for (const b of BACKGROUNDS) {
      expect(w.find(`[data-testid="bg-${b.id}"]`).exists()).toBe(true)
    }
  })

  it('marks the active background', () => {
    const w = mount(BackgroundPicker, { props: { ...base, background: 'terminal' } })
    expect(w.find('[data-testid="bg-terminal"]').classes()).toContain('is-active')
    expect(w.find('[data-testid="bg-none"]').classes()).not.toContain('is-active')
  })

  it('emits update:background with the scene id on click', async () => {
    const w = mount(BackgroundPicker, { props: base })
    await w.find('[data-testid="bg-pumpkin-patch"]').trigger('click')
    expect(w.emitted('update:background')?.[0]?.[0]).toBe('pumpkin-patch')
  })

  it('emits none when the None option is clicked', async () => {
    const w = mount(BackgroundPicker, { props: { ...base, background: 'terminal' } })
    await w.find('[data-testid="bg-none"]').trigger('click')
    expect(w.emitted('update:background')?.[0]?.[0]).toBe('none')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/BackgroundPicker.test.ts`
Expected: FAIL — cannot resolve `../BackgroundPicker.vue`.

- [ ] **Step 3: Implement the component**

Create `hugo-apps/src/selfie/BackgroundPicker.vue`:

```vue
<script setup lang="ts">
import { BACKGROUNDS, backgroundUrl } from './backgrounds'

defineProps<{ background: string; imgBase: string }>()
const emit = defineEmits<{ 'update:background': [id: string] }>()
</script>
<template>
  <div class="selfie-bg-controls" role="group" aria-label="Background scene">
    <button
      type="button" class="selfie-btn selfie-bg-btn"
      :class="{ 'is-active': background === 'none' }"
      data-testid="bg-none" :aria-pressed="background === 'none'"
      @click="emit('update:background', 'none')"
    >None</button>
    <button
      v-for="b in BACKGROUNDS" :key="b.id" type="button"
      class="selfie-bg-thumb"
      :class="{ 'is-active': background === b.id }"
      :data-testid="`bg-${b.id}`" :aria-pressed="background === b.id"
      :title="b.label"
      @click="emit('update:background', b.id)"
    >
      <img :src="backgroundUrl(imgBase, b.file)" :alt="b.label" loading="lazy" />
    </button>
  </div>
</template>
```

- [ ] **Step 4: Add the picker styles**

Append to `hugo-apps/src/selfie/styles.css`:

```css
/* ---- Background scene picker (#1520) ---- */
.selfie-bg-controls { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .35rem; }
.selfie-bg-btn { background: var(--sapButton_Background, #fff); color: var(--sapButton_TextColor, #0070f2); border: 1px solid var(--sapButton_BorderColor, #0070f2); }
.selfie-bg-btn.is-active { background: var(--sapButton_Emphasized_Background, #0070f2); color: #fff; }
.selfie-bg-thumb { cursor: pointer; padding: 0; width: 48px; height: 48px; border: 2px solid transparent; border-radius: 8px; overflow: hidden; background: var(--sapTile_Background, #fff); }
.selfie-bg-thumb.is-active { border-color: var(--sapButton_Emphasized_Background, #0070f2); }
.selfie-bg-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/BackgroundPicker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/selfie/BackgroundPicker.vue hugo-apps/src/selfie/__tests__/BackgroundPicker.test.ts hugo-apps/src/selfie/styles.css
git commit -m "feat(#1520): BackgroundPicker.vue scene picker"
```

---

## Task 5: Vendor the AnimeGAN model + add onnxruntime-web (license gate)

**Files:**
- Create: `scripts/vendor-animegan.mjs`
- Modify: `hugo-apps/package.json` (add `onnxruntime-web` dep + `vendor:animegan` script; chain into `vendor`/`setup`)
- Create (build output, committed after license clears): `hugo/static/vendor/animegan/model.onnx` + `.animegan-vendored-version` sentinel

**Interfaces:**
- Consumes: nothing at code level.
- Produces: model served at `/vendor/animegan/model.onnx`; `onnxruntime-web` installed for Task 6.

**⚠️ LICENSE GATE — this task blocks committing the binary until the license is verified.**

- [ ] **Step 1: Verify the model license (BLOCKING)**

Research the AnimeGANv2 `face_paint_512_v2` ONNX export and confirm a permissive license (MIT / Apache-2.0 / CC-BY family). The commonly-used `bryandlee/animegan2-pytorch` weights are **MIT**; several ONNX re-exports carry it forward. Record the exact source URL, the license name, and the SHA-256 of the downloaded file.

**Decision point:**
- License clears (MIT/Apache/CC) → proceed to Step 2 with that URL.
- License does NOT clear → do NOT commit a binary. Substitute another small (<25 MB), 512×512-ish, face-oriented style-transfer ONNX with a verified permissive license. If none is found, STOP and report BLOCKED: the background-swap half (Tasks 1-4) ships alone and cartoonify (Tasks 6-7) becomes a documented follow-up. Do not proceed to Task 6 without a licensed model on disk.

- [ ] **Step 2: Add onnxruntime-web + the vendor script to package.json**

In `hugo-apps/package.json`, add to `dependencies` (pin a current 1.x): `"onnxruntime-web": "^1.20.0"`. Add to `scripts`: `"vendor:animegan": "node ../scripts/vendor-animegan.mjs"`. Chain it wherever `vendor:imgly` is invoked (the `setup`/`vendor` script) so a fresh worktree fetches both.

- [ ] **Step 3: Write the vendor script**

Create `scripts/vendor-animegan.mjs` following the `scripts/vendor-imgly.cjs` discipline (header documenting source URL + license + SHA; idempotent via a `.animegan-vendored-version` sentinel; wipe-and-refetch on version drift; no CDN reference left in runtime code). Concretely:

```js
// Vendors the AnimeGANv2 face_paint_512_v2 ONNX model for self-hosting (#1520).
//
// Source:  <RECORDED SOURCE URL from Step 1>
// License: <RECORDED LICENSE from Step 1>  (verified permissive before commit)
// SHA-256: <RECORDED HASH from Step 1>
//
// Runtime never fetches from a CDN — the model is served same-origin at
// /vendor/animegan/model.onnx (approuter CSP), exactly like the imgly assets.
//
// Idempotency: a .animegan-vendored-version sentinel records the model version;
// a version change (or a missing sentinel) wipes and re-fetches.

import { createWriteStream } from 'fs'
import { mkdir, readFile, writeFile, rm } from 'fs/promises'
import { createHash } from 'crypto'
import path from 'path'

const MODEL_URL = '<RECORDED SOURCE URL>'
const EXPECTED_SHA256 = '<RECORDED HASH>'
const VERSION = 'face_paint_512_v2'
const DEST_DIR = path.resolve(process.cwd(), 'hugo/static/vendor/animegan')
const MODEL_PATH = path.join(DEST_DIR, 'model.onnx')
const SENTINEL = path.join(DEST_DIR, '.animegan-vendored-version')

async function sentinelMatches() {
  try { return (await readFile(SENTINEL, 'utf8')).trim() === VERSION } catch { return false }
}

async function main() {
  if (await sentinelMatches()) { console.log('animegan: up to date'); return }
  await rm(DEST_DIR, { recursive: true, force: true })
  await mkdir(DEST_DIR, { recursive: true })
  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`animegan fetch failed: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = createHash('sha256').update(buf).digest('hex')
  if (EXPECTED_SHA256 && sha !== EXPECTED_SHA256) {
    throw new Error(`animegan SHA mismatch: got ${sha}`)
  }
  await writeFile(MODEL_PATH, buf)
  await writeFile(SENTINEL, VERSION + '\n')
  console.log(`animegan: vendored model.onnx (${(buf.length / 1e6).toFixed(1)} MB)`)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

Replace the three `<RECORDED …>` placeholders with the real values from Step 1.

- [ ] **Step 4: Install + run the vendor script**

Run (from the repo root):
```bash
cd hugo-apps && npm install && cd ..
node scripts/vendor-animegan.mjs
ls -l hugo/static/vendor/animegan/
```
Expected: `model.onnx` present (single-digit-to-~25 MB) + `.animegan-vendored-version`.

- [ ] **Step 5: Commit**

```bash
git add scripts/vendor-animegan.mjs hugo-apps/package.json hugo-apps/package-lock.json hugo/static/vendor/animegan/
git commit -m "feat(#1520): vendor AnimeGANv2 model + onnxruntime-web (license verified)"
```

---

## Task 6: `stylize.ts` cartoonify + async effect path

**Files:**
- Create: `hugo-apps/src/selfie/stylize.ts`
- Modify: `hugo-apps/src/selfie/effects.ts` (add `'cartoon'` to `EffectId` line 6 + `EFFECT_IDS` line 118; add `cartoon` table entry; add `applyEffectAsync`)
- Test: `hugo-apps/src/selfie/__tests__/stylize.test.ts`
- Modify test: `hugo-apps/src/selfie/__tests__/effects.test.ts`

**Interfaces:**
- Consumes: `applyEffect` (existing sync dispatcher).
- Produces:
  - `stylize.ts`: `export async function cartoonify(canvas: HTMLCanvasElement): Promise<HTMLCanvasElement>` — returns a stylized canvas, or the **input canvas unchanged** on any failure.
  - `effects.ts`: `EffectId` includes `'cartoon'`; `EFFECT_IDS` ends with `'cartoon'`; `export async function applyEffectAsync(canvas: HTMLCanvasElement, id: EffectId): Promise<HTMLCanvasElement>`.

- [ ] **Step 1: Write the failing stylize test**

Create `hugo-apps/src/selfie/__tests__/stylize.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock onnxruntime-web so no real WASM/model loads in unit tests.
const runMock = vi.fn()
const createMock = vi.fn(async () => ({ run: runMock }))
vi.mock('onnxruntime-web', () => ({
  InferenceSession: { create: createMock },
  Tensor: class { constructor(public type: string, public data: unknown, public dims: number[]) {} },
  env: { wasm: {} },
}))

import { cartoonify } from '../stylize'

// A canvas stub whose 2D context yields predictable pixel data.
function fakeCanvas(w = 256, h = 256): HTMLCanvasElement {
  const ctx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(512 * 512 * 4).fill(128), width: 512, height: 512 })),
    putImageData: vi.fn(),
  }
  return { width: w, height: h, getContext: vi.fn(() => ctx) } as unknown as HTMLCanvasElement
}

beforeEach(() => { runMock.mockReset(); createMock.mockClear() })

describe('cartoonify fail-soft', () => {
  it('returns the INPUT canvas unchanged when session creation throws', async () => {
    createMock.mockRejectedValueOnce(new Error('no wasm'))
    const c = fakeCanvas()
    expect(await cartoonify(c)).toBe(c)
  })

  it('returns the INPUT canvas unchanged when inference throws', async () => {
    runMock.mockRejectedValueOnce(new Error('run failed'))
    const c = fakeCanvas()
    expect(await cartoonify(c)).toBe(c)
  })

  it('returns the INPUT canvas unchanged when the 2D context is null', async () => {
    const c = { width: 256, height: 256, getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement
    expect(await cartoonify(c)).toBe(c)
  })
})
```

Note: the success-path pixel round-trip is hard to assert meaningfully against a mock without pinning the exact tensor layout; the fail-soft paths are the behavioral contract that matters and are fully covered here. If the implementer wants a success assertion, have `runMock` resolve `{ output: new Tensor('float32', new Float32Array(3*512*512).fill(0), [1,3,512,512]) }` and assert the return is a NEW canvas (not `c`) — but keep it only if the tensor key/layout in the implementation is stable.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/stylize.test.ts`
Expected: FAIL — cannot resolve `../stylize`.

- [ ] **Step 3: Implement stylize.ts**

Create `hugo-apps/src/selfie/stylize.ts`:

```ts
// Cartoonify style transfer for the selfie composer (#1520). Runs the
// self-hosted AnimeGANv2 face_paint_512_v2 ONNX model in-browser via
// onnxruntime-web — the same in-browser posture as imgly background removal.
// Lazy-imported so neither the runtime nor the model touch the page-load path.
// Fail-soft: ANY failure returns the input canvas unchanged.

const MODEL_URL = '/vendor/animegan/model.onnx'
const SIZE = 512 // model's fixed square I/O

let sessionPromise: Promise<unknown> | null = null

async function getSession(ort: typeof import('onnxruntime-web')) {
  if (!sessionPromise) {
    // Self-hosted WASM binaries live alongside the app bundle (no CDN).
    ort.env.wasm.wasmPaths = '/vendor/onnxruntime/'
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['webgpu', 'wasm'],
    })
  }
  return sessionPromise
}

export async function cartoonify(canvas: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  try {
    const ort = await import('onnxruntime-web')
    const session = (await getSession(ort)) as import('onnxruntime-web').InferenceSession

    // Downscale the composite into a SIZE×SIZE working canvas.
    const work = document.createElement('canvas')
    work.width = SIZE; work.height = SIZE
    const wctx = work.getContext('2d')
    if (!wctx) return canvas
    wctx.drawImage(canvas, 0, 0, SIZE, SIZE)
    const { data } = wctx.getImageData(0, 0, SIZE, SIZE)

    // RGBA uint8 → planar RGB float32 in [-1,1], NCHW.
    const chw = new Float32Array(3 * SIZE * SIZE)
    const plane = SIZE * SIZE
    for (let i = 0; i < plane; i++) {
      chw[i] = data[i * 4] / 127.5 - 1
      chw[plane + i] = data[i * 4 + 1] / 127.5 - 1
      chw[2 * plane + i] = data[i * 4 + 2] / 127.5 - 1
    }
    const input = new ort.Tensor('float32', chw, [1, 3, SIZE, SIZE])
    const feeds: Record<string, unknown> = { [session.inputNames[0]]: input }
    const out = await session.run(feeds as never)
    const outTensor = out[session.outputNames[0]] as import('onnxruntime-web').Tensor
    const od = outTensor.data as Float32Array

    // Planar RGB float32 [-1,1] → RGBA uint8.
    const rgba = new Uint8ClampedArray(plane * 4)
    for (let i = 0; i < plane; i++) {
      rgba[i * 4] = (od[i] + 1) * 127.5
      rgba[i * 4 + 1] = (od[plane + i] + 1) * 127.5
      rgba[i * 4 + 2] = (od[2 * plane + i] + 1) * 127.5
      rgba[i * 4 + 3] = 255
    }
    wctx.putImageData(new ImageData(rgba, SIZE, SIZE), 0, 0)

    // Upscale the stylized result back onto a canvas of the input's dimensions.
    const outCanvas = document.createElement('canvas')
    outCanvas.width = canvas.width; outCanvas.height = canvas.height
    const octx = outCanvas.getContext('2d')
    if (!octx) return canvas
    octx.drawImage(work, 0, 0, canvas.width, canvas.height)
    return outCanvas
  } catch (e) {
    console.warn('[selfie] cartoonify failed; exporting without it', e)
    return canvas
  }
}
```

Note: `ort.env.wasm.wasmPaths` points at `/vendor/onnxruntime/`. If Task 5 vendored the ORT WASM binaries elsewhere, set this to the actual served path. If ORT's default packaged WASM works under the approuter CSP without a custom path, delete that line — but verify no CDN fetch happens (Network tab shows same-origin only).

- [ ] **Step 4: Run stylize test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/stylize.test.ts`
Expected: PASS (3 fail-soft tests).

- [ ] **Step 5: Extend effects.ts for the async cartoon path**

In `hugo-apps/src/selfie/effects.ts`:

1. Line 6 — add `'cartoon'`:
```ts
export type EffectId = 'none' | 'duotone' | 'warm' | 'mono' | 'vignette' | 'joule' | 'cartoon'
```

2. Add a `cartoon` entry to the `EFFECTS` table (after `joule`). Its sync `apply` returns the input untouched (the real bake is async, in `applyEffectAsync`); its preview is empty (no CSS approximation):
```ts
  cartoon: {
    label: 'Cartoon',
    preview: {}, // no CSS approximation — the ONNX bake only materializes at export
    apply: (canvas) => canvas, // sync no-op; async bake lives in applyEffectAsync/cartoonify
  },
```

3. Line 118 — append `'cartoon'` to the picker order:
```ts
export const EFFECT_IDS: EffectId[] = ['none', 'duotone', 'warm', 'mono', 'vignette', 'joule', 'cartoon']
```

4. Add the async dispatcher (after `applyEffect`), importing `cartoonify`:
```ts
import { cartoonify } from './stylize'

// Async effect dispatcher. 'cartoon' runs the in-browser ONNX style transfer;
// every other id delegates to the synchronous applyEffect. Fail-soft: a failed
// cartoonify returns the input canvas (cartoonify already guards internally; the
// try/catch is belt-and-braces, matching applyEffect's outer guard).
export async function applyEffectAsync(canvas: HTMLCanvasElement, id: EffectId): Promise<HTMLCanvasElement> {
  if (id === 'cartoon') {
    try { return await cartoonify(canvas) } catch { return canvas }
  }
  return applyEffect(canvas, id)
}
```

- [ ] **Step 6: Update the existing effects.test.ts assertions for the new id**

In `hugo-apps/src/selfie/__tests__/effects.test.ts`, the `EFFECT_IDS` exact-match test (line 36-43) now fails because the list grew. Update it and add async coverage. Replace the `'lists none first…'` test body's array and keep the per-entry `apply` check (cartoon's `apply` is a function too):

```ts
  it('lists none first and exposes every preset in order', () => {
    expect(EFFECT_IDS).toEqual(['none', 'duotone', 'warm', 'mono', 'vignette', 'joule', 'cartoon'])
    expect(EFFECT_IDS[0]).toBe('none')
    for (const id of EFFECT_IDS) {
      expect(typeof EFFECTS[id].label).toBe('string')
      expect(typeof EFFECTS[id].apply).toBe('function')
    }
  })
```

Add a new `describe` for `applyEffectAsync` at the end of the file. Mock `../stylize` so no ONNX loads:

```ts
import { applyEffectAsync } from '../effects'
import { vi as _vi } from 'vitest'

vi.mock('../stylize', () => ({ cartoonify: vi.fn(async (c: HTMLCanvasElement) => ({ ...c, _cartooned: true } as unknown as HTMLCanvasElement)) }))

describe('applyEffectAsync', () => {
  it('routes cartoon through cartoonify', async () => {
    const { cartoonify } = await import('../stylize')
    const c = composite()
    await applyEffectAsync(c, 'cartoon')
    expect(cartoonify).toHaveBeenCalledWith(c)
  })

  it('delegates non-cartoon ids to the sync applyEffect (mono returns via drawImage path)', async () => {
    const c = composite()
    const out = await applyEffectAsync(c, 'none')
    expect(out).toBe(c) // none is a no-op in both paths
  })

  it('fail-soft: returns the input canvas when cartoonify throws', async () => {
    const { cartoonify } = await import('../stylize')
    ;(cartoonify as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error('boom'))
    const c = composite()
    expect(await applyEffectAsync(c, 'cartoon')).toBe(c)
  })
})
```

Note: the `vi.mock('../stylize', …)` call must sit at the top of the file with the other imports (hoisted), not inside the describe. Move it up if vitest complains about hoist ordering.

- [ ] **Step 7: Run the effects test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/effects.test.ts`
Expected: PASS (existing + updated + 3 new async tests).

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/selfie/stylize.ts hugo-apps/src/selfie/effects.ts hugo-apps/src/selfie/__tests__/stylize.test.ts hugo-apps/src/selfie/__tests__/effects.test.ts
git commit -m "feat(#1520): cartoonify style transfer via async effect path"
```

---

## Task 7: `exportPng` awaits the async effect path

**Files:**
- Modify: `hugo-apps/src/selfie/compose.ts` (`exportPng` ~line 128-171)
- Test: `hugo-apps/src/selfie/__tests__/compose.test.ts`

**Interfaces:**
- Consumes: `applyEffectAsync` from Task 6.
- Produces: `exportPng` bakes `'cartoon'` (and all effects) via the async dispatcher; bake order unchanged (effect before border).

- [ ] **Step 1: Write the failing test**

Add to `hugo-apps/src/selfie/__tests__/compose.test.ts` (mock `../effects` `applyEffectAsync` in that file's existing mock setup, or add a `vi.mock('../effects', …)`):

```ts
describe('exportPng cartoon path', () => {
  it('takes the canvas (not fast) path for cartoon and awaits applyEffectAsync', async () => {
    // build a stage, call exportPng({ effect: 'cartoon' }); assert applyEffectAsync
    // was called with the toCanvas() result and the id 'cartoon', and a Blob resolves.
  })

  it('bakes the effect BEFORE the polaroid border (order preserved)', async () => {
    // exportPng({ effect: 'mono', border: {style,name} }): assert applyEffectAsync
    // resolves before paintPolaroid is invoked (spy call order).
  })
})
```

Fill the bodies against the file's mock (spy on `applyEffectAsync` and `paintPolaroid`; assert `.mock.invocationCallOrder`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: FAIL — cartoon not treated as needing the canvas path / `applyEffectAsync` not called.

- [ ] **Step 3: Implement in compose.ts**

1. Update the import (line 5):
```ts
import { applyEffect, applyEffectAsync, type EffectId } from './effects'
```
(Keep `applyEffect` imported only if still referenced; otherwise import just `applyEffectAsync`.)

2. In `exportPng`, `needsCanvas` already covers `effect !== 'none'`, which includes `'cartoon'` — no change needed there. Make the pixel-pass branch async. Replace the synchronous `applyEffect` line and its surrounding executor. The current executor is `new Promise<Blob>((resolve, reject) => { ... })`; change the `if (needsCanvas)` block to run async:

```ts
        if (needsCanvas) {
          void (async () => {
            try {
              let composite = stage.toCanvas() as HTMLCanvasElement
              // Effect bakes BEFORE the border so the white matte stays untinted.
              if (effect && effect !== 'none') composite = await applyEffectAsync(composite, effect)
              const finalCanvas = border ? paintPolaroid(composite, border) : composite
              finalCanvas.toBlob((b: Blob | null) => {
                restore()
                b ? resolve(b) : reject(new Error('export failed'))
              }, 'image/png')
            } catch (e) {
              restore()
              reject(e as Error)
            }
          })()
          return
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: PASS (existing + Task 3 setBackground + the 2 new cartoon-path tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/compose.ts hugo-apps/src/selfie/__tests__/compose.test.ts
git commit -m "feat(#1520): exportPng awaits applyEffectAsync (cartoon bake)"
```

---

## Task 8: Wire BackgroundPicker + cartoon UX into Composer.vue

**Files:**
- Modify: `hugo-apps/src/selfie/Composer.vue`
- Test: `hugo-apps/src/selfie/__tests__/Composer.test.ts`

**Interfaces:**
- Consumes: `BackgroundPicker.vue` (Task 4), `backgroundUrl`/`BACKGROUNDS` (Task 1), `setBackground` (Task 3), `urlToImage` (already in Composer, line 62-69).
- Produces: background picking (forces `removeBg` on for a scene), cartoon inference spinner, failure note. No new emits beyond the existing set.

- [ ] **Step 1: Write the failing tests**

Add to `hugo-apps/src/selfie/__tests__/Composer.test.ts`. The file's `buildStage` mock (in the `vi.hoisted` block) must gain a `setBackground` spy — add `const setBackground = vi.fn()` there, include it in the resolved stage object, and export it on `h`.

```ts
  it('renders the background picker', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    expect(w.find('[data-testid="bg-none"]').exists()).toBe(true)
    expect(w.find('[data-testid="bg-terminal"]').exists()).toBe(true)
  })

  it('picking a scene sets it on the stage and forces removeBg on', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: false, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="bg-terminal"]').trigger('click')
    await flushPromises()
    expect(h.setBackground).toHaveBeenCalledTimes(1) // an <img> was loaded + set
    expect(w.emitted('update:removeBg')?.[0]?.[0]).toBe(true) // forced on
  })

  it('picking None clears the stage background', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="bg-terminal"]').trigger('click'); await flushPromises()
    h.setBackground.mockClear()
    await w.find('[data-testid="bg-none"]').trigger('click'); await flushPromises()
    expect(h.setBackground).toHaveBeenCalledWith(null)
  })

  it('picking cartoon forwards effect: cartoon to exportPng', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="effect-cartoon"]').trigger('click')
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith({ effect: 'cartoon', border: undefined })
  })
```

Note: the `Image` stub already in `Composer.test.ts`'s `beforeEach` resolves `onload` on the next microtask, so `urlToImage` for the scene resolves in tests — `setBackground` is reached.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/Composer.test.ts`
Expected: FAIL — `bg-none` not found / `setBackground` not called / no `effect-cartoon`.

- [ ] **Step 3: Implement in Composer.vue**

1. Imports (after the EffectPicker import, line 9-10):
```ts
import BackgroundPicker from './BackgroundPicker.vue'
import { backgroundUrl, BACKGROUNDS } from './backgrounds'
```

2. State (after `effectId`, line 35):
```ts
const backgroundId = ref('none')
const cartoonBusy = ref(false)
const effectNote = ref('')
```

3. Handler (after `doExport`, or near the other `on*` handlers):
```ts
async function onPickBackground(id: string) {
  backgroundId.value = id
  if (!stage) return
  if (id === 'none') { stage.setBackground(null); return }
  // A themed background is meaningless without the cutout — force removeBg on.
  if (!props.removeBg) emit('update:removeBg', true)
  const scene = BACKGROUNDS.find((b) => b.id === id)
  if (!scene) return
  try {
    const img = await urlToImage(backgroundUrl(props.imgBase, scene.file))
    stage.setBackground(img)
  } catch (e) {
    console.warn('[selfie] background load failed', e)
  }
}
```

4. `doExport` — reflect cartoon busy + surface a note if cartoon silently no-ops is out of scope (cartoonify is fail-soft internally); wrap the export in the busy flag:
```ts
async function doExport() {
  if (!stage) return emit('fallback', effectiveBlob())
  effectNote.value = ''
  if (effectId.value === 'cartoon') cartoonBusy.value = true
  try {
    const blob = await stage.exportPng({
      effect: effectId.value,
      border: borderEnabled.value ? { style: borderStyle.value, name: borderName.value } : undefined,
    })
    emit('export', blob)
  } catch { emit('fallback', effectiveBlob()) }
  finally { cartoonBusy.value = false }
}
```

5. Template — add the `BackgroundPicker` next to the `EffectPicker` (after line 188):
```html
      <BackgroundPicker :background="backgroundId" :img-base="imgBase" @update:background="onPickBackground" />
```
And a busy hint + note near the export button (before/after the export `<button>`, line 199):
```html
      <span v-if="cartoonBusy" class="selfie-busy" role="status" data-testid="cartoon-busy">Cartoonifying&hellip;</span>
      <p v-if="effectNote" class="selfie-note" role="status">{{ effectNote }}</p>
```
Optionally disable Export while `cartoonBusy`: `:disabled="segmenting || cartoonBusy"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/Composer.test.ts`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Run the full selfie suite + build**

Run:
```bash
npm test -- --project unit hugo-apps/src/selfie
cd hugo-apps && npx vite build && cd ..
```
Expected: all selfie tests green; `vite build` completes with no errors (onnxruntime-web lazy chunk splits out).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/selfie/Composer.vue hugo-apps/src/selfie/__tests__/Composer.test.ts
git commit -m "feat(#1520): wire background picker + cartoon UX into composer"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** themed background (Tasks 1-4), cartoonify (Tasks 5-6), export integration (Task 7), UX wiring + privacy-preserving fail-soft (Task 8). Privacy promise untouched (no `Selfie.vue` copy change — verified in spec). License gate is Task 5 Step 1 (blocking).
- **Type consistency:** `setBackground(img|null)` used identically in Tasks 3, 7, 8. `applyEffectAsync(canvas, id)` defined in Task 6, consumed in Task 7. `EffectId` includes `'cartoon'` from Task 6 onward; `'update:background'` emit name matches between Task 4 (BackgroundPicker) and Task 8 (Composer `@update:background`). `backgroundUrl`/`BACKGROUNDS` signatures consistent Tasks 1/4/8.
- **Known landmine flagged:** Task 6 Step 6 updates the pre-existing `effects.test.ts` exact-match assertion that adding `'cartoon'` would otherwise break — called out explicitly so a task-scoped implementer doesn't miss it.
- **Placeholder scan:** the only intentional placeholders are Task 5's `<RECORDED …>` model URL/hash/license, which are *outputs of the blocking license-verification step* — they cannot be pre-filled and are the point of the gate.

# Selfie Filters & Effects Layer (#1516) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-tap effects layer to the selfie composer — a handful of branded/seasonal presets that preview live in the UI, bake into the exported PNG, are non-destructive (switch/clear freely before download), and never crash the island if an effect fails.

**Architecture:** Mirror the merged #1518 polaroid pattern exactly. A new pure `effects.ts` module holds two representations per preset (a CSS approximation for the live UI preview + an authoritative Canvas-2D bake for export). The Konva stage is read (`stage.toCanvas()`) but never mutated, so switching/clearing an effect is just resetting a ref. The effect bakes into the composite **before** the polaroid border so the matte stays untinted.

**Tech Stack:** Vue 3 `<script setup lang="ts">` SFCs, Konva 9 (stage untouched), Canvas-2D (no new deps), Vitest v4 + happy-dom + `@vue/test-utils`.

## Global Constraints

- **No semicolons** in selfie `.ts`/`.vue` files.
- **LF line endings** (Windows CRLF regressions are a known hazard).
- **Fail-soft always** — the island must never throw into the page.
- **Canvas-2D only** — no new dependencies; NO glfx.js, NO WebGL, NO Konva filters.
- **Konva stays `^9.3.0`** (hugo-apps only); the stage is never mutated by an effect.
- **`none` is the default** effect and always the first picker entry.
- **Effect bakes before the polaroid border** in the export chain: `stage.toCanvas() → applyEffect → [paintPolaroid] → toBlob`.
- **Brand copy:** preset labels are user-facing. Devtoberfest orange `#e8791a` + dark `#2b1a0f` reuse the existing polaroid branding; Joule is pink `#e2337f` → purple `#7d4bd6`.
- **Run tests from the repo root:** `npm test -- --project unit <file>`.
- **Pre-existing failure to ignore:** `segment.test.ts` fails to resolve `@imgly/background-removal` — out of scope, do NOT "fix" it.

---

### Task 1: `effects.ts` — preset table + fail-soft dispatcher

**Files:**
- Create: `hugo-apps/src/selfie/effects.ts`
- Test: `hugo-apps/src/selfie/__tests__/effects.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type EffectId = 'none' | 'duotone' | 'warm' | 'mono' | 'vignette' | 'joule'`
  - `interface Effect { label: string; preview: { filter?: string; overlay?: { background: string; blend: string; opacity: number } }; apply: (canvas: HTMLCanvasElement) => HTMLCanvasElement }`
  - `const EFFECTS: Record<EffectId, Effect>`
  - `const EFFECT_IDS: EffectId[]` — picker order, `'none'` first
  - `function applyEffect(canvas: HTMLCanvasElement, id: EffectId): HTMLCanvasElement` — pure, fail-soft dispatcher; returns the input canvas unchanged for `'none'`, an unknown id, a missing 2D context, or any thrown error inside `apply()`.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/selfie/__tests__/effects.test.ts`. This extends `polaroid.test.ts`'s spy-2D-context harness and adds a `createRadialGradient` spy plus `globalCompositeOperation`/`globalAlpha`/`filter` capture. Each `apply` draws onto the SAME canvas it receives (self-composite), so the spy context is the composite's own context.

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EFFECTS, EFFECT_IDS, applyEffect, type EffectId } from '../effects'

// Spy 2D context capturing the calls each effect's apply() makes.
function makeCtx() {
  const linGrad = { addColorStop: vi.fn() }
  const radGrad = { addColorStop: vi.fn() }
  return {
    fillStyle: '' as string | CanvasGradient,
    filter: 'none',
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    globalAlpha: 1,
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    createLinearGradient: vi.fn(() => linGrad),
    createRadialGradient: vi.fn(() => radGrad),
    _lin: linGrad,
    _rad: radGrad,
  }
}

let ctx: ReturnType<typeof makeCtx>
let ctxIsNull = false

// A composite "canvas": width/height + a getContext returning our spy.
function composite(w = 1000, h = 1000): HTMLCanvasElement {
  return { width: w, height: h, getContext: vi.fn(() => (ctxIsNull ? null : ctx)) } as unknown as HTMLCanvasElement
}

beforeEach(() => { ctx = makeCtx(); ctxIsNull = false })

describe('effects table', () => {
  it('lists none first and exposes exactly the six presets in order', () => {
    expect(EFFECT_IDS).toEqual(['none', 'duotone', 'warm', 'mono', 'vignette', 'joule'])
    expect(EFFECT_IDS[0]).toBe('none')
    for (const id of EFFECT_IDS) {
      expect(typeof EFFECTS[id].label).toBe('string')
      expect(typeof EFFECTS[id].apply).toBe('function')
    }
  })

  it('none has an empty preview and returns the input untouched', () => {
    expect(EFFECTS.none.preview).toEqual({})
    const c = composite()
    expect(EFFECTS.none.apply(c)).toBe(c)
  })
})

describe('duotone bake', () => {
  it('grayscales via a self-composite filter then color-blends an orange→dark gradient', () => {
    const c = composite()
    EFFECTS.duotone.apply(c)
    expect(ctx.drawImage).toHaveBeenCalledWith(c, 0, 0) // self-composite through the filter
    expect(ctx.createLinearGradient).toHaveBeenCalled()
    expect(ctx._lin.addColorStop).toHaveBeenCalledWith(0, '#e8791a')
    expect(ctx._lin.addColorStop).toHaveBeenCalledWith(1, '#2b1a0f')
    // color-blend used, and reset afterwards (save/restore brackets it)
    expect(ctx.save).toHaveBeenCalled()
    expect(ctx.restore).toHaveBeenCalled()
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1000, 1000)
    // filter reset so the gradient fill is not itself filtered
    expect(ctx.filter).toBe('none')
  })
})

describe('warm + mono bakes', () => {
  it('warm draws the canvas onto itself through a sepia/saturate/contrast filter, then resets', () => {
    const c = composite()
    EFFECTS.warm.apply(c)
    expect(ctx.drawImage).toHaveBeenCalledWith(c, 0, 0)
    expect(ctx.createLinearGradient).not.toHaveBeenCalled() // no overlay
    expect(ctx.filter).toBe('none')
  })

  it('mono draws the canvas onto itself through grayscale(1), then resets', () => {
    const c = composite()
    EFFECTS.mono.apply(c)
    expect(ctx.drawImage).toHaveBeenCalledWith(c, 0, 0)
    expect(ctx.filter).toBe('none')
  })
})

describe('vignette + joule bakes', () => {
  it('vignette fills a transparent→dark radial gradient over the frame', () => {
    EFFECTS.vignette.apply(composite())
    expect(ctx.createRadialGradient).toHaveBeenCalled()
    expect(ctx._rad.addColorStop).toHaveBeenCalledWith(0, 'rgba(0,0,0,0)')
    expect(ctx._rad.addColorStop).toHaveBeenCalledWith(1, 'rgba(0,0,0,0.55)')
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1000, 1000)
  })

  it('joule fills a low-alpha pink→purple linear gradient (soft wash)', () => {
    EFFECTS.joule.apply(composite())
    expect(ctx.createLinearGradient).toHaveBeenCalled()
    expect(ctx._lin.addColorStop).toHaveBeenCalledWith(0, '#e2337f')
    expect(ctx._lin.addColorStop).toHaveBeenCalledWith(1, '#7d4bd6')
    expect(ctx.globalAlpha).toBe(1) // restored to default after the fill (save/restore)
    expect(ctx.save).toHaveBeenCalled()
    expect(ctx.restore).toHaveBeenCalled()
  })
})

describe('applyEffect fail-soft', () => {
  it('returns the input for none', () => {
    const c = composite()
    expect(applyEffect(c, 'none')).toBe(c)
  })

  it('returns the input for an unknown id', () => {
    const c = composite()
    expect(applyEffect(c, 'bogus' as EffectId)).toBe(c)
  })

  it('returns the input when the 2D context is null (no throw)', () => {
    ctxIsNull = true
    const c = composite()
    expect(applyEffect(c, 'mono')).toBe(c)
  })

  it('catches a thrown apply() and returns the input canvas', () => {
    const c = composite()
    const spy = vi.spyOn(EFFECTS.duotone, 'apply').mockImplementation(() => { throw new Error('boom') })
    expect(applyEffect(c, 'duotone')).toBe(c)
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/effects.test.ts`
Expected: FAIL — cannot resolve `../effects`.

- [ ] **Step 3: Write minimal implementation**

Create `hugo-apps/src/selfie/effects.ts`:

```ts
// Branded one-tap effect presets for the Devtoberfest selfie composer (#1516).
// Two representations per preset: a CSS approximation for the live UI preview,
// and an authoritative Canvas-2D bake applied to the export composite. The Konva
// stage is never mutated — switching or clearing an effect just resets a ref.

export type EffectId = 'none' | 'duotone' | 'warm' | 'mono' | 'vignette' | 'joule'

export interface Effect {
  label: string
  // CSS live-preview approximation. `filter` binds to the stage element; `overlay`
  // renders as an absolutely-positioned blend layer over the photo.
  preview: {
    filter?: string
    overlay?: { background: string; blend: string; opacity: number }
  }
  // Authoritative Canvas-2D bake. Mutates and returns the SAME canvas. Individually
  // defensive (returns the input on no-context) — applyEffect adds the outer guard.
  apply: (canvas: HTMLCanvasElement) => HTMLCanvasElement
}

// Brand colors reused from the polaroid/sticker branding.
const DEVTOBERFEST_ORANGE = '#e8791a'
const DEVTOBERFEST_DARK = '#2b1a0f'
const JOULE_PINK = '#e2337f'
const JOULE_PURPLE = '#7d4bd6'

// Redraw the canvas onto itself through a CSS filter string, then reset the filter
// so any later overlay fill is not itself filtered. Standard self-composite trick.
function filterSelf(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, filter: string): void {
  ctx.filter = filter
  ctx.drawImage(canvas, 0, 0)
  ctx.filter = 'none'
}

export const EFFECTS: Record<EffectId, Effect> = {
  none: {
    label: 'None',
    preview: {},
    apply: (canvas) => canvas,
  },
  duotone: {
    label: 'Devtoberfest',
    preview: {
      filter: 'grayscale(1)',
      overlay: { background: `linear-gradient(${DEVTOBERFEST_ORANGE}, ${DEVTOBERFEST_DARK})`, blend: 'color', opacity: 1 },
    },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      filterSelf(canvas, ctx, 'grayscale(1)')
      const g = ctx.createLinearGradient(0, 0, 0, canvas.height)
      g.addColorStop(0, DEVTOBERFEST_ORANGE)
      g.addColorStop(1, DEVTOBERFEST_DARK)
      ctx.save()
      ctx.globalCompositeOperation = 'color'
      ctx.fillStyle = g
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()
      return canvas
    },
  },
  warm: {
    label: 'Warm',
    preview: { filter: 'sepia(0.35) saturate(1.4) contrast(1.05)' },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      filterSelf(canvas, ctx, 'sepia(0.35) saturate(1.4) contrast(1.05)')
      return canvas
    },
  },
  mono: {
    label: 'B&W',
    preview: { filter: 'grayscale(1)' },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      filterSelf(canvas, ctx, 'grayscale(1)')
      return canvas
    },
  },
  vignette: {
    label: 'Vignette',
    preview: { overlay: { background: 'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.55) 100%)', blend: 'normal', opacity: 1 } },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      const w = canvas.width
      const h = canvas.height
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      return canvas
    },
  },
  joule: {
    label: 'Joule',
    preview: { overlay: { background: `linear-gradient(135deg, ${JOULE_PINK}, ${JOULE_PURPLE})`, blend: 'soft-light', opacity: 0.5 } },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
      g.addColorStop(0, JOULE_PINK)
      g.addColorStop(1, JOULE_PURPLE)
      ctx.save()
      ctx.globalAlpha = 0.35
      ctx.fillStyle = g
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()
      return canvas
    },
  },
}

// Picker order — the control renders effects in this sequence; 'none' is first.
export const EFFECT_IDS: EffectId[] = ['none', 'duotone', 'warm', 'mono', 'vignette', 'joule']

// Pure dispatcher. Returns the input canvas unchanged for 'none', an unknown id, a
// missing 2D context, or ANY thrown error inside apply(). Fail-soft.
export function applyEffect(canvas: HTMLCanvasElement, id: EffectId): HTMLCanvasElement {
  const effect = EFFECTS[id]
  if (!effect || id === 'none') return canvas
  try {
    return effect.apply(canvas)
  } catch (e) {
    console.warn('[selfie] effect failed', id, e)
    return canvas
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/effects.test.ts`
Expected: PASS (all groups green).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/effects.ts hugo-apps/src/selfie/__tests__/effects.test.ts
git commit -m "feat(#1516): selfie effect presets module (Canvas-2D bake + CSS preview)"
```

---

### Task 2: `compose.ts` — `exportPng` options-object refactor (effect bakes before border)

**Files:**
- Modify: `hugo-apps/src/selfie/compose.ts` (interface line 16; implementation lines 127-163; add import)
- Test: `hugo-apps/src/selfie/__tests__/compose.test.ts` (update existing border tests; add effect tests)

**Interfaces:**
- Consumes: `applyEffect`, `EffectId` from `./effects` (Task 1); `paintPolaroid`, `PolaroidStyleId` from `./polaroid` (existing).
- Produces: `SelfieStage.exportPng(opts?: { effect?: EffectId; border?: { style: PolaroidStyleId; name: string } }): Promise<Blob>` — canvas path when `effect` is a real effect (not `none`/undefined) OR `border` is set; effect bakes before `paintPolaroid`; else the fast `stage.toBlob` path. **Breaking change** from the old positional `exportPng(border?)`.

- [ ] **Step 1: Update the tests to the new signature (they will fail)**

In `hugo-apps/src/selfie/__tests__/compose.test.ts`:

**1a.** After the `paintPolaroidMock` block (currently lines 85-93), add an `applyEffect` mock:

```ts
const applyEffectMock = vi.fn((canvas: any) => canvas)
vi.mock('../effects', () => ({
  applyEffect: (c: any, id: any) => applyEffectMock(c, id),
}))
```

**1b.** In `beforeEach` (currently ends at line 105 with `paintPolaroidMock.mockClear()`), add:

```ts
  applyEffectMock.mockClear()
```

**1c.** Replace the existing `exportPng({ border })` test (currently lines 233-240) with the border-under-new-shape version:

```ts
  it('exportPng({ border }) routes the composite canvas through paintPolaroid', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng({ border: { style: 'joule', name: 'Tom' } })
    expect(out).toBeInstanceOf(Blob)
    expect(paintPolaroidMock).toHaveBeenCalledTimes(1)
    expect(paintPolaroidMock.mock.calls[0][1]).toEqual({ style: 'joule', name: 'Tom' })
  })
```

**1d.** Replace the "border export still hides BOTH transformers" test (currently lines 242-255) so its call uses the new shape:

```ts
  it('border export still hides BOTH transformers during rasterization, then restores', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    stage.addCutout(fakeImg(1280, 720))
    stage.addEmoji('🎉')
    expect(transformers.every((t) => t.visible())).toBe(true)
    let allHiddenAtBake = false
    paintPolaroidMock.mockImplementationOnce((composite: any) => {
      allHiddenAtBake = transformers.every((t) => !t.visible())
      return { width: composite.width, height: composite.height, toBlob: (cb: any) => cb(new Blob(['b'], { type: 'image/png' })) }
    })
    await stage.exportPng({ border: { style: 'classic', name: '' } })
    expect(allHiddenAtBake).toBe(true)
    expect(transformers.every((t) => t.visible())).toBe(true)
  })
```

**1e.** Extend the "no border" test (currently lines 226-231) to also assert `applyEffect` is not called:

```ts
  it('exportPng() with no effect/border does NOT invoke applyEffect or paintPolaroid', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng()
    expect(out).toBeInstanceOf(Blob)
    expect(applyEffectMock).not.toHaveBeenCalled()
    expect(paintPolaroidMock).not.toHaveBeenCalled()
  })
```

**1f.** Add three new tests inside the `describe('compose.buildStage', ...)` block:

```ts
  it('exportPng({ effect }) routes the composite through applyEffect once with the id (canvas path, no border)', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng({ effect: 'mono' })
    expect(out).toBeInstanceOf(Blob)
    expect(applyEffectMock).toHaveBeenCalledTimes(1)
    expect(applyEffectMock.mock.calls[0][1]).toBe('mono')
    expect(paintPolaroidMock).not.toHaveBeenCalled() // no border → effect-only canvas path
  })

  it('exportPng({ effect: "none" }) takes the fast toBlob path — no applyEffect, no paintPolaroid', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng({ effect: 'none' })
    expect(out).toBeInstanceOf(Blob)
    expect(applyEffectMock).not.toHaveBeenCalled()
    expect(paintPolaroidMock).not.toHaveBeenCalled()
  })

  it('bakes the effect BEFORE the polaroid border when both are set', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    await stage.exportPng({ effect: 'duotone', border: { style: 'classic', name: '' } })
    expect(applyEffectMock).toHaveBeenCalledTimes(1)
    expect(paintPolaroidMock).toHaveBeenCalledTimes(1)
    // effect runs first: its invocation order precedes paintPolaroid's
    expect(applyEffectMock.mock.invocationCallOrder[0])
      .toBeLessThan(paintPolaroidMock.mock.invocationCallOrder[0])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: FAIL — `applyEffect` is not imported/called by `compose.ts` yet, and the new-shape border calls hit the old positional handler.

- [ ] **Step 3: Refactor `compose.ts`**

**3a.** Add the import after the existing `polaroid` import (line 4):

```ts
import { applyEffect, type EffectId } from './effects'
```

**3b.** Change the interface method (line 16) from:

```ts
  exportPng(border?: { style: PolaroidStyleId; name: string }): Promise<Blob>
```

to:

```ts
  exportPng(opts?: { effect?: EffectId; border?: { style: PolaroidStyleId; name: string } }): Promise<Blob>
```

**3c.** Replace the `exportPng` implementation (lines 127-163) with:

```ts
    exportPng(opts?: { effect?: EffectId; border?: { style: PolaroidStyleId; name: string } }) {
      const effect = opts?.effect
      const border = opts?.border
      // Canvas path is needed for a real effect OR a border; else the fast blob path.
      const needsCanvas = (!!effect && effect !== 'none') || !!border
      return new Promise<Blob>((resolve, reject) => {
        overlay.deselect()
        const cutoutTVisible = transformer.visible()
        transformer.hide()
        const overlayTVisible = overlay.hideTransformer()
        cutoutLayer.batchDraw()
        overlaysLayer.batchDraw()
        const restore = () => {
          if (cutoutTVisible) transformer.show()
          if (overlayTVisible) overlay.showTransformer()
          cutoutLayer.batchDraw()
          overlaysLayer.batchDraw()
        }
        if (needsCanvas) {
          try {
            let composite = stage.toCanvas() as HTMLCanvasElement
            // Effect bakes BEFORE the border so the matte stays untinted.
            if (effect && effect !== 'none') composite = applyEffect(composite, effect)
            const finalCanvas = border ? paintPolaroid(composite, border) : composite
            finalCanvas.toBlob((b: Blob | null) => {
              restore()
              b ? resolve(b) : reject(new Error('export failed'))
            }, 'image/png')
          } catch (e) {
            restore()
            reject(e as Error)
          }
          return
        }
        stage.toBlob({
          mimeType: 'image/png',
          callback: (b: Blob | null) => {
            restore()
            b ? resolve(b) : reject(new Error('export failed'))
          },
        })
      })
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: PASS (all tests, including the three new effect tests and the two rewritten border tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/compose.ts hugo-apps/src/selfie/__tests__/compose.test.ts
git commit -m "refactor(#1516): exportPng takes { effect, border } — effect bakes before border"
```

---

### Task 3: `EffectPicker.vue` — one-tap preset picker

**Files:**
- Create: `hugo-apps/src/selfie/EffectPicker.vue`
- Test: `hugo-apps/src/selfie/__tests__/EffectPicker.test.ts`

**Interfaces:**
- Consumes: `EFFECTS`, `EFFECT_IDS`, `EffectId` from `./effects` (Task 1).
- Produces: `<EffectPicker :effect="EffectId" @update:effect="(id: EffectId) => ...">` — renders one button per `EFFECT_IDS`, each `:data-testid="effect-${id}"`, `:aria-pressed="id === effect"`, label from `EFFECTS[id].label`; emits `update:effect` with the chosen id on click. Mirrors `PolaroidControls.vue`.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/selfie/__tests__/EffectPicker.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EffectPicker from '../EffectPicker.vue'
import { EFFECT_IDS, EFFECTS } from '../effects'

describe('EffectPicker.vue', () => {
  it('renders one button per EFFECT_IDS with its label', () => {
    const w = mount(EffectPicker, { props: { effect: 'none' } })
    for (const id of EFFECT_IDS) {
      const btn = w.find(`[data-testid="effect-${id}"]`)
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toBe(EFFECTS[id].label)
    }
  })

  it('marks the active effect button aria-pressed="true" and the rest false', () => {
    const w = mount(EffectPicker, { props: { effect: 'mono' } })
    expect(w.find('[data-testid="effect-mono"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="effect-none"]').attributes('aria-pressed')).toBe('false')
  })

  it('emits update:effect with the id when a button is clicked', async () => {
    const w = mount(EffectPicker, { props: { effect: 'none' } })
    await w.find('[data-testid="effect-joule"]').trigger('click')
    expect(w.emitted('update:effect')?.[0]?.[0]).toBe('joule')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/EffectPicker.test.ts`
Expected: FAIL — cannot resolve `../EffectPicker.vue`.

- [ ] **Step 3: Write minimal implementation**

Create `hugo-apps/src/selfie/EffectPicker.vue`:

```vue
<script setup lang="ts">
import { EFFECTS, EFFECT_IDS, type EffectId } from './effects'

defineProps<{ effect: EffectId }>()
const emit = defineEmits<{ 'update:effect': [value: EffectId] }>()

const effects = EFFECT_IDS.map((id) => ({ id, label: EFFECTS[id].label }))
</script>
<template>
  <div class="selfie-effect-controls" role="group" aria-label="Effect">
    <button
      v-for="e in effects" :key="e.id" type="button"
      class="selfie-btn selfie-effect-btn"
      :class="{ 'is-active': e.id === effect }"
      :data-testid="`effect-${e.id}`"
      :aria-pressed="e.id === effect"
      @click="emit('update:effect', e.id)"
    >{{ e.label }}</button>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/EffectPicker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/EffectPicker.vue hugo-apps/src/selfie/__tests__/EffectPicker.test.ts
git commit -m "feat(#1516): EffectPicker.vue one-tap preset picker"
```

---

### Task 4: `Composer.vue` wiring + live preview styles

**Files:**
- Modify: `hugo-apps/src/selfie/Composer.vue` (imports; add `effectId` ref + `previewFilter`/`previewOverlay` computeds; `doExport` forwards `{ effect, border }`; template adds `<EffectPicker>` + filter/overlay on the stage)
- Modify: `hugo-apps/src/selfie/styles.css` (add `.selfie-stage-fx`, `.selfie-effect-overlay`, `.selfie-effect-controls`, `.selfie-effect-btn`)
- Test: `hugo-apps/src/selfie/__tests__/Composer.test.ts` (update the two existing `exportPng` assertions to the new shape; add effect-forwarding + picker-present tests)

**Interfaces:**
- Consumes: `EFFECTS`, `EffectId` from `./effects` (Task 1); `EffectPicker` (Task 3); `stage.exportPng({ effect, border })` (Task 2).
- Produces: no new exports; `doExport()` now calls `stage.exportPng({ effect: effectId.value, border: borderEnabled.value ? { style: borderStyle.value, name: borderName.value } : undefined })`.

- [ ] **Step 1: Update the two existing exportPng tests + add new tests (they will fail)**

In `hugo-apps/src/selfie/__tests__/Composer.test.ts`:

**1a.** Replace the "export with border OFF" test (currently lines 196-202):

```ts
  it('export with border OFF and no effect forwards effect:none, border:undefined', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith({ effect: 'none', border: undefined })
  })
```

**1b.** Replace the "export with border ON" test (currently lines 204-222):

```ts
  it('export with border ON forwards effect + { style, name } to exportPng', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    const cb = w.find('[data-testid="border-toggle"]')
    ;(cb.element as HTMLInputElement).checked = true
    await cb.trigger('change')
    await flushPromises()
    await w.find('[data-testid="border-style-joule"]').trigger('click')
    const nameField = w.find('[data-testid="border-name"]')
    ;(nameField.element as HTMLInputElement).value = 'Tom'
    await nameField.trigger('input')
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith({ effect: 'none', border: { style: 'joule', name: 'Tom' } })
  })
```

**1c.** Add two new tests inside the `describe('Composer.vue', ...)` block:

```ts
  it('renders the effect picker', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    expect(w.find('[data-testid="effect-none"]').exists()).toBe(true)
    expect(w.find('[data-testid="effect-mono"]').exists()).toBe(true)
  })

  it('picking an effect forwards it to exportPng', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="effect-mono"]').trigger('click')
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith({ effect: 'mono', border: undefined })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/Composer.test.ts`
Expected: FAIL — `doExport` still calls the old signature; no `effect-*` buttons exist.

- [ ] **Step 3: Wire `Composer.vue`**

**3a.** Add imports after the `polaroid` import (line 8):

```ts
import EffectPicker from './EffectPicker.vue'
import { EFFECTS, type EffectId } from './effects'
```

**3b.** Add the effect ref after `borderName` (line 32):

```ts
const effectId = ref<EffectId>('none')
```

**3c.** Add the preview computeds after the `previewMatte` computed (after line 41):

```ts
// Live CSS approximation of the active effect. `previewFilter` binds to the stage
// element; `previewOverlay` renders an absolutely-positioned blend layer over the
// photo. Decorative only — applyEffect is authoritative at export.
const previewFilter = computed(() => EFFECTS[effectId.value].preview.filter ?? 'none')
const previewOverlay = computed(() => EFFECTS[effectId.value].preview.overlay ?? null)
```

**3d.** Replace `doExport` (lines 131-139):

```ts
async function doExport() {
  if (!stage) return emit('fallback', effectiveBlob())
  try {
    const blob = await stage.exportPng({
      effect: effectId.value,
      border: borderEnabled.value ? { style: borderStyle.value, name: borderName.value } : undefined,
    })
    emit('export', blob)
  } catch { emit('fallback', effectiveBlob()) }
}
```

**3e.** Replace the stage-preview block in the template (lines 144-150) so the stage element carries the filter and an overlay layer sits over just the photo:

```html
      <div
        class="selfie-polaroid-preview" data-testid="polaroid-preview"
        :class="{ 'is-bordered': borderEnabled }"
        :style="borderEnabled ? { background: previewMatte } : undefined"
      >
        <div class="selfie-stage-fx">
          <div
            ref="stageEl" class="selfie-stage"
            :style="previewFilter !== 'none' ? { filter: previewFilter } : undefined"
          ></div>
          <div
            v-if="previewOverlay" class="selfie-effect-overlay" data-testid="effect-overlay" aria-hidden="true"
            :style="{ background: previewOverlay.background, mixBlendMode: previewOverlay.blend, opacity: previewOverlay.opacity }"
          ></div>
        </div>
      </div>
```

**3f.** Add `<EffectPicker>` to the toolbar, right after the `<PolaroidControls>` block (after line 168):

```html
      <EffectPicker :effect="effectId" @update:effect="effectId = $event" />
```

- [ ] **Step 4: Add the styles**

In `hugo-apps/src/selfie/styles.css`, append to the polaroid section (after line 92):

```css

/* ---- Effect presets (live CSS preview + picker) ---- */
.selfie-stage-fx { position: relative; line-height: 0; }
.selfie-effect-overlay { position: absolute; inset: 0; pointer-events: none; }
.selfie-effect-controls { display: inline-flex; flex-wrap: wrap; gap: .35rem; }
.selfie-effect-btn { background: var(--sapButton_Background, #fff); color: var(--sapButton_TextColor, #0070f2); border: 1px solid var(--sapButton_BorderColor, #0070f2); }
.selfie-effect-btn.is-active { background: var(--sapButton_Emphasized_Background, #0070f2); color: #fff; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/Composer.test.ts`
Expected: PASS (all Composer tests including the two rewritten export tests and the two new effect tests).

- [ ] **Step 6: Run the full selfie suite + build**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/`
Expected: PASS for every file except the known-failing `segment.test.ts` (`@imgly/background-removal` resolution — out of scope).

Run: `cd hugo-apps && npx vite build && cd ..`
Expected: build succeeds (the selfie island bundles into `hugo/static/js/`).

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/selfie/Composer.vue hugo-apps/src/selfie/styles.css hugo-apps/src/selfie/__tests__/Composer.test.ts
git commit -m "feat(#1516): wire effect picker + live preview into the composer"
```

---

## Self-Review

**1. Spec coverage** (against `2026-08-08-selfie-effects-design.md`):
- AC1 "handful of presets" → Task 1 `EFFECTS`/`EFFECT_IDS` (5 + none). ✅
- AC2 "bake into exported PNG" → Task 2 canvas path calls `applyEffect` before `toBlob`. ✅
- AC3 "non-destructive in UI" → stage never mutated (Task 2 reads `toCanvas()`); switching is an `effectId` ref reset (Task 4). ✅
- AC4 "fail-soft, never crashes" → Task 1 `applyEffect` try/catch + per-preset no-context guard; Task 2 `try/catch → reject`; Task 4 `doExport` `catch → fallback`. ✅
- AC5 "test coverage for preset application" → Task 1 effects.test.ts (per-preset bake asserts + fail-soft); Task 2 compose.test.ts (bake-before-border, effect-only path); Task 3 EffectPicker.test.ts; Task 4 Composer.test.ts (forwarding). ✅
- Engine = Canvas-2D, no new deps → Task 1 uses only Canvas-2D primitives; no import of any effects library. ✅
- Joule = gradient wash, not duotone/sticker → Task 1 `joule.apply` low-alpha `globalAlpha=0.35` source-over linear gradient. ✅
- `none` default + first → Task 1 `EFFECT_IDS[0] === 'none'`, Task 4 `effectId = ref('none')`. ✅
- Effect before border → Task 2 ordering test + implementation. ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step carries full source. ✅

**3. Type consistency:**
- `EffectId` / `applyEffect(canvas, id)` / `EFFECTS` / `EFFECT_IDS` — defined in Task 1, consumed verbatim in Tasks 2, 3, 4. ✅
- `exportPng({ effect?, border? })` — produced in Task 2, consumed in Task 4's `doExport` and asserted in Task 4's tests with the exact `{ effect: 'none', border: undefined }` / `{ effect: 'mono', border: undefined }` / `{ effect: 'none', border: { style, name } }` shapes. ✅
- `preview.overlay` shape `{ background, blend, opacity }` — defined in Task 1, bound in Task 4's template (`mixBlendMode: previewOverlay.blend`). ✅
- `data-testid` names — `effect-${id}` (Task 3 emits, Task 4 asserts), `effect-overlay` (Task 4). Border testids reuse existing `border-toggle`/`border-style-*`/`border-name`. ✅

No issues found.

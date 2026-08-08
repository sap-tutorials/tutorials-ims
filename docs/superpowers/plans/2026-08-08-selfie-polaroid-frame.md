# Selfie Tier 2 #1518 — Branded Polaroid Frame Border Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, branded polaroid-style matte border (name + `#Devtoberfest` + "SAP Developers" lockup, three styles) that bakes into the exported PNG of the Devtoberfest selfie composer.

**Architecture:** The feature is quarantined into the export path plus a CSS preview wrapper. The Konva stage from #1517 is untouched. A pure `paintPolaroid(composite, opts) → canvas` (Canvas 2D) draws the matte around the composite; `exportPng()` routes the composite canvas through it when a border is requested. Both the CSS preview and the canvas bake read the SAME `POLAROID_STYLES` table so they cannot drift.

**Tech Stack:** Vue 3 SFC (`<script setup lang="ts">`), Konva.js `^9.3.0` (hugo-apps only), Canvas 2D, Vitest + happy-dom + `@vue/test-utils`.

## Global Constraints

- **Konva stays `^9.3.0` in `hugo-apps/` only** — do not add konva elsewhere, do not bump to 10.x, do NOT `npm install` at the repo root.
- **No semicolons** in Vue/TS selfie files (match existing style).
- **Fail-soft everywhere** — never throw into the export/compose path; a border fault must still yield an image.
- **Write LF line endings** (Windows CRLF hazard).
- **Frontend-only** — no backend/CDS/config; no new mount config in `selfie.html`, `main.ts`, `types.ts`, or `Selfie.vue`.
- **Unit tests run from the repo root** with `npm test -- --project unit <file>` (or `npx vitest run --project unit <file>`). Vite build gate is deferred to CI (this worktree has no `hugo-apps/node_modules` vite bin).
- **`segment.test.ts` pre-existing failure** (missing `@imgly/background-removal` in a fresh worktree) is out of scope — do NOT try to fix it.
- **Style table (verbatim):**
  - `classic` → label "Classic White", matte solid `#ffffff`, textColor `#1d2d3e`, hashtagColor `#0070f2`
  - `devtoberfest` → label "Devtoberfest", matte solid `#2b1a0f`, textColor `#f5e6d3`, hashtagColor `#e8791a`
  - `joule` → label "Joule", matte gradient `#e2337f` → `#7d4bd6` (vertical, top→bottom), textColor `#ffffff`, hashtagColor `#ffffff`
- **Proportion constants (verbatim):** `POLAROID_INSET_FRACTION = 0.05`, `POLAROID_STRIP_FRACTION = 0.22` (fractions of `min(compositeW, compositeH)`).
- **Hashtag copy is exactly `#Devtoberfest`**; lockup copy is exactly `SAP Developers`.

---

### Task 1: `polaroid.ts` — style table + `paintPolaroid`

**Files:**
- Create: `hugo-apps/src/selfie/polaroid.ts`
- Test: `hugo-apps/src/selfie/__tests__/polaroid.test.ts`

**Interfaces:**
- Consumes: nothing (pure leaf module).
- Produces (later tasks import these):
  - `type PolaroidStyleId = 'classic' | 'devtoberfest' | 'joule'`
  - `interface PolaroidStyle { id: PolaroidStyleId; label: string; matte: { kind: 'solid'; color: string } | { kind: 'gradient'; from: string; to: string }; textColor: string; hashtagColor: string }`
  - `interface PaintPolaroidOpts { style: PolaroidStyleId; name: string }`
  - `const POLAROID_STYLES: Record<PolaroidStyleId, PolaroidStyle>`
  - `const POLAROID_STYLE_IDS: PolaroidStyleId[]` (ordered `['classic', 'devtoberfest', 'joule']` — the picker consumes this)
  - `const POLAROID_INSET_FRACTION = 0.05`
  - `const POLAROID_STRIP_FRACTION = 0.22`
  - `function paintPolaroid(composite: HTMLCanvasElement, opts: PaintPolaroidOpts): HTMLCanvasElement`

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/selfie/__tests__/polaroid.test.ts`. happy-dom's canvas has no real 2D context, so the test installs a spy context and a spy `document.createElement('canvas')`. Use this exact scaffold:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  paintPolaroid,
  POLAROID_STYLES,
  POLAROID_STYLE_IDS,
  POLAROID_INSET_FRACTION,
  POLAROID_STRIP_FRACTION,
} from '../polaroid'

// A spy 2D context capturing the calls paintPolaroid makes.
function makeCtx() {
  const grad = { addColorStop: vi.fn() }
  return {
    fillStyle: '' as string | CanvasGradient,
    font: '',
    textAlign: '' as CanvasTextAlign,
    textBaseline: '' as CanvasTextBaseline,
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    createLinearGradient: vi.fn(() => grad),
    measureText: vi.fn((t: string) => ({ width: t.length * 10 })),
    _grad: grad,
  }
}

// Build a composite "canvas": a plain object with width/height and a
// getContext returning our spy. paintPolaroid allocates its OUTPUT canvas via
// document.createElement('canvas'); we stub that to return a controllable node.
let outCtx: ReturnType<typeof makeCtx>
let outCanvas: any
let ctxIsNull = false

beforeEach(() => {
  outCtx = makeCtx()
  ctxIsNull = false
  outCanvas = { width: 0, height: 0, getContext: vi.fn(() => (ctxIsNull ? null : outCtx)) }
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') return outCanvas as unknown as HTMLElement
    return {} as HTMLElement
  })
})

function composite(w: number, h: number): HTMLCanvasElement {
  return { width: w, height: h } as unknown as HTMLCanvasElement
}

describe('polaroid style table', () => {
  it('exposes exactly the three styles in order', () => {
    expect(POLAROID_STYLE_IDS).toEqual(['classic', 'devtoberfest', 'joule'])
    expect(POLAROID_STYLES.classic.matte).toEqual({ kind: 'solid', color: '#ffffff' })
    expect(POLAROID_STYLES.devtoberfest.matte).toEqual({ kind: 'solid', color: '#2b1a0f' })
    expect(POLAROID_STYLES.joule.matte).toEqual({ kind: 'gradient', from: '#e2337f', to: '#7d4bd6' })
    expect(POLAROID_INSET_FRACTION).toBe(0.05)
    expect(POLAROID_STRIP_FRACTION).toBe(0.22)
  })
})

describe('paintPolaroid geometry', () => {
  it('grows the canvas: W = cw + 2*inset, H = ch + inset + strip', () => {
    // cw=ch=1000 → m=1000, inset=round(50)=50, strip=round(220)=220
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: '' })
    expect(outCanvas.width).toBe(1100)  // 1000 + 2*50
    expect(outCanvas.height).toBe(1270) // 1000 + 50 + 220
  })

  it('draws the composite 1:1 at (inset, inset) with no scale args', () => {
    const c = composite(1000, 1000)
    paintPolaroid(c, { style: 'classic', name: '' })
    expect(outCtx.drawImage).toHaveBeenCalledWith(c, 50, 50)
  })

  it('uses the shorter edge for proportions on a non-square composite', () => {
    // cw=800, ch=1200 → m=800, inset=40, strip=176
    paintPolaroid(composite(800, 1200), { style: 'classic', name: '' })
    expect(outCanvas.width).toBe(880)   // 800 + 2*40
    expect(outCanvas.height).toBe(1416) // 1200 + 40 + 176
    expect(outCtx.drawImage).toHaveBeenCalledWith(expect.anything(), 40, 40)
  })
})

describe('paintPolaroid matte', () => {
  it('solid style fills a solid rect (no gradient)', () => {
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: '' })
    expect(outCtx.createLinearGradient).not.toHaveBeenCalled()
    expect(outCtx.fillRect).toHaveBeenCalledWith(0, 0, 1100, 1270)
  })

  it('gradient style builds a vertical top→bottom gradient with both stops', () => {
    paintPolaroid(composite(1000, 1000), { style: 'joule', name: '' })
    expect(outCtx.createLinearGradient).toHaveBeenCalledWith(0, 0, 0, 1270)
    expect(outCtx._grad.addColorStop).toHaveBeenCalledWith(0, '#e2337f')
    expect(outCtx._grad.addColorStop).toHaveBeenCalledWith(1, '#7d4bd6')
  })
})

describe('paintPolaroid text', () => {
  it('draws the name, hashtag and lockup when a name is given', () => {
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: 'Tom' })
    const texts = outCtx.fillText.mock.calls.map((c) => c[0])
    expect(texts).toContain('Tom')
    expect(texts).toContain('#Devtoberfest')
    expect(texts).toContain('SAP Developers')
  })

  it('omits the name line when the name is blank, but still draws hashtag + lockup', () => {
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: '   ' })
    const texts = outCtx.fillText.mock.calls.map((c) => c[0])
    expect(texts).not.toContain('   ')
    expect(texts).toContain('#Devtoberfest')
    expect(texts).toContain('SAP Developers')
  })

  it('truncates a long name with an ellipsis so it fits the strip', () => {
    const long = 'X'.repeat(500)
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: long })
    const drawn = outCtx.fillText.mock.calls.map((c) => c[0] as string).find((t) => t.startsWith('X'))
    expect(drawn).toBeDefined()
    expect(drawn!.length).toBeLessThan(long.length)
    expect(drawn!.endsWith('…')).toBe(true)
  })
})

describe('paintPolaroid fail-soft', () => {
  it('returns the original composite unchanged when the 2D context is null', () => {
    ctxIsNull = true
    const c = composite(1000, 1000)
    const out = paintPolaroid(c, { style: 'classic', name: 'Tom' })
    expect(out).toBe(c)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/polaroid.test.ts`
Expected: FAIL — cannot resolve `../polaroid` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `hugo-apps/src/selfie/polaroid.ts`. No semicolons, LF endings. The algorithm follows the spec exactly:

```ts
// Branded polaroid matte for the Devtoberfest selfie composer (#1518).
// Pure Canvas-2D: draws a matte border + the inset composite + a text strip
// onto a larger offscreen canvas. The Konva stage is never touched.

export type PolaroidStyleId = 'classic' | 'devtoberfest' | 'joule'

export interface PolaroidStyle {
  id: PolaroidStyleId
  label: string
  matte:
    | { kind: 'solid'; color: string }
    | { kind: 'gradient'; from: string; to: string }
  textColor: string
  hashtagColor: string
}

export interface PaintPolaroidOpts {
  style: PolaroidStyleId
  name: string
}

// Side + top inset and bottom-strip height, as fractions of the composite's
// shorter edge. Shared verbatim with the CSS preview matte (styles.css).
export const POLAROID_INSET_FRACTION = 0.05
export const POLAROID_STRIP_FRACTION = 0.22

// The hashtag + lockup copy, drawn into every matte.
const HASHTAG = '#Devtoberfest'
const LOCKUP = 'SAP Developers'

export const POLAROID_STYLES: Record<PolaroidStyleId, PolaroidStyle> = {
  classic: {
    id: 'classic', label: 'Classic White',
    matte: { kind: 'solid', color: '#ffffff' },
    textColor: '#1d2d3e', hashtagColor: '#0070f2',
  },
  devtoberfest: {
    id: 'devtoberfest', label: 'Devtoberfest',
    matte: { kind: 'solid', color: '#2b1a0f' },
    textColor: '#f5e6d3', hashtagColor: '#e8791a',
  },
  joule: {
    id: 'joule', label: 'Joule',
    matte: { kind: 'gradient', from: '#e2337f', to: '#7d4bd6' },
    textColor: '#ffffff', hashtagColor: '#ffffff',
  },
}

// Picker order — the control renders styles in this sequence.
export const POLAROID_STYLE_IDS: PolaroidStyleId[] = ['classic', 'devtoberfest', 'joule']

// Shrink text to fit maxWidth, appending an ellipsis. Returns '' for blank
// input. Uses ctx.measureText so it respects the actual font metrics.
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const t = text.trim()
  if (!t) return ''
  if (ctx.measureText(t).width <= maxWidth) return t
  let s = t
  while (s.length > 0 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1)
  }
  return s.length > 0 ? s + '…' : '…'
}

export function paintPolaroid(composite: HTMLCanvasElement, opts: PaintPolaroidOpts): HTMLCanvasElement {
  const cw = composite.width
  const ch = composite.height
  const m = Math.min(cw, ch)
  const inset = Math.round(POLAROID_INSET_FRACTION * m)
  const strip = Math.round(POLAROID_STRIP_FRACTION * m)
  const W = cw + 2 * inset
  const H = ch + inset + strip

  const out = document.createElement('canvas')
  out.width = W
  out.height = H
  const ctx = out.getContext('2d')
  // Fail-soft: no 2D context → hand back the untouched composite (border skipped).
  if (!ctx) return composite

  const style = POLAROID_STYLES[opts.style] ?? POLAROID_STYLES.classic

  // 1. Matte fill over the whole output.
  if (style.matte.kind === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, style.matte.from)
    g.addColorStop(1, style.matte.to)
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = style.matte.color
  }
  ctx.fillRect(0, 0, W, H)

  // 2. Composite drawn 1:1 (no scale args) — photo pixels preserved (AC #6).
  ctx.drawImage(composite, inset, inset)

  // 3. Bottom strip text. Sizes are fractions of the strip height.
  const stripTop = ch + inset
  const nameSize = Math.round(strip * 0.30)
  const metaSize = Math.round(strip * 0.24)
  const avail = W - 2 * inset

  // Name (bold) in the upper third of the strip — omitted if blank.
  ctx.textBaseline = 'alphabetic'
  ctx.font = `bold ${nameSize}px sans-serif`
  const name = fitText(ctx, opts.name, avail)
  if (name) {
    ctx.fillStyle = style.textColor
    ctx.textAlign = 'left'
    ctx.fillText(name, inset, stripTop + nameSize + Math.round(strip * 0.06))
  }

  // Hashtag (accent) on the lower baseline, left. Lockup (bold) right-aligned.
  const metaBaseline = stripTop + strip - Math.round(strip * 0.22)
  ctx.font = `bold ${metaSize}px sans-serif`
  ctx.fillStyle = style.hashtagColor
  ctx.textAlign = 'left'
  ctx.fillText(HASHTAG, inset, metaBaseline)

  ctx.fillStyle = style.textColor
  ctx.textAlign = 'right'
  ctx.fillText(LOCKUP, W - inset, metaBaseline)

  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/polaroid.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/polaroid.ts hugo-apps/src/selfie/__tests__/polaroid.test.ts
git commit -m "feat(#1518): polaroid.ts style table + paintPolaroid matte bake"
```

---

### Task 2: `compose.ts` — `exportPng({ border })` wiring

**Files:**
- Modify: `hugo-apps/src/selfie/compose.ts` (the `SelfieStage` interface `exportPng` signature + the `exportPng()` implementation returned by `buildStage`)
- Test: `hugo-apps/src/selfie/__tests__/compose.test.ts` (extend)

**Interfaces:**
- Consumes: `paintPolaroid`, `PolaroidStyleId` from `./polaroid` (Task 1).
- Produces: `exportPng(border?: { style: PolaroidStyleId; name: string }): Promise<Blob>` on the `SelfieStage` interface — Task 4 (`Composer.vue`) calls it with `{ style, name }`.

**Context for the implementer:** The current `exportPng()` (in the object returned by `buildStage`) is:

```ts
exportPng() {
  return new Promise<Blob>((resolve, reject) => {
    overlay.deselect()
    const cutoutTVisible = transformer.visible()
    transformer.hide()
    const overlayTVisible = overlay.hideTransformer()
    cutoutLayer.batchDraw()
    overlaysLayer.batchDraw()
    stage.toBlob({
      mimeType: 'image/png',
      callback: (b: Blob | null) => {
        if (cutoutTVisible) transformer.show()
        if (overlayTVisible) overlay.showTransformer()
        cutoutLayer.batchDraw()
        overlaysLayer.batchDraw()
        b ? resolve(b) : reject(new Error('export failed'))
      },
    })
  })
}
```

The deselect + hide-both-transformers + restore sequence must be preserved exactly. When `border` is present, instead of `stage.toBlob`, grab the composite via `stage.toCanvas()`, run it through `paintPolaroid`, then convert the returned canvas to a blob with `canvas.toBlob(...)`. The `SelfieStage` TS interface's `exportPng` member signature must also gain the optional arg.

- [ ] **Step 1: Write the failing test**

Extend `hugo-apps/src/selfie/__tests__/compose.test.ts`. First, the konva mock's `Stage` class must gain a `toCanvas` method (it currently only has `toBlob`). Add to the `Stage` class in the `vi.mock('konva', …)` block:

```ts
    // Returns a fake composite canvas whose toBlob yields a border-sized blob.
    toCanvas = vi.fn(() => ({
      width: this._w,
      height: this._h,
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['bordered-png-larger'], { type: 'image/png' })),
    }))
```

Then mock `../polaroid` near the top of the file (after the konva mock), so the test controls what `paintPolaroid` returns and can assert it was called:

```ts
const paintPolaroidMock = vi.fn((composite: any) => ({
  width: composite.width + 100,
  height: composite.height + 270,
  toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'.repeat(5000)], { type: 'image/png' })),
}))
vi.mock('../polaroid', () => ({
  paintPolaroid: (c: any, o: any) => paintPolaroidMock(c, o),
  POLAROID_STYLES: {}, POLAROID_STYLE_IDS: ['classic', 'devtoberfest', 'joule'],
}))
```

Add `paintPolaroidMock.mockClear()` to the existing `beforeEach`. Then add these test cases inside `describe('compose.buildStage', …)`:

```ts
  it('exportPng() with no border does NOT invoke paintPolaroid and still returns a blob', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng()
    expect(out).toBeInstanceOf(Blob)
    expect(paintPolaroidMock).not.toHaveBeenCalled()
  })

  it('exportPng({ border }) routes the composite canvas through paintPolaroid', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng({ style: 'joule', name: 'Tom' })
    expect(out).toBeInstanceOf(Blob)
    expect(paintPolaroidMock).toHaveBeenCalledTimes(1)
    // forwarded opts
    expect(paintPolaroidMock.mock.calls[0][1]).toEqual({ style: 'joule', name: 'Tom' })
  })

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
    await stage.exportPng({ style: 'classic', name: '' })
    expect(allHiddenAtBake).toBe(true)
    expect(transformers.every((t) => t.visible())).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: FAIL — `exportPng({border})` does not call `paintPolaroid` yet (mock never invoked); the `toCanvas`/border branch does not exist.

- [ ] **Step 3: Write minimal implementation**

In `hugo-apps/src/selfie/compose.ts`:

1. Add the import at the top (alongside existing imports):

```ts
import { paintPolaroid, type PolaroidStyleId } from './polaroid'
```

2. Update the `SelfieStage` interface's `exportPng` member to:

```ts
  exportPng(border?: { style: PolaroidStyleId; name: string }): Promise<Blob>
```

3. Replace the `exportPng()` method in the object returned by `buildStage` with the border-aware version. It preserves the exact deselect + hide-both + restore sequence and only forks at rasterization:

```ts
    exportPng(border?: { style: PolaroidStyleId; name: string }) {
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
        if (border) {
          try {
            const composite = stage.toCanvas() as HTMLCanvasElement
            const bordered = paintPolaroid(composite, border)
            bordered.toBlob((b: Blob | null) => {
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
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: PASS (existing cases + 3 new).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/compose.ts hugo-apps/src/selfie/__tests__/compose.test.ts
git commit -m "feat(#1518): exportPng(border) routes composite through paintPolaroid"
```

---

### Task 3: `PolaroidControls.vue` — toggle + style picker + name field

**Files:**
- Create: `hugo-apps/src/selfie/PolaroidControls.vue`
- Test: `hugo-apps/src/selfie/__tests__/PolaroidControls.test.ts`

**Interfaces:**
- Consumes: `POLAROID_STYLES`, `POLAROID_STYLE_IDS`, `type PolaroidStyleId` from `./polaroid` (Task 1).
- Produces: a component with props `{ enabled: boolean; style: PolaroidStyleId; name: string }` and emits `update:enabled` (boolean), `update:style` (`PolaroidStyleId`), `update:name` (string). Task 4 (`Composer.vue`) mounts it with `v-model`-style bindings.

**Context:** Match the existing selfie toolbar style — `<script setup lang="ts">`, no semicolons, `data-testid` attributes for tests, `.selfie-*` CSS classes. The style picker only shows when `enabled` is true. Use `POLAROID_STYLE_IDS` to render the buttons in order, labels from `POLAROID_STYLES[id].label`. The name field only shows when `enabled` is true.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/selfie/__tests__/PolaroidControls.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PolaroidControls from '../PolaroidControls.vue'

const base = { enabled: false, style: 'classic' as const, name: '' }

describe('PolaroidControls.vue', () => {
  it('toggling the border checkbox emits update:enabled', async () => {
    const w = mount(PolaroidControls, { props: base })
    const cb = w.find('[data-testid="border-toggle"]')
    ;(cb.element as HTMLInputElement).checked = true
    await cb.trigger('change')
    expect(w.emitted('update:enabled')?.[0]?.[0]).toBe(true)
  })

  it('hides the style picker and name field until enabled', async () => {
    const w = mount(PolaroidControls, { props: base })
    expect(w.find('[data-testid="border-style-joule"]').exists()).toBe(false)
    expect(w.find('[data-testid="border-name"]').exists()).toBe(false)
    await w.setProps({ enabled: true })
    expect(w.find('[data-testid="border-style-joule"]').exists()).toBe(true)
    expect(w.find('[data-testid="border-name"]').exists()).toBe(true)
  })

  it('shows all three styles and emits update:style on pick', async () => {
    const w = mount(PolaroidControls, { props: { ...base, enabled: true } })
    for (const id of ['classic', 'devtoberfest', 'joule']) {
      expect(w.find(`[data-testid="border-style-${id}"]`).exists()).toBe(true)
    }
    await w.find('[data-testid="border-style-devtoberfest"]').trigger('click')
    expect(w.emitted('update:style')?.[0]?.[0]).toBe('devtoberfest')
  })

  it('typing in the name field emits update:name', async () => {
    const w = mount(PolaroidControls, { props: { ...base, enabled: true } })
    const field = w.find('[data-testid="border-name"]')
    ;(field.element as HTMLInputElement).value = 'Tom'
    await field.trigger('input')
    expect(w.emitted('update:name')?.[0]?.[0]).toBe('Tom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/PolaroidControls.test.ts`
Expected: FAIL — cannot resolve `../PolaroidControls.vue`.

- [ ] **Step 3: Write minimal implementation**

Create `hugo-apps/src/selfie/PolaroidControls.vue`. No semicolons, LF:

```vue
<script setup lang="ts">
import { POLAROID_STYLES, POLAROID_STYLE_IDS, type PolaroidStyleId } from './polaroid'

const props = defineProps<{
  enabled: boolean
  style: PolaroidStyleId
  name: string
}>()
const emit = defineEmits<{
  'update:enabled': [value: boolean]
  'update:style': [value: PolaroidStyleId]
  'update:name': [value: string]
}>()

const styles = POLAROID_STYLE_IDS.map((id) => ({ id, label: POLAROID_STYLES[id].label }))
</script>
<template>
  <div class="selfie-polaroid-controls">
    <label class="selfie-toggle">
      <input
        type="checkbox" :checked="enabled" data-testid="border-toggle"
        @change="emit('update:enabled', ($event.target as HTMLInputElement).checked)"
      />
      Polaroid border
    </label>
    <template v-if="enabled">
      <div class="selfie-polaroid-styles" role="group" aria-label="Border style">
        <button
          v-for="s in styles" :key="s.id" type="button"
          class="selfie-btn selfie-polaroid-style"
          :class="{ 'is-active': s.id === style }"
          :data-testid="`border-style-${s.id}`"
          :aria-pressed="s.id === style"
          @click="emit('update:style', s.id)"
        >{{ s.label }}</button>
      </div>
      <input
        type="text" class="selfie-caption-input" data-testid="border-name"
        :value="name" placeholder="Your name (optional)"
        @input="emit('update:name', ($event.target as HTMLInputElement).value)"
      />
    </template>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/PolaroidControls.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/PolaroidControls.vue hugo-apps/src/selfie/__tests__/PolaroidControls.test.ts
git commit -m "feat(#1518): PolaroidControls toggle + style picker + name field"
```

---

### Task 4: `Composer.vue` — wire controls, CSS preview, export forwarding + `styles.css`

**Files:**
- Modify: `hugo-apps/src/selfie/Composer.vue`
- Modify: `hugo-apps/src/selfie/styles.css`
- Test: `hugo-apps/src/selfie/__tests__/Composer.test.ts` (extend)

**Interfaces:**
- Consumes: `PolaroidControls.vue` (Task 3); `exportPng(border?)` (Task 2); `POLAROID_STYLES` for the CSS preview colors (Task 1).
- Produces: no new outward interface — this is the top of the feature.

**Context:** `Composer.vue` currently owns the stage and toolbar (read the file). Add three refs: `borderEnabled = ref(false)`, `borderStyle = ref<PolaroidStyleId>('classic')`, `borderName = ref('')`. Render `<PolaroidControls>` in the `.selfie-editor-toolbar` bound to these refs. In `doExport()`, pass `{ style: borderStyle.value, name: borderName.value }` to `exportPng()` **only when `borderEnabled.value` is true**; otherwise call `exportPng()` with no arg. Wrap the stage in a preview matte div that gets a live style class + inline background when the border is enabled, so the user sees the matte before export. The preview is decorative — the authoritative bake is `paintPolaroid`.

The Composer test mock of `../compose` (see the `vi.hoisted` block) must have its `exportPng` assertable for args — it already is (`h.exportPng`). No change needed to the mock beyond what exists.

- [ ] **Step 1: Write the failing test**

Extend `hugo-apps/src/selfie/__tests__/Composer.test.ts`. Add these cases inside `describe('Composer.vue', …)`:

```ts
  it('shows the polaroid preview matte only when the border is enabled', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    expect(w.find('[data-testid="polaroid-preview"]').classes()).not.toContain('is-bordered')
    // enable via the controls' toggle
    const cb = w.find('[data-testid="border-toggle"]')
    ;(cb.element as HTMLInputElement).checked = true
    await cb.trigger('change')
    await flushPromises()
    expect(w.find('[data-testid="polaroid-preview"]').classes()).toContain('is-bordered')
  })

  it('export with border OFF calls exportPng with no border arg', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith()
  })

  it('export with border ON forwards the current { style, name } to exportPng', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    // enable border
    const cb = w.find('[data-testid="border-toggle"]')
    ;(cb.element as HTMLInputElement).checked = true
    await cb.trigger('change')
    await flushPromises()
    // pick a style
    await w.find('[data-testid="border-style-joule"]').trigger('click')
    // type a name
    const nameField = w.find('[data-testid="border-name"]')
    ;(nameField.element as HTMLInputElement).value = 'Tom'
    await nameField.trigger('input')
    // export
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith({ style: 'joule', name: 'Tom' })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/Composer.test.ts`
Expected: FAIL — no `[data-testid="polaroid-preview"]` / `border-toggle` yet; `exportPng` called with no arg in all cases.

- [ ] **Step 3: Write minimal implementation**

In `hugo-apps/src/selfie/Composer.vue`:

1. Imports — add:

```ts
import PolaroidControls from './PolaroidControls.vue'
import { POLAROID_STYLES, type PolaroidStyleId } from './polaroid'
```

2. After the existing `captionText` ref, add:

```ts
const borderEnabled = ref(false)
const borderStyle = ref<PolaroidStyleId>('classic')
const borderName = ref('')

// Live preview matte background — mirrors POLAROID_STYLES so the on-screen
// matte matches the baked export. Decorative only; paintPolaroid is authoritative.
const previewMatte = computed(() => {
  const s = POLAROID_STYLES[borderStyle.value]
  return s.matte.kind === 'gradient'
    ? `linear-gradient(${s.matte.from}, ${s.matte.to})`
    : s.matte.color
})
```

Add `computed` to the `vue` import on line 1 (`import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'`).

3. Replace `doExport()` with:

```ts
async function doExport() {
  if (!stage) return emit('fallback', effectiveBlob())
  try {
    const border = borderEnabled.value ? { style: borderStyle.value, name: borderName.value } : undefined
    emit('export', await stage.exportPng(border))
  } catch { emit('fallback', effectiveBlob()) }
}
```

4. Template — wrap the stage div in a preview matte, and add `<PolaroidControls>` to the toolbar. Replace the `.selfie-stage-wrap` block:

```html
    <div class="selfie-stage-wrap">
      <div
        class="selfie-polaroid-preview" data-testid="polaroid-preview"
        :class="{ 'is-bordered': borderEnabled }"
        :style="borderEnabled ? { background: previewMatte } : undefined"
      >
        <div ref="stageEl" class="selfie-stage"></div>
      </div>
      <p v-if="segmenting" class="selfie-stage-overlay" role="status">Removing the background&hellip;</p>
    </div>
```

And add `<PolaroidControls>` inside `.selfie-editor-toolbar` (after the `<StickerPicker>` line is fine):

```html
      <PolaroidControls
        :enabled="borderEnabled" :style="borderStyle" :name="borderName"
        @update:enabled="borderEnabled = $event"
        @update:style="borderStyle = $event"
        @update:name="borderName = $event"
      />
```

5. In `hugo-apps/src/selfie/styles.css`, append (using the same inset/strip proportions as `POLAROID_STYLES`; the matte background is applied inline from JS so only layout lives here):

```css
/* ---- Polaroid border preview (matte around the Konva stage) ---- */
.selfie-polaroid-preview { display: inline-block; line-height: 0; }
.selfie-polaroid-preview.is-bordered {
  padding: 5% 5% 22%; border-radius: 4px;
  box-shadow: 0 2px 12px rgba(0,0,0,.25);
}
.selfie-polaroid-controls { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.selfie-polaroid-styles { display: inline-flex; gap: .35rem; }
.selfie-polaroid-style { background: var(--sapButton_Background, #fff); color: var(--sapButton_TextColor, #0070f2); border: 1px solid var(--sapButton_BorderColor, #0070f2); }
.selfie-polaroid-style.is-active { background: var(--sapButton_Emphasized_Background, #0070f2); color: #fff; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/Composer.test.ts`
Expected: PASS (existing cases + 3 new).

- [ ] **Step 5: Run the full selfie suite to confirm no regressions**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/`
Expected: All pass EXCEPT the pre-existing `segment.test.ts` env failure (missing `@imgly/background-removal`) — that one is out of scope and must NOT be "fixed".

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/selfie/Composer.vue hugo-apps/src/selfie/styles.css hugo-apps/src/selfie/__tests__/Composer.test.ts
git commit -m "feat(#1518): Composer wires PolaroidControls, preview matte, export forwarding"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| `polaroid.ts` exports style table + constants + `paintPolaroid` | Task 1 |
| `paintPolaroid` grows canvas, draws 1:1, solid/gradient, name/hashtag/lockup, truncation, null-ctx fail-soft | Task 1 |
| `PolaroidControls.vue` toggle + 3-way picker + name, emits | Task 3 |
| `compose.ts` `exportPng({border})` routes through `paintPolaroid`, preserves transformer sequence | Task 2 |
| `Composer.vue` owns refs, renders controls, CSS preview, forwards `{style,name}` | Task 4 |
| `styles.css` preview matte classes | Task 4 |
| Tests: `polaroid.test.ts`, `compose.test.ts` ext, `PolaroidControls.test.ts`, `Composer.test.ts` ext | Tasks 1–4 |
| AC #1–#4, #6, #7 | covered; AC #5 superseded by Tom's decision (documented in spec) |

No gaps.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step has full content.

**3. Type consistency:** `PolaroidStyleId`, `PaintPolaroidOpts`, `POLAROID_STYLES`, `POLAROID_STYLE_IDS`, `POLAROID_INSET_FRACTION`, `POLAROID_STRIP_FRACTION`, `paintPolaroid` — defined in Task 1, consumed with identical names/signatures in Tasks 2–4. `exportPng(border?: { style: PolaroidStyleId; name: string })` — defined in Task 2, called identically in Task 4. Consistent.

# Selfie Stickers & Captions (#1517) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add draggable stickers (curated PNGs + emoji) and a single editable text caption to the selfie composer; all overlays bake into the exported PNG.

**Architecture:** A new `overlays.ts` `OverlayManager` module owns a dynamic overlays Konva layer with a shared `Transformer`. `compose.ts` composes it into `buildStage` and re-exports its methods on `SelfieStage`. `Composer.vue` gains a `StickerPicker` palette and toolbar caption/delete controls; caption text is edited via a toolbar field (not a canvas-overlaid input). The Tier-1 photo/frame/cutout logic is untouched except that `exportPng` now deselects overlays and hides both transformers before rasterizing.

**Tech Stack:** Vue 3 (`<script setup lang="ts">`), Konva, Vite, Vitest + @vue/test-utils + happy-dom.

## Global Constraints

- **Fail-soft always** — the island must never crash the page. A sticker PNG that 404s/fails to decode is skipped with `console.warn`; stage-absent method calls are guarded no-ops; export inherits the Tier-1 plain-download fallback.
- **Privacy** — all processing stays in-browser; no overlay work sends anything off-device.
- **Caption is a singleton** — at most one caption node exists at a time; a second `addCaption` re-selects the existing one; deleting it lets it be re-added.
- **Generic caption placeholder** — `#Devtoberfest`; NO advocate-name derivation from frame filenames.
- **Konva.Transformer only** — no custom two-finger pinch/twist gestures. No font/color/size caption pickers.
- **Export bake-in safety** — before `toBlob`, deselect overlays and hide BOTH the cutout transformer (existing) and the overlay transformer; restore both after. No selection handles may bake into the PNG.
- **Test env** — happy-dom does NOT fire `<img>` onload for object/`blob:` URLs; stub global `Image` in `beforeEach` (resolve `onload` on a microtask) for any test whose code path calls `blobToImage()`.
- **Run selfie unit tests from repo root:** `npx vitest run --project unit hugo-apps/src/selfie/`. CI build gate: `npm run build --prefix hugo-apps`.
- **Match existing code style** — `<script setup lang="ts">`, 2-space indent, no semicolons (follow `Composer.vue`/`FramePicker.vue`), Horizon CSS tokens with fallbacks (follow `styles.css`).

---

### Task 1: `stickers.ts` — pure data module

**Files:**
- Create: `hugo-apps/src/selfie/stickers.ts`
- Test: `hugo-apps/src/selfie/__tests__/stickers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface StickerDef { name: string; file: string }`
  - `parseStickerList(csv: string): StickerDef[]` — split on `,`, trim, drop blanks; `name === file` (bare basename, no extension), consumer builds the URL as `${imgBase}/stickers/${file}.png`.
  - `const EMOJI: readonly string[]`
  - `const CAPTION_PLACEHOLDER = '#Devtoberfest'`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { parseStickerList, EMOJI, CAPTION_PLACEHOLDER } from '../stickers'

describe('stickers data', () => {
  it('parses a CSV frame list, trimming and dropping blanks', () => {
    expect(parseStickerList(' pumpkin , confetti ,, star ')).toEqual([
      { name: 'pumpkin', file: 'pumpkin' },
      { name: 'confetti', file: 'confetti' },
      { name: 'star', file: 'star' },
    ])
  })
  it('returns an empty array for an empty string', () => {
    expect(parseStickerList('')).toEqual([])
  })
  it('ships a non-empty emoji set of single-glyph strings', () => {
    expect(EMOJI.length).toBeGreaterThan(0)
    expect(EMOJI.every((e) => typeof e === 'string' && e.length > 0)).toBe(true)
  })
  it('uses the generic Devtoberfest caption placeholder', () => {
    expect(CAPTION_PLACEHOLDER).toBe('#Devtoberfest')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/stickers.test.ts`
Expected: FAIL — cannot resolve `../stickers`.

- [ ] **Step 3: Write minimal implementation**

```ts
// hugo-apps/src/selfie/stickers.ts
export interface StickerDef {
  name: string
  file: string // basename under `${imgBase}/stickers/`; URL is `${imgBase}/stickers/${file}.png`
}

/** Split a comma-separated sticker list (from `data-stickers`), trim, drop blanks. */
export function parseStickerList(csv: string): StickerDef[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, file: name }))
}

/** A fixed, fun emoji set rendered as Konva.Text glyphs (predictable across OSes). */
export const EMOJI: readonly string[] = [
  '🎃', '🎉', '⭐', '🧡', '💻', '🚀', '👋', '🙌', '🔥', '❤️', '✨', '🏆',
]

/** Generic caption seed text — no advocate-name guessing. */
export const CAPTION_PLACEHOLDER = '#Devtoberfest'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/stickers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/stickers.ts hugo-apps/src/selfie/__tests__/stickers.test.ts
git commit -m "feat(#1517): selfie sticker/emoji/caption data module"
```

---

### Task 2: `overlays.ts` — OverlayManager

**Files:**
- Create: `hugo-apps/src/selfie/overlays.ts`
- Test: `hugo-apps/src/selfie/__tests__/overlays.test.ts`

**Interfaces:**
- Consumes: `Konva` (`Stage`, `Layer`, `Image`, `Text`, `Transformer`).
- Produces:
  - `type OverlayKind = 'none' | 'sticker' | 'caption'`
  - `createOverlayManager(stage: Konva.Stage, layer: Konva.Layer): OverlayManager`
  - `OverlayManager` methods: `addSticker(img)`, `addEmoji(char)`, `addCaption(text)`, `updateCaption(text)`, `hasCaption()`, `selectedIsCaption()`, `deleteSelected()`, `deselect()`, `onSelectionChange(cb)`, `hideTransformer()` (returns prior visibility bool), `showTransformer()`, `destroy()`.

**Design notes for the implementer:**
- One shared `Konva.Transformer` added to `layer`. `select(node)` → `transformer.nodes([node])` + fire the selection-change callback with the node's kind; `deselect()` → `transformer.nodes([])` + fire `'none'`.
- Tag each node's kind via `node.setAttr('data-kind', 'sticker'|'caption')` and read it back with `node.getAttr('data-kind')` — do NOT rely on `instanceof` (the emoji caption and text share `Konva.Text`).
- Each overlay node: `draggable: true`, centered on the stage on add (`x = stageW/2`, `y = stageH/2`, with `offsetX/offsetY` half of its own size, or for images set `x/y` to center of the contain box — keep it simple: place at center using `x: stage.width()/2, y: stage.height()/2` and set the node's `offset` to half its width/height so it centers on that point).
- Node `on('click tap', (e) => { e.cancelBubble = true; select(node) })` so overlay taps don't fall through to the cutout beneath.
- Stage `on('click tap', (e) => { if (e.target === stage) deselect() })`.
- Caption singleton: keep `let captionNode: Konva.Text | null`. `addCaption` when `captionNode` exists → just `select(captionNode)`. `deleteSelected` on the caption → destroy node, set `captionNode = null`.
- `updateCaption(text)` → if `captionNode` exists, `captionNode.text(text)` + `batchDraw()`; else no-op.
- `selectedIsCaption()` → `selected?.getAttr('data-kind') === 'caption'`.
- Caption `Konva.Text` style: `{ text, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', fontStyle: 'bold', fontSize: Math.round(stage.height() * 0.07), fill: '#ffffff', stroke: '#1d2d3e', strokeWidth: 2, align: 'center', draggable: true }`.
- Emoji `Konva.Text` style: `{ text: char, fontSize: Math.round(stage.height() * 0.15), draggable: true }`.
- `hideTransformer()` returns the transformer's prior `visible()` and hides it; `showTransformer()` shows it. (Used by compose export.)
- `destroy()` → `transformer.destroy()` (layer is owned/destroyed by the stage).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const transformerNodesCalls: any[][] = []
let lastTransformer: any = null
const textCtorArgs: any[] = []
let stageClickHandler: ((e: any) => void) | null = null

vi.mock('konva', () => {
  class Node {
    attrs: Record<string, any> = {}
    _handlers: Record<string, (e: any) => void> = {}
    _destroyed = false
    setAttr(k: string, v: any) { this.attrs[k] = v; return this }
    getAttr(k: string) { return this.attrs[k] }
    on(evt: string, cb: (e: any) => void) { evt.split(' ').forEach((e) => { this._handlers[e] = cb }); return this }
    offset() { return { x: 0, y: 0 } }
    width() { return 100 } height() { return 100 }
    text(v?: string) { if (v !== undefined) this.attrs.text = v; return this.attrs.text }
    destroy() { this._destroyed = true }
    fire(evt: string, e: any) { this._handlers[evt]?.(e) }
  }
  class KImage extends Node { constructor(cfg?: any) { super(); Object.assign(this.attrs, cfg) } }
  class KText extends Node { constructor(cfg?: any) { super(); textCtorArgs.push(cfg); Object.assign(this.attrs, cfg) } }
  class Layer { add = vi.fn(); draw = vi.fn(); batchDraw = vi.fn() }
  class Stage {
    _handlers: Record<string, (e: any) => void> = {}
    add = vi.fn()
    width() { return 1080 } height() { return 1080 }
    on(evt: string, cb: (e: any) => void) { evt.split(' ').forEach((e) => { this._handlers[e] = cb }); if (evt.includes('click')) stageClickHandler = cb }
    fire(evt: string, e: any) { this._handlers[evt]?.(e) }
  }
  class Transformer extends Node {
    _visible = true
    constructor() { super(); lastTransformer = this }
    nodes(v?: any[]) { if (v !== undefined) transformerNodesCalls.push(v); return v }
    visible() { return this._visible }
    hide() { this._visible = false } show() { this._visible = true }
  }
  const K = { Stage, Layer, Image: KImage, Text: KText, Transformer, Node }
  return { default: K, ...K }
})

import Konva from 'konva'
import { createOverlayManager } from '../overlays'

function fakeImg(): HTMLImageElement {
  return { naturalWidth: 200, naturalHeight: 200, width: 200, height: 200 } as unknown as HTMLImageElement
}
function build() {
  const stage = new (Konva as any).Stage()
  const layer = new (Konva as any).Layer()
  return { stage, layer, mgr: createOverlayManager(stage, layer) }
}

beforeEach(() => {
  transformerNodesCalls.length = 0
  textCtorArgs.length = 0
  lastTransformer = null
  stageClickHandler = null
})

describe('OverlayManager', () => {
  it('adds a sticker, adds it to the layer, and selects it', () => {
    const { layer, mgr } = build()
    mgr.addSticker(fakeImg())
    expect(layer.add).toHaveBeenCalled()
    // last transformer.nodes([]) call has exactly one node (the sticker)
    expect(transformerNodesCalls.at(-1)).toHaveLength(1)
  })

  it('adds an emoji as a Text glyph and selects it', () => {
    const { mgr } = build()
    mgr.addEmoji('🎃')
    expect(textCtorArgs.at(-1).text).toBe('🎃')
    expect(transformerNodesCalls.at(-1)).toHaveLength(1)
  })

  it('caption is a singleton — a second addCaption reselects, does not duplicate', () => {
    const { mgr } = build()
    mgr.addCaption('#Devtoberfest')
    const captionTextNodes = textCtorArgs.filter((c) => c.fontStyle === 'bold').length
    mgr.addCaption('#Devtoberfest')
    const after = textCtorArgs.filter((c) => c.fontStyle === 'bold').length
    expect(captionTextNodes).toBe(1)
    expect(after).toBe(1) // no new caption node constructed
    expect(mgr.hasCaption()).toBe(true)
  })

  it('updateCaption mutates the caption text; no-op when no caption', () => {
    const { mgr } = build()
    expect(() => mgr.updateCaption('later')).not.toThrow() // no caption yet
    mgr.addCaption('#Devtoberfest')
    mgr.updateCaption('I met an advocate!')
    expect(mgr.selectedIsCaption()).toBe(true)
  })

  it('deleteSelected removes the node and clears hasCaption for a caption', () => {
    const { mgr } = build()
    mgr.addCaption('#Devtoberfest')
    expect(mgr.hasCaption()).toBe(true)
    mgr.deleteSelected()
    expect(mgr.hasCaption()).toBe(false)
    expect(transformerNodesCalls.at(-1)).toHaveLength(0) // deselected
  })

  it('clicking empty stage deselects', () => {
    const { stage, mgr } = build()
    mgr.addEmoji('🎉')
    expect(transformerNodesCalls.at(-1)).toHaveLength(1)
    stage.fire('click', { target: stage }) // click empty canvas
    expect(transformerNodesCalls.at(-1)).toHaveLength(0)
  })

  it('onSelectionChange reports the kind on add and deselect', () => {
    const { stage, mgr } = build()
    const kinds: string[] = []
    mgr.onSelectionChange((k) => kinds.push(k))
    mgr.addSticker(fakeImg())
    mgr.addCaption('#Devtoberfest')
    stage.fire('click', { target: stage })
    expect(kinds).toEqual(['sticker', 'caption', 'none'])
  })

  it('hideTransformer returns prior visibility and hides; showTransformer restores', () => {
    const { mgr } = build()
    expect(mgr.hideTransformer()).toBe(true)
    expect(lastTransformer.visible()).toBe(false)
    mgr.showTransformer()
    expect(lastTransformer.visible()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/overlays.test.ts`
Expected: FAIL — cannot resolve `../overlays`.

- [ ] **Step 3: Write minimal implementation**

```ts
// hugo-apps/src/selfie/overlays.ts
import Konva from 'konva'

export type OverlayKind = 'none' | 'sticker' | 'caption'

export interface OverlayManager {
  addSticker(img: HTMLImageElement): void
  addEmoji(char: string): void
  addCaption(text: string): void
  updateCaption(text: string): void
  hasCaption(): boolean
  selectedIsCaption(): boolean
  deleteSelected(): void
  deselect(): void
  onSelectionChange(cb: (kind: OverlayKind) => void): void
  hideTransformer(): boolean
  showTransformer(): void
  destroy(): void
}

export function createOverlayManager(stage: Konva.Stage, layer: Konva.Layer): OverlayManager {
  const transformer = new Konva.Transformer()
  layer.add(transformer)

  let selected: Konva.Node | null = null
  let captionNode: Konva.Text | null = null
  let selectionCb: (kind: OverlayKind) => void = () => {}

  function kindOf(node: Konva.Node | null): OverlayKind {
    if (!node) return 'none'
    return (node.getAttr('data-kind') as OverlayKind) || 'sticker'
  }

  function select(node: Konva.Node) {
    selected = node
    transformer.nodes([node])
    layer.batchDraw()
    selectionCb(kindOf(node))
  }

  function deselect() {
    selected = null
    transformer.nodes([])
    layer.batchDraw()
    selectionCb('none')
  }

  // Deselect when the user taps empty canvas.
  stage.on('click tap', (e: any) => { if (e.target === stage) deselect() })

  function wire(node: Konva.Node, kind: OverlayKind) {
    node.setAttr('data-kind', kind)
    node.on('click tap', (e: any) => { e.cancelBubble = true; select(node) })
    layer.add(node as any)
    select(node)
  }

  function centerOf() { return { x: stage.width() / 2, y: stage.height() / 2 } }

  return {
    addSticker(img: HTMLImageElement) {
      const w = img.naturalWidth || img.width || 200
      const h = img.naturalHeight || img.height || 200
      const scale = Math.min((stage.width() * 0.4) / w, (stage.height() * 0.4) / h, 1)
      const dw = Math.round(w * scale)
      const dh = Math.round(h * scale)
      const c = centerOf()
      const node = new Konva.Image({
        image: img, draggable: true,
        width: dw, height: dh, offsetX: dw / 2, offsetY: dh / 2, x: c.x, y: c.y,
      })
      wire(node, 'sticker')
    },
    addEmoji(char: string) {
      const c = centerOf()
      const node = new Konva.Text({
        text: char, fontSize: Math.round(stage.height() * 0.15),
        draggable: true, x: c.x, y: c.y,
      })
      // Center the glyph on the placement point.
      node.offsetX((node.width?.() || 0) / 2)
      node.offsetY((node.height?.() || 0) / 2)
      wire(node, 'sticker')
    },
    addCaption(text: string) {
      if (captionNode) { select(captionNode); return }
      const c = centerOf()
      const node = new Konva.Text({
        text,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontStyle: 'bold', fontSize: Math.round(stage.height() * 0.07),
        fill: '#ffffff', stroke: '#1d2d3e', strokeWidth: 2, align: 'center',
        draggable: true, x: c.x, y: c.y,
      })
      node.offsetX((node.width?.() || 0) / 2)
      node.offsetY((node.height?.() || 0) / 2)
      captionNode = node
      wire(node, 'caption')
    },
    updateCaption(text: string) {
      if (!captionNode) return
      captionNode.text(text)
      layer.batchDraw()
    },
    hasCaption() { return captionNode !== null },
    selectedIsCaption() { return kindOf(selected) === 'caption' },
    deleteSelected() {
      if (!selected) return
      if (selected === captionNode) captionNode = null
      selected.destroy()
      deselect()
    },
    deselect,
    onSelectionChange(cb) { selectionCb = cb },
    hideTransformer() {
      const prior = transformer.visible()
      transformer.hide()
      return prior
    },
    showTransformer() { transformer.show() },
    destroy() { transformer.destroy() },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/overlays.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/overlays.ts hugo-apps/src/selfie/__tests__/overlays.test.ts
git commit -m "feat(#1517): OverlayManager for stickers, emoji and caption"
```

---

### Task 3: Wire OverlayManager into `compose.ts`

**Files:**
- Modify: `hugo-apps/src/selfie/compose.ts`
- Test: `hugo-apps/src/selfie/__tests__/compose.test.ts` (extend)

**Interfaces:**
- Consumes: `createOverlayManager`, `OverlayKind` from `./overlays`.
- Produces (added to `SelfieStage`): `addSticker(img)`, `addEmoji(char)`, `addCaption(text)`, `updateCaption(text)`, `hasCaption()`, `selectedIsCaption()`, `deleteSelected()`, `deselect()`, `onSelectionChange(cb)`.

**Design notes:**
- Add an `overlaysLayer = new Konva.Layer()` ON TOP of everything (add it LAST so overlays sit above both cutout and frame — stickers/caption should be visible over the decorative frame). Construct `const overlay = createOverlayManager(stage, overlaysLayer)`.
- Re-export the overlay methods on the returned `SelfieStage` object (thin delegates).
- `exportPng`: before `stage.toBlob`, call `overlay.deselect()`, then capture `const cutoutTVisible = transformer.visible(); transformer.hide()` (existing cutout transformer) AND `const overlayTVisible = overlay.hideTransformer()`. In the `toBlob` callback, restore: `if (cutoutTVisible) transformer.show(); if (overlayTVisible) overlay.showTransformer();` then `cutoutLayer.batchDraw(); overlaysLayer.batchDraw()`.
- `destroy()`: also `overlay.destroy()` before `stage.destroy()`.

- [ ] **Step 1: Extend the Konva mock and add failing tests**

In `compose.test.ts`, extend the mocked Konva so `Text`, node `on`, `setAttr`/`getAttr`, and a second `Transformer` instance work. Add to the mock's `KImage`/new `KText` classes an `on`, `setAttr`, `getAttr`, `offsetX`, `offsetY`, `destroy`, and `text` method, and export `Text: KText`. Track ALL transformers in an array `const transformers: any[] = []` (push in the `Transformer` constructor). Then add these tests:

```ts
it('adds a sticker to the overlays layer and re-exports overlay methods', async () => {
  const stage = await buildStage(document.createElement('div'), '/f.png')
  expect(typeof stage.addSticker).toBe('function')
  expect(typeof stage.addCaption).toBe('function')
  stage.addCaption('#Devtoberfest')
  expect(stage.hasCaption()).toBe(true)
})

it('export hides BOTH the cutout and overlay transformers, then restores both', async () => {
  const stage = await buildStage(document.createElement('div'), '/f.png')
  stage.addCutout(fakeImg(1280, 720))
  stage.addEmoji('🎉')
  // both transformers visible before export
  expect(transformers.every((t) => t.visible())).toBe(true)
  let allHiddenAtRasterize = false
  toBlobMock.mockImplementationOnce((opts: any) => {
    allHiddenAtRasterize = transformers.every((t) => !t.visible())
    opts.callback(new Blob(['png'], { type: 'image/png' }))
  })
  await stage.exportPng()
  expect(allHiddenAtRasterize).toBe(true)      // no handles baked in
  expect(transformers.every((t) => t.visible())).toBe(true) // restored
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/compose.test.ts`
Expected: FAIL — `stage.addSticker is not a function` / only one transformer tracked.

- [ ] **Step 3: Implement**

In `compose.ts`:
```ts
import { createOverlayManager, type OverlayKind } from './overlays'
```
Extend the `SelfieStage` interface with the nine overlay methods (types mirror `OverlayManager`). In `buildStage`, after the cutout layer + cutout transformer are set up:
```ts
const overlaysLayer = new Konva.Layer()
stage.add(overlaysLayer) // topmost — overlays sit above cutout and frame
const overlay = createOverlayManager(stage, overlaysLayer)
```
Add delegates to the returned object:
```ts
addSticker: (img) => overlay.addSticker(img),
addEmoji: (char) => overlay.addEmoji(char),
addCaption: (text) => overlay.addCaption(text),
updateCaption: (text) => overlay.updateCaption(text),
hasCaption: () => overlay.hasCaption(),
selectedIsCaption: () => overlay.selectedIsCaption(),
deleteSelected: () => overlay.deleteSelected(),
deselect: () => overlay.deselect(),
onSelectionChange: (cb) => overlay.onSelectionChange(cb),
```
Rewrite `exportPng`'s hide/restore to cover both transformers (per Design notes above). In `destroy`, call `overlay.destroy()` first.

- [ ] **Step 4: Run the full compose + overlays + stickers suite**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/compose.test.ts hugo-apps/src/selfie/__tests__/overlays.test.ts hugo-apps/src/selfie/__tests__/stickers.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/compose.ts hugo-apps/src/selfie/__tests__/compose.test.ts
git commit -m "feat(#1517): compose exposes overlay methods; export bakes overlays"
```

---

### Task 4: `StickerPicker.vue` — palette UI

**Files:**
- Create: `hugo-apps/src/selfie/StickerPicker.vue`
- Test: `hugo-apps/src/selfie/__tests__/StickerPicker.test.ts`

**Interfaces:**
- Consumes: `StickerDef`, `EMOJI` from `./stickers`.
- Props: `{ stickers: StickerDef[]; imgBase: string }`.
- Emits: `add-sticker: [src: string]`, `add-emoji: [char: string]`.

**Design notes:**
- Two tabs: "Brand" (grid of `<img>` thumbnails, `src` = `${imgBase}/stickers/${s.file}.png`, `alt` = `s.name`) and "Emoji" (grid of `<button>` glyphs). A `ref` tracks the active tab.
- Brand thumb click → `emit('add-sticker', src)`. Emoji click → `emit('add-emoji', char)`.
- Use `data-testid="tab-brand"`, `data-testid="tab-emoji"`, class `sticker-thumb` for brand items and `emoji-btn` for emoji items.
- If `stickers` is empty, the Brand tab shows a muted "No stickers available" message (fail-soft, still renders).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StickerPicker from '../StickerPicker.vue'
import { EMOJI } from '../stickers'

const stickers = [{ name: 'pumpkin', file: 'pumpkin' }, { name: 'star', file: 'star' }]
const base = { stickers, imgBase: '/images/devtoberfest/selfie' }

describe('StickerPicker', () => {
  it('renders a brand thumbnail per sticker and emits add-sticker with the resolved src', async () => {
    const w = mount(StickerPicker, { props: base })
    const thumbs = w.findAll('.sticker-thumb')
    expect(thumbs).toHaveLength(2)
    expect(w.findAll('.sticker-thumb img')[0].attributes('src'))
      .toBe('/images/devtoberfest/selfie/stickers/pumpkin.png')
    await thumbs[0].trigger('click')
    expect(w.emitted('add-sticker')![0]).toEqual(['/images/devtoberfest/selfie/stickers/pumpkin.png'])
  })

  it('switches to the Emoji tab and emits add-emoji with the glyph', async () => {
    const w = mount(StickerPicker, { props: base })
    await w.find('[data-testid="tab-emoji"]').trigger('click')
    const emoji = w.findAll('.emoji-btn')
    expect(emoji).toHaveLength(EMOJI.length)
    await emoji[0].trigger('click')
    expect(w.emitted('add-emoji')![0]).toEqual([EMOJI[0]])
  })

  it('shows a fallback message when there are no stickers', () => {
    const w = mount(StickerPicker, { props: { stickers: [], imgBase: base.imgBase } })
    expect(w.text()).toContain('No stickers')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/StickerPicker.test.ts`
Expected: FAIL — cannot resolve `../StickerPicker.vue`.

- [ ] **Step 3: Implement**

```vue
<!-- hugo-apps/src/selfie/StickerPicker.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import type { StickerDef } from './stickers'
import { EMOJI } from './stickers'

const props = defineProps<{ stickers: StickerDef[]; imgBase: string }>()
const emit = defineEmits<{ 'add-sticker': [src: string]; 'add-emoji': [char: string] }>()

const tab = ref<'brand' | 'emoji'>('brand')
function srcOf(s: StickerDef) { return `${props.imgBase}/stickers/${s.file}.png` }
</script>
<template>
  <div class="sticker-picker">
    <div class="sticker-tabs" role="tablist">
      <button
        type="button" role="tab" data-testid="tab-brand"
        :aria-selected="tab === 'brand'" :class="{ 'is-active': tab === 'brand' }"
        @click="tab = 'brand'"
      >Stickers</button>
      <button
        type="button" role="tab" data-testid="tab-emoji"
        :aria-selected="tab === 'emoji'" :class="{ 'is-active': tab === 'emoji' }"
        @click="tab = 'emoji'"
      >Emoji</button>
    </div>

    <ul v-if="tab === 'brand'" class="sticker-grid" role="listbox" aria-label="Stickers">
      <li v-if="!stickers.length" class="sticker-empty">No stickers available.</li>
      <li
        v-for="s in stickers" :key="s.name" class="sticker-thumb"
        role="option" tabindex="0"
        @click="emit('add-sticker', srcOf(s))"
        @keydown.enter.prevent="emit('add-sticker', srcOf(s))"
      >
        <img :src="srcOf(s)" :alt="s.name" loading="lazy" />
      </li>
    </ul>

    <ul v-else class="sticker-grid emoji-grid" role="listbox" aria-label="Emoji">
      <li v-for="e in EMOJI" :key="e">
        <button type="button" class="emoji-btn" @click="emit('add-emoji', e)">{{ e }}</button>
      </li>
    </ul>
  </div>
</template>
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/StickerPicker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/StickerPicker.vue hugo-apps/src/selfie/__tests__/StickerPicker.test.ts
git commit -m "feat(#1517): StickerPicker palette (brand + emoji tabs)"
```

---

### Task 5: Composer toolbar — palette, caption field, delete

**Files:**
- Modify: `hugo-apps/src/selfie/Composer.vue`
- Test: `hugo-apps/src/selfie/__tests__/Composer.test.ts` (extend)

**Interfaces:**
- Consumes: `StickerPicker.vue`, `CAPTION_PLACEHOLDER` from `./stickers`, `StickerDef`/`parseStickerList` not needed here (list arrives via props).
- New prop: `stickers: StickerDef[]`.
- Uses stage methods from Task 3: `addSticker`, `addEmoji`, `addCaption`, `updateCaption`, `deleteSelected`, `onSelectionChange`.

**Design notes:**
- Add `import StickerPicker from './StickerPicker.vue'`, `import { CAPTION_PLACEHOLDER } from './stickers'`, and `import type { StickerDef } from './stickers'`.
- Add `stickers: StickerDef[]` to `defineProps`.
- Add reactive `const selectedKind = ref<'none'|'sticker'|'caption'>('none')` and `const captionText = ref('')`.
- After `stage = await buildStage(...)` in `onMounted`, register `stage.onSelectionChange((k) => { selectedKind.value = k })`.
- Handlers (all guard `if (!stage) return`):
  - `onAddSticker(src)`: `const img = await blobToImage`… no — load via a URL, not a blob. Add a small `urlToImage(src)` helper (same shape as `blobToImage` but `img.src = src` directly, no object URL). On error `console.warn` and return (fail-soft). Then `stage.addSticker(img)`.
  - `onAddEmoji(char)`: `stage.addEmoji(char)`.
  - `onAddCaption()`: `stage.addCaption(CAPTION_PLACEHOLDER)`; `captionText.value = CAPTION_PLACEHOLDER`.
  - `onCaptionInput(e)`: `captionText.value = e.target.value; stage.updateCaption(captionText.value)`.
  - `onDelete()`: `stage.deleteSelected()`.
- Template additions inside `.selfie-editor-toolbar` (before Export button):
  - `<StickerPicker :stickers="stickers" :img-base="imgBase" @add-sticker="onAddSticker" @add-emoji="onAddEmoji" />`
  - `<button type="button" class="selfie-btn" data-testid="add-caption" @click="onAddCaption">Add caption</button>`
  - `<input type="text" class="selfie-caption-input" data-testid="caption-input" :disabled="selectedKind !== 'caption'" :value="captionText" @input="onCaptionInput" placeholder="Caption text" />`
  - `<button type="button" class="selfie-btn selfie-btn--danger" data-testid="delete-overlay" :disabled="selectedKind === 'none'" @click="onDelete">Delete</button>`
- In the hoisted stage mock in the test file, add `addSticker`, `addEmoji`, `addCaption`, `updateCaption`, `deleteSelected`, and `onSelectionChange` (capture its callback so tests can drive `selectedKind`).

- [ ] **Step 1: Extend the stage mock + add failing tests**

Update the hoisted mock:
```ts
const h = vi.hoisted(() => {
  const exportPng = vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  const addCutout = vi.fn(); const setImage = vi.fn()
  const addSticker = vi.fn(); const addEmoji = vi.fn()
  const addCaption = vi.fn(); const updateCaption = vi.fn(); const deleteSelected = vi.fn()
  let selCb: ((k: string) => void) | null = null
  const onSelectionChange = vi.fn((cb: (k: string) => void) => { selCb = cb })
  const buildStage = vi.fn().mockResolvedValue({
    addCutout, setImage, exportPng, destroy: vi.fn(),
    addSticker, addEmoji, addCaption, updateCaption, deleteSelected, onSelectionChange,
    hasCaption: () => false, selectedIsCaption: () => false, deselect: vi.fn(),
  })
  return { exportPng, addCutout, setImage, addSticker, addEmoji, addCaption, updateCaption, deleteSelected, onSelectionChange, buildStage, fireSel: (k: string) => selCb?.(k) }
})
```
Add `stickers: [{ name: 'pumpkin', file: 'pumpkin' }]` to every `mount` props (add to `base`). Clear the new mocks in `beforeEach`. New tests:

```ts
it('Add caption calls stage.addCaption with the placeholder', async () => {
  const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
  await flushPromises()
  await w.find('[data-testid="add-caption"]').trigger('click')
  expect(h.addCaption).toHaveBeenCalledWith('#Devtoberfest')
})

it('caption input is disabled until a caption is selected', async () => {
  const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
  await flushPromises()
  const input = () => w.find('[data-testid="caption-input"]').element as HTMLInputElement
  expect(input().disabled).toBe(true)
  h.fireSel('caption') // stage reports a caption is selected
  await flushPromises()
  expect(input().disabled).toBe(false)
})

it('typing in the caption field updates the caption on the stage', async () => {
  const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
  await flushPromises()
  h.fireSel('caption'); await flushPromises()
  const field = w.find('[data-testid="caption-input"]')
  ;(field.element as HTMLInputElement).value = 'I met an advocate!'
  await field.trigger('input')
  expect(h.updateCaption).toHaveBeenCalledWith('I met an advocate!')
})

it('Delete is disabled with nothing selected and enabled once something is', async () => {
  const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
  await flushPromises()
  const del = () => w.find('[data-testid="delete-overlay"]').element as HTMLButtonElement
  expect(del().disabled).toBe(true)
  h.fireSel('sticker'); await flushPromises()
  expect(del().disabled).toBe(false)
  await w.find('[data-testid="delete-overlay"]').trigger('click')
  expect(h.deleteSelected).toHaveBeenCalled()
})

it('adding an emoji from the palette calls stage.addEmoji', async () => {
  const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
  await flushPromises()
  await w.find('[data-testid="tab-emoji"]').trigger('click')
  await w.findAll('.emoji-btn')[0].trigger('click')
  expect(h.addEmoji).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/Composer.test.ts`
Expected: FAIL — new controls not present / handlers missing.

- [ ] **Step 3: Implement the Composer changes** (per Design notes above)

- [ ] **Step 4: Run the whole selfie suite**

Run: `npx vitest run --project unit hugo-apps/src/selfie/`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/Composer.vue hugo-apps/src/selfie/__tests__/Composer.test.ts
git commit -m "feat(#1517): Composer toolbar — sticker palette, caption field, delete"
```

---

### Task 6: Config plumbing — `types.ts`, `main.ts`, `Selfie.vue`, layout

**Files:**
- Modify: `hugo-apps/src/selfie/types.ts`
- Modify: `hugo-apps/src/selfie/main.ts`
- Modify: `hugo-apps/src/selfie/Selfie.vue`
- Modify: `hugo/layouts/devtoberfest/selfie.html`
- Test: `hugo-apps/src/selfie/__tests__/Selfie.test.ts` (extend — assert stickers prop is forwarded)

**Interfaces:**
- Consumes: `parseStickerList` from `./stickers`.
- `MountConfig` gains `stickers: string[]` (parsed sticker basenames).

**Design notes:**
- `types.ts`: `export interface MountConfig { imgBase: string; frames: string[]; stickers: string[] }`.
- `main.ts`: add `stickers: parseStickerList(d.stickers || '').map(s => s.file)` — OR keep it simple: `stickers: (d.stickers || '').split(',').map(s => s.trim()).filter(Boolean)`. Use the same split idiom as `frames` for consistency (parse to `StickerDef[]` happens in Composer via a prop mapping). To keep types clean: store raw names in config (`string[]`), and have `Selfie.vue` map to `StickerDef[]` with `parseStickerList(config.stickers.join(','))` when passing to `Composer`. (Pick one; the test asserts the Composer receives a `StickerDef[]`.)
- `Selfie.vue`: import `parseStickerList`; when rendering `<Composer>`, pass `:stickers="parseStickerList(config.stickers.join(','))"`.
- `selfie.html`: add `data-stickers="devtoberfest-badge,sap-developers-lockup,pumpkin,confetti,star,speech-bubble"` to the mount element.
- Extend `Selfie.test.ts`: the Composer stub's props array must include `'stickers'`; assert that after advancing to compose, the Composer receives a non-empty `stickers` array. Reuse the existing `pickFrameAndSnap` helper; add `stickers: ['pumpkin','star']` to the mounted `config`.

- [ ] **Step 1: Write/extend the failing test**

In `Selfie.test.ts`, add `stickers` to the Composer mock's props list and the mounted config, then:
```ts
it('forwards a parsed sticker list to the Composer', async () => {
  const w = await pickFrameAndSnap({ /* config with stickers: ['pumpkin','star'] */ })
  await flushPromises()
  const composer = w.findComponent({ name: 'Composer' })
  const passed = composer.props('stickers') as Array<{ name: string; file: string }>
  expect(passed.map((s) => s.file)).toEqual(['pumpkin', 'star'])
})
```
(Adjust to the file's existing helper signature; if `pickFrameAndSnap` doesn't take a config override, set the config on the top-level `mount` and keep the assertion.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/selfie/__tests__/Selfie.test.ts`
Expected: FAIL — `stickers` prop undefined / not forwarded.

- [ ] **Step 3: Implement** `types.ts`, `main.ts`, `Selfie.vue`, and `selfie.html` per Design notes.

- [ ] **Step 4: Run the whole selfie suite**

Run: `npx vitest run --project unit hugo-apps/src/selfie/`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/types.ts hugo-apps/src/selfie/main.ts hugo-apps/src/selfie/Selfie.vue hugo-apps/src/selfie/__tests__/Selfie.test.ts hugo/layouts/devtoberfest/selfie.html
git commit -m "feat(#1517): plumb data-stickers config through to the Composer"
```

---

### Task 7: Styling + placeholder sticker assets + build gate

**Files:**
- Modify: `hugo-apps/src/selfie/styles.css`
- Create: `hugo/static/images/devtoberfest/selfie/stickers/*.png` (6 placeholder PNGs matching the `data-stickers` list)

**Design notes:**
- CSS (append to `styles.css`, reuse existing tokens):
  - `.selfie-btn--danger { background: var(--sapButton_Reject_Background, #aa0808); }`
  - `.selfie-caption-input { font: inherit; padding: .4rem .6rem; border: 1px solid var(--sapField_BorderColor, #89919a); border-radius: 6px; min-width: 12rem; }`
  - `.selfie-caption-input:disabled { opacity: .5; cursor: not-allowed; }`
  - `.sticker-picker { width: 100%; }`
  - `.sticker-tabs { display: flex; gap: .5rem; margin-bottom: .5rem; }`
  - `.sticker-tabs button { cursor: pointer; border: none; background: none; font: inherit; padding: .3rem .6rem; border-bottom: 2px solid transparent; color: var(--sapContent_LabelColor, #556b82); }`
  - `.sticker-tabs button.is-active { border-bottom-color: var(--sapButton_Emphasized_Background, #0070f2); color: var(--sapButton_Emphasized_Background, #0070f2); }`
  - `.sticker-grid { list-style: none; padding: 0; margin: 0; display: grid; gap: .5rem; grid-template-columns: repeat(auto-fill, minmax(56px, 1fr)); }`
  - `.sticker-thumb { cursor: pointer; border: 2px solid transparent; border-radius: 8px; overflow: hidden; background: var(--sapTile_Background, #fff); box-shadow: 0 1px 4px rgba(0,0,0,.12); }`
  - `.sticker-thumb:hover, .sticker-thumb:focus-within { border-color: var(--sapButton_Emphasized_Background, #0070f2); }`
  - `.sticker-thumb img { display: block; width: 100%; height: auto; }`
  - `.emoji-grid button.emoji-btn { cursor: pointer; border: none; background: none; font-size: 1.6rem; line-height: 1; padding: .25rem; }`
  - `.sticker-empty { color: var(--sapContent_LabelColor, #556b82); font-size: .9rem; grid-column: 1 / -1; }`
- Placeholder assets: create 6 tiny valid PNGs (a solid-color square is fine — real artwork is a follow-up) named `devtoberfest-badge.png`, `sap-developers-lockup.png`, `pumpkin.png`, `confetti.png`, `star.png`, `speech-bubble.png`. Generate with a one-liner (Node `zlib` or a committed 1×1 transparent PNG copied to each name). These exist so the palette renders and the page doesn't 404 during live QA; the fail-soft path already covers any that are missing.

- [ ] **Step 1: Add the CSS** to `styles.css`.

- [ ] **Step 2: Create the placeholder PNGs.** Use a base64 1×1 PNG written to each filename, e.g. a small script under `$CLAUDE_JOB_DIR/tmp` that decodes a known-good PNG and writes the six files. Verify each is a valid PNG (`file <name>` reports "PNG image data").

- [ ] **Step 3: Full unit run**

Run: `npx vitest run --project unit hugo-apps/src/selfie/`
Expected: PASS (all files).

- [ ] **Step 4: Vite build gate (CI parity)**

Run: `npm run build --prefix hugo-apps`
Expected: green; `selfie.js` emitted (size grows modestly over the Tier-1 ~208 kB).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/styles.css hugo/static/images/devtoberfest/selfie/stickers/
git commit -m "feat(#1517): sticker palette styling + placeholder sticker assets"
```

---

## Self-Review

**Spec coverage:**
- AC "add, position, resize, remove stickers" → Tasks 2 (add/select/delete), 3 (transformer handles for resize/rotate via Konva.Transformer), 4/5 (palette add).
- AC "editable text caption, name pre-fillable" → Tasks 2/5 (caption add/update). Name pre-fill explicitly declined in brainstorming → generic placeholder (documented in spec Out-of-scope + Global Constraints).
- AC "overlays bake into exported PNG" → Task 3 (export hides both transformers; overlays layer is part of the stage `toBlob`).
- AC "touch-friendly (drag + pinch)" → drag via Konva `draggable`, resize/rotate via Transformer handles (touch-capable). Native pinch explicitly out of scope (documented).
- AC "test coverage for add/remove/export" → Tasks 2, 3, 4, 5 tests.
- Design principle fail-soft → Global Constraints + Task 5 urlToImage warn-and-skip + Task 7 placeholder assets.

**Placeholder scan:** No "TBD"/"handle appropriately". Every code step has concrete code; Composer's larger changes are spelled out as explicit design notes + full test code (the implementer transcribes the notes into `Composer.vue`, which already exists and is short).

**Type consistency:** `OverlayManager` method names identical across `overlays.ts` (Task 2), `SelfieStage` re-exports (Task 3), Composer stage mock (Task 5). `StickerDef {name,file}` identical in `stickers.ts` (Task 1), `StickerPicker` props (Task 4), Composer prop + `Selfie.vue` mapping (Tasks 5/6). `OverlayKind`/`selectedKind` union identical (`'none'|'sticker'|'caption'`). `CAPTION_PLACEHOLDER = '#Devtoberfest'` used in Task 1 def, Task 2 test, Task 5 handler + test.

**Note for the executor:** Task 5's Composer changes are the most integration-heavy (multiple new handlers + template controls + selection wiring). Dispatch it on a standard model, not the cheapest tier.

# Selfie Tier 2 — Stickers & Captions (#1517) Design

**Issue:** [sap-tutorials/tutorials-ims#1517](https://github.com/sap-tutorials/tutorials-ims/issues/1517) — part of the Selfie epic [#1512](https://github.com/sap-tutorials/tutorials-ims/issues/1512), Tier 2 ("the fun layer").

**Date:** 2026-08-08

## Goal

Let a user add playful, campaign-driving embellishments to their composited selfie: draggable **stickers** (curated brand PNGs + an emoji picker) and a single editable **text caption**. Overlays can be positioned, resized, rotated, and deleted, and they bake into the exported PNG.

## Context

Tier 1 (camera capture #1513, in-browser background removal #1514, client-side canvas compositing #1515) is complete and merged. The selfie tool is a Vue 3 island (`hugo-apps/src/selfie/`), vite-built into `hugo/static/js/selfie.js`, mounted at `/devtoberfest/selfie/` via `hugo/layouts/devtoberfest/selfie.html`. Compositing uses **Konva** on a stage whose aspect matches the selected advocate frame.

Today `compose.ts` builds a stage with a `frameLayer` (decorative advocate frame, `listening(false)`) and a `cutoutLayer` holding one draggable photo/cutout `Konva.Image` bound to one `Konva.Transformer`. `Composer.vue` mounts the stage, owns the remove-background toggle, and exports via `stage.exportPng()` (which hides the transformer before `toBlob` so selection handles don't bake in).

This design adds a **dynamic overlay layer** for stickers and the caption without disturbing the Tier-1 cutout/frame logic.

## Design Decisions (from brainstorming)

- **Sticker source:** BOTH curated PNG stickers AND an emoji picker.
- **Caption:** a SINGLE styled caption node. Generic placeholder text (`#Devtoberfest`) — **no** advocate-name guessing from frame filenames. Editable, draggable, deletable. Fixed brand style (no font/color pickers).
- **Manipulation:** reuse `Konva.Transformer` handles (tap-to-select, drag to move, corner handles to scale/rotate, a Delete button). **No** custom two-finger pinch gestures.
- **Module structure:** Approach B — a dedicated `overlays.ts` `OverlayManager` module, composed into `buildStage`. Caption text editing lives in a **toolbar text field** (not an HTML input overlaid on the canvas — that positioning math is touch-flaky). Konva stays the single source of truth for transforms.
- **Export safety:** before `toBlob`, deselect all overlays and hide BOTH transformers (cutout + overlay), restore after — no selection handles can ever bake into the PNG.
- **Fail-soft everywhere:** a sticker PNG that 404s/fails to decode is skipped with a `console.warn`; guarded no-ops when the stage is absent; export inherits the Tier-1 plain-download fallback. The island must never crash the page.

## Architecture

A new `overlays.ts` module owns everything dynamic on the canvas. `compose.ts` constructs an `OverlayManager` on a new overlays layer and re-exports its methods on `SelfieStage`. The Tier-1 photo/frame/cutout logic is untouched except for the export deselect-and-hide safety step.

### File structure

| File | Change | Responsibility |
|---|---|---|
| `hugo-apps/src/selfie/overlays.ts` | **create** | `OverlayManager`: overlays `Konva.Layer` + one shared `Transformer`; selection, add sticker/emoji/caption, update/delete caption, delete selected, deselect, selection-change callback. |
| `hugo-apps/src/selfie/compose.ts` | modify | `buildStage()` builds an overlays layer + `OverlayManager`; re-exports `addSticker`/`addEmoji`/`addCaption`/`updateCaption`/`hasCaption`/`selectedIsCaption`/`deleteSelected`/`deselect`/`onSelectionChange` on `SelfieStage`. `exportPng` deselects + hides both transformers before `toBlob`, restores after. |
| `hugo-apps/src/selfie/stickers.ts` | **create** | Pure data: `parseStickerList()` (CSV → sticker defs), `EMOJI` fixed list, `CAPTION_PLACEHOLDER`. |
| `hugo-apps/src/selfie/StickerPicker.vue` | **create** | Palette UI: tabbed "Brand" (PNG thumbnails) / "Emoji" (glyph grid). Emits `add-sticker(src)` / `add-emoji(char)`. |
| `hugo-apps/src/selfie/Composer.vue` | modify | Mounts palette + caption controls in the editor toolbar; owns the caption `<input>` (toolbar-bound); Add-caption / Delete buttons; wires palette + caption events to stage methods; tracks `selectedKind` via `onSelectionChange`. |
| `hugo-apps/src/selfie/Selfie.vue` | modify | Pass `stickers` list from config to `Composer`. |
| `hugo-apps/src/selfie/types.ts` | modify | `MountConfig` gains `stickers: string[]`. |
| `hugo-apps/src/selfie/main.ts` | modify | Parse `data-stickers` (CSV, like `data-frames`). |
| `hugo-apps/src/selfie/styles.css` | modify | Palette, caption field, delete/add-caption button styling. |
| `hugo/layouts/devtoberfest/selfie.html` | modify | Add `data-stickers` attribute. |
| `hugo/static/images/devtoberfest/selfie/stickers/*.png` | **create** | Curated sticker artwork (placeholder art acceptable in this PR; real artwork is a follow-up asset task). |

### Data flow

```
palette tap ─▶ Composer ─▶ stage.addSticker(img) / addEmoji(char) / addCaption(text)
                              └─▶ OverlayManager: add draggable Konva node, bind to shared
                                  transformer, select it, fire onSelectionChange('sticker'|'caption')
node tap ─────▶ OverlayManager: transformer.nodes([node]); onSelectionChange(kind)
empty tap ────▶ OverlayManager: transformer.nodes([]); onSelectionChange('none')
caption field ▶ Composer ─▶ stage.updateCaption(text)  (no-op unless a caption is selected/exists)
Delete btn ───▶ Composer ─▶ stage.deleteSelected()
Export btn ───▶ stage.exportPng(): deselect + hide both transformers → toBlob → restore
```

Emoji become `Konva.Text` glyph nodes (same family as the caption → identical scale/rotate/delete path). PNG stickers become `Konva.Image` nodes like the cutout.

## Component interfaces

### `overlays.ts`

```ts
export type OverlayKind = 'none' | 'sticker' | 'caption'

export interface OverlayManager {
  addSticker(img: HTMLImageElement): void   // Konva.Image, draggable, becomes selected
  addEmoji(char: string): void              // Konva.Text glyph, draggable, becomes selected
  addCaption(text: string): void            // at most ONE caption node; re-add selects the existing one
  updateCaption(text: string): void         // no-op unless a caption node exists
  hasCaption(): boolean
  selectedIsCaption(): boolean
  deleteSelected(): void                     // removes the selected node; caption delete clears hasCaption
  deselect(): void                           // transformer.nodes([]); fires onSelectionChange('none')
  onSelectionChange(cb: (kind: OverlayKind) => void): void
  hideTransformer(): boolean                 // returns prior visibility; used by exportPng
  showTransformer(): void
  destroy(): void
}

export function createOverlayManager(
  stage: Konva.Stage,
  layer: Konva.Layer,
): OverlayManager
```

**Selection rules**
- One shared `Konva.Transformer` lives in the overlays layer; `transformer.nodes([node])` on select, `nodes([])` on deselect.
- Each overlay node gets a `click`/`tap` handler that selects it and stops propagation (so it does not also hit the cutout beneath).
- A stage-level `click`/`tap` where `e.target === stage` deselects overlays.
- **Caption is a singleton:** `addCaption` when one already exists just re-selects the existing node (no duplicate). `deleteSelected` on the caption clears `hasCaption()` so it can be re-added.
- The Tier-1 cutout keeps its own transformer in the cutout layer; overlays use a separate transformer so the two do not fight. Overlay taps `cancelBubble` prevents double-hits. Verified in tests + live QA.

### `stickers.ts`

```ts
export interface StickerDef { name: string; file: string }   // file relative to `${imgBase}/stickers/`
export function parseStickerList(csv: string): StickerDef[]   // trims, drops blanks; name === file basename
export const EMOJI: readonly string[]                          // fixed fun set
export const CAPTION_PLACEHOLDER = '#Devtoberfest'
```

`EMOJI` initial set: 🎃 🎉 ⭐ 🧡 💻 🚀 👋 🙌 🔥 ❤️ ✨ 🏆

Curated PNG starter set (data-driven; more drop in via `data-stickers` with no code change):
`devtoberfest-badge`, `sap-developers-lockup`, `pumpkin`, `confetti`, `star`, `speech-bubble`.

### `compose.ts` additions to `SelfieStage`

```ts
addSticker(img: HTMLImageElement): void
addEmoji(char: string): void
addCaption(text: string): void
updateCaption(text: string): void
hasCaption(): boolean
selectedIsCaption(): boolean
deleteSelected(): void
deselect(): void
onSelectionChange(cb: (kind: OverlayKind) => void): void
```

`exportPng` change (bake-in safety): before `toBlob`, call `overlay.deselect()`, capture and hide the cutout transformer (existing) AND the overlay transformer; after the blob callback, restore both to their prior visibility and `batchDraw()`.

### Caption styling (fixed brand style)

`Konva.Text` with: bold `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` stack, white `fill`, dark `stroke` (~2px) + subtle `shadowColor`/`shadowBlur` for legibility over any background, large default `fontSize` (relative to stage height), `align: 'center'`, centered on the stage on add. Users edit the text (toolbar field) and transform via handles; no font/color/size pickers.

## Composer UI

Extends the existing `.selfie-editor-toolbar`:

- **Existing (unchanged):** remove-background toggle, Export button.
- **New:**
  - **Add caption** button → `stage.addCaption(CAPTION_PLACEHOLDER)`.
  - **Caption text field** → bound to the caption; typing calls `stage.updateCaption($event)`. Enabled only when `selectedKind === 'caption'`.
  - **Delete** button → `stage.deleteSelected()`. Enabled only when `selectedKind !== 'none'`.
  - **StickerPicker** palette (tabbed Brand / Emoji). `add-sticker(src)` → load image then `stage.addSticker(img)`; `add-emoji(char)` → `stage.addEmoji(char)`.
- `Composer` tracks `selectedKind` via `stage.onSelectionChange(cb)` to drive enablement.

## Error handling

All fail-soft — the island must never crash the page (Tier-1 principle #3):

- Sticker image load failure → skipped, `console.warn`, palette stays usable.
- `addCaption`/`updateCaption`/`addSticker`/`addEmoji`/`deleteSelected` with no stage → guarded no-op in `Composer`.
- `exportPng` already falls back to plain download on any stage error (Tier-1); overlays inherit it.
- Emoji and caption cannot 404.

## Testing

Matches the repo's happy-dom + Konva-mock patterns already in `compose.test.ts` / `Composer.test.ts` (note: happy-dom does NOT fire `<img>` onload for `blob:`/`object` URLs → stub global `Image` in `beforeEach`).

- **`overlays.test.ts`** (new) — against a mocked Konva: add sticker/emoji/caption creates a node and selects it (transformer bound); caption is a singleton (second `addCaption` selects the existing, no duplicate); `updateCaption` mutates text; `deleteSelected` removes the node and clears `hasCaption`; `deselect` clears transformer nodes; `onSelectionChange` fires with the right kind.
- **`compose.test.ts`** (extend) — `exportPng` deselects and hides BOTH transformers before `toBlob` and restores after; re-exported methods delegate to the manager.
- **`stickers.test.ts`** (new) — `parseStickerList` trims/drops blanks; `EMOJI` non-empty; `CAPTION_PLACEHOLDER` correct.
- **`StickerPicker.test.ts`** (new) — tabs render; clicking a brand thumb emits `add-sticker` with the resolved src; clicking an emoji emits `add-emoji` with the glyph.
- **`Composer.test.ts`** (extend) — Add-caption calls `stage.addCaption`; caption field disabled until a caption is selected; Delete disabled until a selection exists; palette events call the corresponding stage methods (extend the hoisted stage mock with the new methods).
- **CI gate:** `npm run build --prefix hugo-apps` (vite build) green. Run selfie unit tests from repo root: `npx vitest run --project unit hugo-apps/src/selfie/`.
- **Live QA (Tom's #1 rule):** after deploy, at `/devtoberfest/selfie/` in a real browser — add a PNG sticker + an emoji + a caption; edit the caption text; drag / scale / rotate / delete each; Export and confirm all overlays bake into the downloaded PNG with no selection handles.

## Out of scope (this slice)

- Other Tier 2 issues: #1516 filters & effects, #1518 polaroid border, #1519 desktop share fallback (Web Share mobile path already shipped in Tier 1).
- Advocate-name auto-fill (explicitly declined — generic placeholder only).
- Two-finger pinch/twist gestures.
- Font/color/size caption pickers.
- Final production sticker artwork (follow-up asset task).

# Selfie Filters & Effects Layer (#1516) — Design

**Status:** Approved (2026-08-08)
**Epic:** #1512 Selfie tool · **Tier:** 2 · **Depends on:** #1515 (client-side compositing, done)

## Goal

Add a one-tap effects layer to the selfie composer: a handful of branded/seasonal
presets that preview live in the UI and bake into the exported PNG, are
non-destructive (switch or clear freely before download), and never crash the
island if an effect fails.

## Acceptance Criteria (from the issue)

1. User can apply at least a handful of one-tap effect presets.
2. Effects bake into the exported PNG.
3. Effects are non-destructive in the UI (can switch/remove before download).
4. Fail-soft: an effect failure never crashes the island.
5. Test coverage for preset application.

## Approved Decisions

- **Engine:** Canvas-2D bake (NOT glfx.js/WebGL, NOT Konva canvas filters). Mirrors
  the merged #1518 polaroid precedent — CSS live preview + a pure Canvas-2D bake at
  export. Zero new dependencies; fully unit-testable in happy-dom with the existing
  spy-2D-context harness. The Konva stage is never mutated → non-destructive by
  construction.
- **Presets (v1, five + None):** Devtoberfest duotone, Warm/autumn, B&W/mono,
  Vignette, Joule (gradient tint). `none` is the default and always present.
- **Joule preset shape:** a soft full-frame purple→pink brand gradient *wash*
  (low-alpha overlay), NOT a full duotone and NOT a sticker/logo overlay.

## Architecture

Follows the #1518 polaroid pattern exactly. Two representations of every preset live
in one pure module; the UI uses the CSS representation for a live approximation, and
the export pipeline uses the Canvas-2D representation for the authoritative bake. The
Konva stage is read (`stage.toCanvas()`) but never mutated, so removing/switching a
preset is just resetting a ref — nothing to undo.

Effect bake order in the export chain:

```
stage.toCanvas()  →  applyEffect(composite, effectId)  →  [paintPolaroid border]  →  toBlob('image/png')
```

The effect bakes **before** the polaroid border so the white matte stays untinted.

### Module: `hugo-apps/src/selfie/effects.ts` (new)

Mirrors `polaroid.ts` structure (a `Record` table + an ordered id array + a pure
transform that returns the input unchanged on failure).

```ts
export type EffectId = 'none' | 'duotone' | 'warm' | 'mono' | 'vignette' | 'joule'

export interface Effect {
  label: string
  // CSS live-preview approximation applied to the stage element in the UI.
  preview: {
    filter?: string
    overlay?: { background: string; blend: string; opacity: number }
  }
  // Authoritative Canvas-2D bake. MUST return a canvas (the input, mutated, or a
  // new one). MUST NOT throw — callers rely on applyEffect's fail-soft wrapper,
  // but each apply is also individually defensive.
  apply: (canvas: HTMLCanvasElement) => HTMLCanvasElement
}

export const EFFECTS: Record<EffectId, Effect>
export const EFFECT_IDS: EffectId[]  // picker order; 'none' first

// Pure dispatcher. Returns the input canvas unchanged for 'none', an unknown id,
// a missing 2D context, or ANY thrown error inside apply(). Fail-soft.
export function applyEffect(canvas: HTMLCanvasElement, id: EffectId): HTMLCanvasElement
```

**`none`** has `preview: {}` and an `apply` that returns the input untouched.

### Preset bake techniques

All use Canvas-2D primitives already exercised by `polaroid.test.ts`'s spy context
(`fillRect`, `drawImage`, `createLinearGradient`) plus `createRadialGradient` (new
spy). `ctx.filter` string assignment is used for the filter-only presets.

| Preset | Bake | CSS preview |
|---|---|---|
| **Devtoberfest duotone** | draw source with `ctx.filter='grayscale(1)'`, then a Devtoberfest orange→dark `createLinearGradient` filled over it with `globalCompositeOperation='color'` | `filter: grayscale(1)` + orange overlay, `mix-blend-mode: color` |
| **Warm / autumn** | draw source with `ctx.filter='sepia(0.35) saturate(1.4) contrast(1.05)'` | same `filter` string, no overlay |
| **B&W / mono** | draw source with `ctx.filter='grayscale(1)'` | `filter: grayscale(1)` |
| **Vignette** | draw source, then a `createRadialGradient` (transparent center → dark edge) filled with `globalCompositeOperation='source-over'` | inset dark radial overlay, `mix-blend-mode: normal` |
| **Joule** | draw source, then a purple→pink `createLinearGradient` filled at low global alpha (soft wash), `source-over` | purple→pink overlay, `mix-blend-mode: soft-light`, low opacity |

Exact color stops and alpha values are fixed constants in `effects.ts` (specified in
the implementation plan); duotone/Joule brand colors reuse the Devtoberfest orange
already used by the polaroid/sticker branding and Joule's purple→pink.

Presets that use `ctx.filter` reset it to `'none'` after drawing so a later overlay
fill is not itself filtered.

### Export hook: `hugo-apps/src/selfie/compose.ts`

Refactor `exportPng` to take a single options object (replaces the current optional
`border` positional arg):

```ts
exportPng(opts?: { effect?: EffectId; border?: { style: PolaroidStyleId; name: string } }): Promise<Blob>
```

- If `effect` is a real effect (not `none`/undefined) **or** `border` is set → canvas
  path: hide both transformers, `stage.toCanvas()` → `applyEffect(composite, effect)`
  → if `border` then `paintPolaroid(effected, border)` → `canvas.toBlob`, restore
  transformers.
- Else (no effect, no border) → existing fast `stage.toBlob` path, unchanged.
- The transformer hide/restore and fail-soft `try/catch → reject` structure is
  preserved from the current implementation.

This is a breaking signature change to the merged #1518 `exportPng({ border })` call
shape; the sole caller is `Composer.vue:doExport`, updated in the same plan, and
`compose.test.ts` expectations are updated (in scope).

### UI: `hugo-apps/src/selfie/EffectPicker.vue` (new)

Mirrors `PolaroidControls.vue`:

- Renders a button per `EFFECT_IDS.map(...)`, each `:data-testid="effect-${id}"`,
  `:aria-pressed="id === modelEffect"`, label from `EFFECTS[id].label`.
- Props: `effect: EffectId`. Emits: `update:effect` with the chosen id.
- No semicolons; reuses existing `.selfie-polaroid-*`-style button classes (new
  `.selfie-effect-*` classes added to `styles.css`, same visual language).

### `Composer.vue` wiring

- New `effectId` ref, default `'none'`.
- `previewFilter` / `previewOverlay` computed from `EFFECTS[effectId.value].preview`,
  bound to the **stage element** inside the `.selfie-polaroid-preview` wrapper (so the
  effect covers the photo, not the polaroid matte). The overlay preview is an
  absolutely-positioned `<div>` over the stage when `preview.overlay` is set.
- `<EffectPicker>` slotted into the editor toolbar alongside `StickerPicker` and
  `PolaroidControls`.
- `doExport()` passes the active effect:
  ```ts
  const blob = await stage.exportPng({
    effect: effectId.value,
    border: borderEnabled.value ? { style: borderStyle.value, name: borderName.value } : undefined
  })
  ```
  The existing `catch → emit('fallback', effectiveBlob())` path is unchanged, so an
  export failure still degrades to the plain download.

## Error Handling / Fail-Soft

- `applyEffect` returns the **input canvas unchanged** on: `none`, unknown id, no 2D
  context, or any thrown error inside `apply()`. So a broken effect exports the
  un-effected photo rather than crashing.
- Each preset's `apply` is individually defensive (`const ctx = canvas.getContext('2d'); if (!ctx) return canvas`), matching `paintPolaroid`.
- `compose.exportPng` keeps its `try { ... } catch (e) { restore(); reject(e) }`
  wrapper; `Composer.doExport` keeps its `catch → fallback` so the island always
  yields *some* download.
- The CSS live preview cannot throw (pure string binding); a browser that ignores an
  unknown `filter`/`mix-blend-mode` value simply shows the unfiltered photo — the bake
  is still authoritative.

## Testing

- **`effects.test.ts`** (new; extends `polaroid.test.ts`'s spy-2D-context harness,
  adds a `createRadialGradient` spy): for each preset, assert `apply` invokes its
  expected Canvas-2D ops (e.g. duotone sets `filter` then fills a linear gradient with
  `globalCompositeOperation='color'`; vignette fills a radial gradient). Assert
  `applyEffect(canvas,'none')` returns the input, an unknown id returns the input, and
  a preset whose `apply` throws is caught by `applyEffect` and returns the input.
- **`compose.test.ts`** (update): `exportPng({ effect })` routes the composite through
  `applyEffect` once with the right id; effect bakes **before** `paintPolaroid` when
  both are set; `exportPng()` with no effect/border still takes the fast `stage.toBlob`
  path and does NOT call `applyEffect`/`paintPolaroid`; both transformers hidden during
  rasterization then restored.
- **`EffectPicker.test.ts`** (new): renders one button per `EFFECT_IDS`; clicking emits
  `update:effect` with the id; the active id's button has `aria-pressed="true"`.
- **`Composer.vue`** (extend existing test): `doExport` forwards `effect: effectId`
  to `stage.exportPng`.
- Run from repo root: `npm test -- --project unit <file>`.
- **Pre-existing failure to ignore:** `segment.test.ts` fails to resolve
  `@imgly/background-removal` — out of scope, do NOT "fix" it.

## Global Constraints

- **No semicolons** in selfie `.ts`/`.vue` files.
- **LF line endings** (Windows CRLF regressions are a known hazard).
- **Fail-soft always** — the island must never throw into the page.
- **Canvas-2D only** — no new dependencies; NO glfx.js, NO WebGL, NO Konva filters.
- **Konva stays `^9.3.0`** (hugo-apps only), stage never mutated by an effect.
- **`none` is the default** effect and always the first picker entry.
- **Effect bakes before the polaroid border** in the export chain.
- **Feature/brand copy:** preset labels are user-facing; Devtoberfest orange reuses the
  existing brand color; Joule is purple→pink.

## Out of Scope

- Brightness/contrast/warmth *sliders* (issue floats them as optional — presets only in v1).
- Literal seasonal graphic overlays (pumpkins, confetti, sparkles) — those are sticker-layer (#1517) territory.
- Joule logo/badge as a graphic — that would be a sticker, not an effect.
- Any change to capture, segmentation, or share code.

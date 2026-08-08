# Selfie Tier 2 #1518 — Branded Polaroid Frame Border — Design

**Issue:** sap-tutorials/tutorials-ims#1518 (epic #1512, "the fun layer")
**Date:** 2026-08-08
**Status:** Approved design → ready for implementation plan

## Purpose

Let a visitor to the Devtoberfest "Selfie with an Advocate" composer add an
optional, branded **polaroid-style matte border** that bakes into the exported
PNG. The matte carries the visitor's typed name, the `#Devtoberfest` hashtag,
and a "SAP Developers" text lockup, in one of three visual styles.

Mounted at `/devtoberfest/selfie/`. **Frontend-only** — no backend, CDS, or
config changes.

## Key decisions (locked with Tom during brainstorming)

1. **Advocate name = editable text, blank default.** No slug→display-name map.
   The name line starts empty; the user types it. This intentionally
   **supersedes** issue AC #5 ("auto-populates from the selected frame") —
   frame values are slugs (`Antonio`, `DJ`, `Group1`–`Group4`, `Background`,
   `Background2`) and several are not a single advocate, so an auto-populate
   map is not worth maintaining. Tom's decision governs over the AC.
2. **Geometry = classic polaroid, canvas grows.** The whole existing composite
   (photo + advocate frame + stickers + captions) is drawn INSET inside a
   matte; the export canvas grows to fit. The photo is never cropped or
   upscaled.
3. **Three styles:** Classic White, Devtoberfest (dark autumn), Joule
   (pink→purple gradient). User toggles the border on/off and picks a style.
4. **Logo = "SAP Developers" text lockup**, drawn as plain bold canvas text
   (canvas default sans-serif) — no binary image asset and no trademarked SAP
   logo font (scales crisply, no blur risk).
5. **Resolution = matte adds around the ~1080 composite.** Final PNG is larger
   than 1080; the photo bitmap is drawn 1:1 and never upscaled (satisfies
   AC #6).

## Architecture

The feature is **quarantined into the export path plus a live preview
wrapper**. The Konva stage (photo + advocate frame + stickers + captions,
delivered in #1517) is **untouched** — zero regression surface for the
just-merged sticker/caption work. This is the recommended "Approach A" chosen
over two more invasive alternatives (matte as Konva nodes / matte as a
`Konva.Group`) precisely because it does not disturb the stage's coordinate
space, transformer hit-testing, or the frame `containFit` aspect math.

```text
PolaroidControls.vue  (toggle + style picker + name field)
   │  update:enabled / update:style / update:name
   ▼
Composer.vue  (owns borderEnabled / borderStyle / borderName refs)
   ├── preview:  CSS matte wraps the Konva stage (driven by POLAROID_STYLES)
   └── export:   exportPng({ border: { style, name } })
                    │
                    ▼
                 compose.ts exportPng()
                    │  grabs composite canvas (deselect + hide both transformers)
                    ▼
                 polaroid.ts paintPolaroid(composite, { style, name }) → canvas
                    │
                    ▼
                 canvas → blob → emit('export', blob)
```

Both the CSS preview and the canvas bake read the **same** `POLAROID_STYLES`
constant table, so colors and proportions cannot drift between what the user
sees and what is exported.

## Files

### New

- **`hugo-apps/src/selfie/polaroid.ts`** — the core of the feature. Exports:
  - `POLAROID_STYLES: Record<PolaroidStyleId, PolaroidStyle>` — single source of
    truth for style colors, consumed by both preview and bake.
  - `POLAROID_INSET_FRACTION = 0.05`, `POLAROID_STRIP_FRACTION = 0.22` —
    proportion constants (fractions of the composite's shorter edge), shared
    with the CSS preview.
  - `paintPolaroid(composite: HTMLCanvasElement, opts: PaintPolaroidOpts) →
    HTMLCanvasElement` — pure, synchronous. Draws the matte + inset composite +
    text onto a larger offscreen canvas and returns it.
- **`hugo-apps/src/selfie/PolaroidControls.vue`** — toolbar sub-component:
  on/off toggle, 3-way style picker, name text field. Emits
  `update:enabled`, `update:style`, `update:name`. Kept separate so
  `Composer.vue`'s toolbar does not balloon.

### Modified

- **`hugo-apps/src/selfie/compose.ts`** — `exportPng()` gains an optional
  `border?: { style: PolaroidStyleId; name: string }` argument. When present,
  the composite canvas is routed through `paintPolaroid` before blob
  conversion; the existing deselect + hide-BOTH-transformers sequence is
  preserved so no selection handles leak into the export. When absent,
  behaviour is byte-identical to today.
- **`hugo-apps/src/selfie/Composer.vue`** — owns `borderEnabled` /
  `borderStyle` / `borderName` refs, renders `<PolaroidControls>` in the
  `.selfie-editor-toolbar`, wraps the stage in a CSS preview matte when
  enabled, and passes `{ style, name }` into `exportPng()` when the border is
  on.
- **`hugo-apps/src/selfie/styles.css`** — CSS preview matte classes, using the
  same inset/strip proportions and per-style colors as `POLAROID_STYLES`.

No changes to `types.ts` (MountConfig), `main.ts`, `Selfie.vue`, or
`selfie.html` — the feature needs no new mount config.

## Data model (`polaroid.ts`)

```ts
export type PolaroidStyleId = 'classic' | 'devtoberfest' | 'joule'

export interface PolaroidStyle {
  id: PolaroidStyleId
  label: string          // picker text
  matte:
    | { kind: 'solid'; color: string }
    | { kind: 'gradient'; from: string; to: string }  // vertical, top→bottom
  textColor: string      // name + lockup
  hashtagColor: string   // #Devtoberfest accent
}

export interface PaintPolaroidOpts {
  style: PolaroidStyleId
  name: string           // may be empty → name line omitted
}
```

Style table:

| id           | label          | matte                                   | textColor | hashtagColor |
|--------------|----------------|-----------------------------------------|-----------|--------------|
| classic      | Classic White  | solid `#ffffff`                         | `#1d2d3e` | `#0070f2`    |
| devtoberfest | Devtoberfest   | solid `#2b1a0f`                         | `#f5e6d3` | `#e8791a`    |
| joule        | Joule          | gradient `#e2337f` → `#7d4bd6` (vert.)  | `#ffffff` | `#ffffff`    |

Proportions (fractions of `min(compositeW, compositeH)`):

- side + top inset = `0.05 × min`
- bottom strip height = `0.22 × min`

## `paintPolaroid` algorithm

1. `cw = composite.width`, `ch = composite.height`, `m = min(cw, ch)`.
   `inset = round(0.05·m)`, `strip = round(0.22·m)`.
2. Allocate output canvas: `W = cw + 2·inset`, `H = ch + inset + strip`.
3. Acquire `ctx = out.getContext('2d')`. **If null → return the original
   `composite` unchanged** (fail-soft; border silently skipped).
4. Fill matte over the whole output:
   - solid → `ctx.fillStyle = color; ctx.fillRect(0, 0, W, H)`
   - gradient → `g = ctx.createLinearGradient(0, 0, 0, H)`;
     `g.addColorStop(0, from); g.addColorStop(1, to)`; fill.
5. `ctx.drawImage(composite, inset, inset)` — **1:1, no scale args** → photo
   pixels preserved exactly (AC #6).
6. Bottom strip (region `y ∈ [ch + inset, H]`), text sizes as fractions of
   `strip`:
   - **Name** — only if `name.trim()` non-empty. Bold, left-aligned at
     `x = inset`, baseline in the upper third of the strip. Truncated with an
     ellipsis (via `ctx.measureText`) to fit the available width so it never
     overflows the matte.
   - **`#Devtoberfest`** — below the name (or in the name's slot if name is
     empty), left-aligned, `hashtagColor`.
   - **"SAP Developers"** — right-aligned within the strip at `x = W − inset`,
     `textColor`. Plain bold text using the canvas default sans-serif — NOT an
     attempt to replicate the trademarked SAP logo font (decision #4: text
     lockup, no asset).
7. Return `out`.

Text is vector-drawn at output resolution, so it is crisp regardless of the
composite's pixel size.

## Error handling (fail-soft, matching existing composer posture)

- `paintPolaroid` never throws: null 2D context → returns the original
  composite canvas (border skipped, still get an image).
- The `paintPolaroid` call in `exportPng()` sits inside the existing try; any
  throw routes the parent to the plain-download fallback
  (`emit('fallback', …)`) already wired in `Composer.vue` / `Selfie.vue`. A
  border fault never blocks getting some image out.
- **Empty name** is a normal case, not an error: the name line is omitted; the
  strip still shows `#Devtoberfest` + lockup.
- Unknown style id is not reachable (the picker only offers the three keys);
  a defensive `POLAROID_STYLES[id] ?? POLAROID_STYLES.classic` lookup guards
  the bake path anyway.
- Konva stage untouched → zero regression surface for #1517 stickers/captions.

## Testing (vitest + happy-dom, established selfie pattern)

- **`polaroid.test.ts`** (new) — core, against a stub composite canvas with a
  spied 2D context:
  - output dimensions = `cw + 2·inset` × `ch + inset + strip` for a given
    composite size (asserts canvas **grows** — AC #6);
  - `drawImage` called with the composite at `(inset, inset)` and **no scale
    args** (asserts 1:1, no upscale);
  - solid style → `fillStyle` set to matte color; gradient style →
    `createLinearGradient` called with the two stops;
  - name present → `fillText` called with the name; empty name → name
    `fillText` NOT called, but `#Devtoberfest` + "SAP Developers" still drawn;
  - long name → measured-and-truncated with ellipsis so it fits the strip;
  - null 2D context → returns the original canvas (fail-soft).
- **`compose.test.ts`** (extend) — `exportPng({ border })` produces a blob
  whose backing canvas went through `paintPolaroid` (larger than the
  borderless export); `exportPng()` with no border is unchanged; both
  transformers still hidden during border export.
- **`PolaroidControls.test.ts`** (new) — toggle emits `update:enabled`; style
  picker emits `update:style` for each of the 3; name field emits
  `update:name`; disabled/enabled wiring.
- **`Composer.test.ts`** (extend) — enabling the border shows the CSS preview
  matte; export forwards the current `{ style, name }` into `exportPng`.

Out of scope: `segment.test.ts` fails in a fresh worktree on a pre-existing
missing `@imgly/background-removal` import (no `npm run setup`) — an
environment gap, not a regression.

## Global constraints (carried into the plan)

- **Konva stays `^9.3.0` in `hugo-apps/` only.** Do not add konva elsewhere,
  do not bump to 10.x, do not `npm install` at the repo root.
- **No semicolons** in Vue/TS selfie files (match existing style).
- **Fail-soft everywhere** — never throw into the export/compose path.
- **Write LF line endings** (Windows CRLF hazard).
- Frontend-only: no backend/CDS/config; no new mount config in `selfie.html`.
- Vite build gate is deferred to CI (worktree has no `hugo-apps/node_modules`
  vite bin); unit tests run from repo root with `--project unit`.

## Acceptance-criteria coverage

| AC | Covered by |
|----|-----------|
| #1 Polaroid frame w/ name + hashtag | `paintPolaroid` bottom strip; name field |
| #2 SAP Developers branding lockup | "SAP Developers" text lockup in strip |
| #3 A couple of border styles | 3 styles in `POLAROID_STYLES` |
| #4 Toggle border + pick style | `PolaroidControls` toggle + style picker |
| #5 Name auto-populates from frame | **Superseded** by Tom's decision (editable, blank default) — documented above |
| #6 Bakes at correct resolution, no blur | canvas grows, composite drawn 1:1, vector text |
| #7 Test coverage for render + export | `polaroid.test.ts` + `compose.test.ts` extensions |

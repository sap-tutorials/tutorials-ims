# Selfie: AI generative background + style transfer (Tier 3, #1520) — Design

**Issue:** #1520 (Tier 3 stretch in epic #1512) · **Date:** 2026-08-08 · **Status:** approved for planning

## Summary

Add two client-side "generative" capabilities to the Devtoberfest selfie composer:

1. **Themed background swap** — lift the person off their real background (reusing the
   Tier-1 imgly cutout) and drop them onto a curated themed scene (pumpkin patch, TechEd
   stage, terminal/code, autumn gradient, starfield). "Generative" = curated vector art,
   not a runtime model.
2. **Cartoonify style transfer** — a real neural style-transfer preset (AnimeGANv2
   `face_paint_512_v2`, ONNX, run in-browser via `onnxruntime-web`) applied to the whole
   composite at export.

Both run **entirely in the browser**. No photo ever leaves the device, so the selfie's
existing privacy promise — *"Your photo is processed entirely on your device — it never
leaves your browser"* (`Selfie.vue`) — remains literally true and is left unchanged.

## Decision record (satisfies #1520 AC #1)

- **Hosted vs client-side:** **client-side**. AI Core infra exists (`@cap-js/ai`,
  `tutorials-aicore` binding) but a server round-trip would break the "never leaves your
  browser" promise, carry per-request cost, and expose the anonymous flow to abuse. None
  of that is acceptable for a fun community tool. **Cost ceiling: $0** — no hosted
  inference.
- **Why client-side is viable here:** the tool already runs `onnxruntime-web` + WASM in
  the browser for imgly background removal (`segment.ts`, self-hosted at `/vendor/imgly/`,
  ~76 MB, lazy-loaded). The approuter CSP already permits the eval tokens onnx needs
  (`'wasm-unsafe-eval'` + `'unsafe-eval'`, established in #1546). Cartoonify reuses that
  proven pattern with its own small model.

## Architecture — Approach A: two independent layers

Each feature is a bounded unit reusing an existing seam. The Konva stage internals and the
six existing effect presets (#1516) are not modified in their behavior.

```
[bgLayer: themed scene]  ← new, bottom-most Konva layer (below cutout)
[cutoutLayer: person]    ← existing
[frameLayer]             ← existing (advocate frame)
[overlaysLayer]          ← existing (stickers / emoji / caption), topmost

  export:  stage.toCanvas()
        →  await applyEffectAsync(composite, effect)   // cartoon = ONNX pass; else sync CSS bake
        →  paintPolaroid(composite, border)            // if bordered
        →  toBlob('image/png')
```

No network egress at any step. Model + WASM are same-origin static assets; inference is
local WebGPU→wasm.

## Components

### 1. Themed background swap

**`hugo-apps/src/selfie/backgrounds.ts`** (new) — mirrors `stickers.ts`.
- `interface BackgroundDef { id: string; label: string; file: string }`
- `BACKGROUNDS: BackgroundDef[]` — the scene list.
- `BACKGROUND_IDS: string[]` — picker order, `'none'` first.
- `backgroundUrl(imgBase, file): string` → `${imgBase}/backgrounds/${file}.png`.

**`scripts/gen-backgrounds.mjs`** (new) — hand-authored SVG → 1024×1024 (or stage-aspect)
transparent/opaque PNGs via `sharp`, same pipeline and Devtoberfest palette as
`scripts/gen-stickers.mjs`. Output → `hugo/static/images/devtoberfest/selfie/backgrounds/`.
Scenes: `pumpkin-patch`, `teched-stage`, `terminal`, `autumn-gradient`, `starfield`.

**`hugo-apps/src/selfie/BackgroundPicker.vue`** (new) — a scene picker mirroring
`EffectPicker.vue`/`StickerPicker.vue`. Renders a `None` + one thumbnail per scene, marks
the active one, emits `pick(id)`.

**`compose.ts` — new stage method `setBackground(img: HTMLImageElement | null): void`.**
- A new `bgLayer = new Konva.Layer()` is added to the stage **first** (bottom-most), before
  `cutoutLayer`, in `buildStage`. This holds one `Konva.Image` sized to fill the stage
  (`x:0, y:0, width:stageW, height:stageH`), `listening(false)`.
- `setBackground(img)` adds/replaces that node and `bgLayer.batchDraw()`.
- `setBackground(null)` removes the node (clears the scene).
- Added to the `SelfieStage` interface.

**`Composer.vue` wiring.**
- Renders `BackgroundPicker`, tracks `backgroundId` ref.
- On pick: loads the scene image (`blobToImage`-style `Image` load of the static URL),
  calls `stage.setBackground(img)`; `none` → `setBackground(null)`.
- **Picking a non-none background forces `removeBg` on**: emits `update:removeBg` true if
  not already on, so the person is cut out. If no cutout is cached, reuses the existing
  on-demand `segment` emit + "segmenting…" state (same path as toggling removeBg on today).
- Live preview: the themed scene is a real Konva layer, so it shows live in the stage with
  no CSS approximation needed (unlike effects).

### 2. Cartoonify style transfer

**`hugo-apps/src/selfie/stylize.ts`** (new).
- `export async function cartoonify(canvas: HTMLCanvasElement): Promise<HTMLCanvasElement>`
- Lazy `await import('onnxruntime-web')` (new direct hugo-apps dependency) — never at page
  load, mirroring `segment.ts`.
- Creates an inference session from the self-hosted model at `/vendor/animegan/` (WASM/model
  path set on `ort.env`, no CDN). Prefers the `webgpu` execution provider, falls back to
  `wasm`.
- Pipeline: draw `canvas` into a 512×512 offscreen canvas (contain-fit), read pixels →
  normalized `Float32Array` NCHW tensor → `session.run` → denormalize output tensor → put
  onto a 512² canvas → upscale (`drawImage`) onto a copy of the input dimensions → return.
- Fail-soft: **any** failure (import throw, fetch fail, no EP available, inference throw)
  → returns the **input canvas unchanged**.

**`scripts/vendor-animegan.mjs`** (new) — downloads + self-hosts the AnimeGANv2
`face_paint_512_v2` ONNX model to `hugo/static/vendor/animegan/`, plus a
`.animegan-vendored-version` sentinel for idempotency. Same discipline as
`vendor-imgly.cjs`: no CDN at runtime, structural guard, wiped + re-fetched on version
drift. Wired into the `setup`/build scripts alongside `vendor:imgly`.

**License gate (blocking, in the plan):** the AnimeGANv2 model binary is **not committed**
until a plan step verifies its license is permissive (MIT/Apache/CC-family) and records the
source URL + license in the vendor script header. If the pinned model's license does not
clear, the fallback is another small face-oriented cartoon ONNX with a clear permissive
license, or — last resort — ship the background-swap half and land cartoonify in a
follow-up. The vendoring step gates the commit either way.

**`effects.ts` — async effect path.**
- `EffectId` gains `'cartoon'`. `EFFECT_IDS` appends `'cartoon'`.
- The `cartoon` entry has `label: 'Cartoon'`, an empty `preview` (no CSS approximation —
  cartoonify only materializes at export, consistent with the "preview is an approximation"
  contract already documented in the file header), and **no sync `apply`** (its bake is async).
- New `export async function applyEffectAsync(canvas, id): Promise<HTMLCanvasElement>`:
  - `id === 'cartoon'` → `try { return await cartoonify(canvas) } catch { return canvas }`.
  - otherwise → `return applyEffect(canvas, id)` (the existing sync dispatcher).
  - The sync `applyEffect` is unchanged and never routes `'cartoon'` (returns input).

**`compose.ts` — `exportPng`.**
- `needsCanvas` also true when `effect === 'cartoon'`.
- The single `composite = applyEffect(composite, effect)` line becomes
  `composite = await applyEffectAsync(composite, effect)`. The surrounding Promise executor
  becomes `async` (or the pixel-pass branch is extracted to an async helper). Bake order
  (effect before border) is preserved.

**`Composer.vue` — UX during inference.**
- The cartoon picker button shows a spinner while inference runs; the Export button is
  disabled during the export bake (already async).
- On cartoonify failure a non-blocking note ("couldn't apply the cartoon effect — exported
  without it") is shown; export still completes with the un-stylized composite.

## Privacy

Unchanged. `Selfie.vue`'s privacy note stays. No consent UX, no server upload, no reword —
this is the entire rationale for choosing client-side over hosted.

## Error handling (fail-soft — matches Tier 1/2 posture)

| Failure | Behavior |
|---|---|
| Background image 404 / decode fail | `setBackground` logs, scene stays empty, compositing proceeds |
| `onnxruntime-web` import fail | `cartoonify` returns input canvas; export un-stylized |
| Model fetch fail / WebGPU+wasm both unavailable | `cartoonify` returns input canvas |
| Inference throws | `cartoonify` returns input canvas |
| Cartoonify slow (seconds) | spinner on effect button; Export disabled during bake |

A bad background or a failed cartoonify never crashes the island and never blocks export.

## Testing

- `backgrounds.test.ts` — def-list shape, `backgroundUrl` builder, `none` handling.
- `BackgroundPicker.test.ts` — renders scenes, marks active, emits `pick`, forces removeBg.
- `stylize.test.ts` — `cartoonify` fail-soft paths with a mocked `onnxruntime-web`
  (import throws → input; session.run throws → input); dimension round-trip with a fake
  session returning a known tensor.
- `effects.test.ts` — extend: `applyEffectAsync('cartoon')` calls `cartoonify` and is
  fail-soft; `applyEffectAsync` delegates sync presets to `applyEffect`; sync `applyEffect`
  ignores `'cartoon'`.
- `compose.test.ts` — `setBackground` adds/replaces/clears the bottom bgLayer node; export
  awaits `applyEffectAsync`; cartoon export takes the canvas path.
- `Composer.test.ts` — background picker wiring; picking a scene forces `update:removeBg`;
  picking cartoon forwards `effect: 'cartoon'` to `exportPng`; failure shows the note.

All new + existing selfie unit tests pass; `vite build` clean. Run from repo root:
`npm test -- --project unit hugo-apps/src/selfie`.

## Global constraints

- **Client-side only** — no network egress; cost ceiling $0.
- **Fail-soft everywhere** — no failure path crashes the island or blocks export.
- **Self-host all assets** — no CDN; CSP-clean (reuses the imgly `'wasm-unsafe-eval'` +
  `'unsafe-eval'` posture, #1546).
- **Lazy-load** `onnxruntime-web` + the AnimeGAN model — never on page load (imgly precedent).
- **Devtoberfest palette** for all generated background art (OG `#e8791a`, DK `#2b1a0f`).
- **Konva stage never mutated by effects** — effects bake on the exported canvas only;
  the themed background is a real stage layer (that IS the point of the feature).
- **License gate** — the model binary is committed only after its permissive license is
  verified and recorded.

## Out of scope

- Hosted/server-side generation (rejected — see decision record).
- Text-prompt "imagine any background" generation (needs a hosted model; violates $0 + privacy).
- More than one style-transfer preset (one cartoonify preset now; others are follow-ups).
- Photographic (raster) themed backgrounds (vector art now; real art can swap in later).

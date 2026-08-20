---
title: Updating Devtoberfest Selfie art (backgrounds, stickers, frames)
description: Where the selfie photo-booth art assets live, and how to replace or add backgrounds, stickers, and advocate frames.
---

# Updating Devtoberfest Selfie art

The **Devtoberfest Selfie** photo booth is a Vue 3 island at `hugo-apps/src/selfie/`, mounted by the Hugo layout `hugo/layouts/devtoberfest/selfie.html`. This guide covers how to swap or add its three art families: **backgrounds** (scene art behind the person), **stickers** (draggable brand art), and **frames** (advocate cut-outs you compose into).

## Where the assets live

All art is served as **static files** from a single tree — nothing is imported as a JS module, so the URL path is the contract:

```
hugo/static/images/devtoberfest/selfie/
├── backgrounds/    # 1080×1080 opaque PNG
├── stickers/       # 512×512 transparent PNG
├── frames/         # advocate cut-out PNGs
└── thumbnails/     # frame-picker thumbnails (same filenames as frames/)
```

The island resolves everything from a base path (`imgBase`, default `/images/devtoberfest/selfie`), so a file dropped in `backgrounds/pumpkin-patch.png` is served at `/images/devtoberfest/selfie/backgrounds/pumpkin-patch.png`.

| Family | Enumerated in | Asset directory | URL pattern | Format |
| --- | --- | --- | --- | --- |
| Backgrounds | `hugo-apps/src/selfie/backgrounds.ts` (`BACKGROUNDS` array) | `.../selfie/backgrounds/` | `{base}/backgrounds/{file}.png` | 1080×1080 opaque PNG |
| Stickers | `hugo/layouts/devtoberfest/selfie.html` (`data-stickers` CSV) | `.../selfie/stickers/` | `{base}/stickers/{file}.png` | 512×512 transparent PNG |
| Frames | `hugo/layouts/devtoberfest/selfie.html` (`data-frames` CSV) | `.../selfie/frames/` + `.../thumbnails/` | `{base}/frames/{name}.png`, `{base}/thumbnails/{name}.png` | PNG |

> **The two families are configured in different places.** Backgrounds are declared in a TypeScript array in the island source; stickers and frames are declared as comma-separated `data-*` attributes in the Hugo layout. Editing the wrong one is the most common mistake.

## Backgrounds

The picker order and labels come from the `BACKGROUNDS` array in `hugo-apps/src/selfie/backgrounds.ts`:

```ts
export const BACKGROUNDS: BackgroundDef[] = [
  { id: 'pumpkin-patch',   label: 'Pumpkin patch', file: 'pumpkin-patch' },
  { id: 'teched-stage',    label: 'On stage',      file: 'teched-stage' },
  { id: 'terminal',        label: 'Terminal',      file: 'terminal' },
  { id: 'autumn-gradient', label: 'Autumn',        file: 'autumn-gradient' },
  { id: 'starfield',       label: 'Starfield',     file: 'starfield' },
]
```

The URL is built as `{imgBase}/backgrounds/{file}.png`. A `'none'` option is prepended automatically by the picker.

### Replace an existing background

1. Export a **1080×1080 opaque PNG**.
2. Overwrite the matching file in `hugo/static/images/devtoberfest/selfie/backgrounds/` — keep the **same filename** (e.g. `starfield.png`).
3. No code change needed. Rebuild + deploy (see [Publishing changes](#publishing-changes)).

### Add a new background

1. Add `my-scene.png` (1080×1080, opaque) to `hugo/static/images/devtoberfest/selfie/backgrounds/`.
2. Append an entry to `BACKGROUNDS` in `hugo-apps/src/selfie/backgrounds.ts`. `file` must match the filename **without** the `.png`:

   ```ts
   { id: 'my-scene', label: 'My scene', file: 'my-scene' },
   ```

3. Because this touches island TypeScript, the **island must be recompiled** — a full `npm run build:all` + deploy is required.

### Optional: author backgrounds as SVG

`scripts/gen-backgrounds.mjs` rasterizes hand-authored SVGs to PNG via `sharp`. To use it, add an entry to its `SVGS` object (keyed by filename) and run the script; it writes into the `backgrounds/` directory. This is optional — a finished PNG works just as well.

## Stickers

Stickers are **not** listed in a TS array. They're declared as a CSV in the layout `hugo/layouts/devtoberfest/selfie.html`:

```html
data-stickers="devtoberfest-badge,sap-developers-lockup,pumpkin,confetti,star,speech-bubble"
```

At mount time `hugo-apps/src/selfie/main.ts` splits this list, and `stickers.ts` maps each name to `{ name, file: name }`, rendered at `{imgBase}/stickers/{file}.png`. (The island also defines an emoji glyph set in `stickers.ts` — those are text, not image assets.)

### Replace an existing sticker

1. Export a **512×512 transparent PNG**.
2. Overwrite the matching file in `.../selfie/stickers/`, keeping the **same filename** (e.g. `pumpkin.png`).
3. No code change needed. Rebuild + deploy.

### Add a new sticker

1. Add `my-sticker.png` (512×512, transparent) to `hugo/static/images/devtoberfest/selfie/stickers/`.
2. Append the filename (no extension) to the `data-stickers` CSV in `hugo/layouts/devtoberfest/selfie.html`:

   ```html
   data-stickers="devtoberfest-badge,sap-developers-lockup,pumpkin,confetti,star,speech-bubble,my-sticker"
   ```

3. This touches only the Hugo layout + static images — **no island recompile needed**, but a build + deploy still ships the new image.

### Optional: author stickers as SVG

`scripts/gen-stickers.mjs` mirrors `gen-backgrounds.mjs` for stickers (SVG → 512×512 PNG). Add a key to its `SVGS` object and run it to regenerate.

## Frames (advocate cut-outs)

Frames are the advocate backdrops the person composes into. Like stickers, they're a CSV in the layout:

```html
data-frames="Antonio,Antonio2,Background,...,Witalij"
```

Each name needs **two** files with matching names:

- `hugo/static/images/devtoberfest/selfie/frames/<Name>.png` — the full frame.
- `hugo/static/images/devtoberfest/selfie/thumbnails/<Name>.png` — the picker thumbnail.

To add/replace a frame: add both files, then add the name to `data-frames` in `selfie.html`. Frames are externally-sourced photos (no SVG generator).

## Where to place new art

Put finished PNGs directly under `hugo/static/images/devtoberfest/selfie/<family>/`. If you want the asset to be regenerable/versioned as vector source, add the SVG to the `SVGS` object in the matching `scripts/gen-*.mjs` and commit that too. Match the format conventions in the table above — wrong dimensions or a background sticker with an opaque canvas will look broken in the compositor.

## Publishing changes

1. Run a full build so Hugo picks up the static images and (for backgrounds) the island recompiles:

   ```bash
   npm run build:all
   ```

   > **Island fingerprint gotcha** — the global npmrc sets `ignore-scripts=true`, so `postbuild:apps` lifecycle hooks don't fire locally. `build:all` calls `build:island-manifest` explicitly so hashed island bundles are referenced. Don't rely on a bare `vite build`. See the "ignore-scripts silences postbuild:apps" note in the root `CLAUDE.md`.

2. Deploy. Static images ship inside the approuter as part of the normal MTA deploy — see [MTA deployment](./mta-deployment.md). Confirm deploy scope (+content) with the maintainer.

3. **Verify on the deployed site**, not just locally: open the Devtoberfest selfie page and confirm the new/replaced art renders in the picker and composites correctly.

## Quick reference

| I want to… | Edit | Recompile island? |
| --- | --- | --- |
| Swap a background image | overwrite `backgrounds/<file>.png` | No |
| Add a background | `backgrounds/<file>.png` + `BACKGROUNDS` in `backgrounds.ts` | **Yes** |
| Swap a sticker | overwrite `stickers/<file>.png` | No |
| Add a sticker | `stickers/<file>.png` + `data-stickers` in `selfie.html` | No |
| Add/swap a frame | `frames/<Name>.png` + `thumbnails/<Name>.png` + `data-frames` in `selfie.html` | No |

## Related

- [Frontend apps](../architecture/frontend-apps.md) — how `hugo-apps/` islands are built and deployed
- [MTA deployment](./mta-deployment.md) — deploy runbook
- Design specs: `docs/superpowers/specs/2026-08-08-selfie-generative-bg-design.md`, `...-selfie-stickers-captions-design.md`, `...-selfie-polaroid-frame-design.md`

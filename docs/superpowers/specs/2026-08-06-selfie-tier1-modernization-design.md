# Selfie with an Advocate — Tier 1 modernization design

- **Date:** 2026-08-06
- **Epic:** [#1512](https://github.com/sap-tutorials/tutorials-ims/issues/1512)
- **Covers issues:** #1513 (camera), #1514 (background removal), #1515 (client-side compositing), #1519 (Web Share)
- **Status:** Approved design — ready for implementation plan

## 1. Problem

The Selfie with an Advocate tool (`/devtoberfest/selfie/`) is visually flat compared to the
old version. Today it: picks a pre-baked advocate frame → uploads a photo → a server
composites it (`POST /community/upload_selfie`, `multer + sharp`, in the **separate
gameboard-api repo**) → returns a flat PNG → crop/rotate/download (cropper.js). No camera,
no background handling, no repositioning, no share.

This slice rebuilds the tool as a **fully client-side, in-browser** experience: live camera
capture, background removal, drag/scale/rotate compositing of the user cut into the advocate
scene, and one-click sharing.

## 2. Goals & non-goals

**Goals**
- Live camera capture, camera-first, with file upload as fallback.
- In-browser background removal producing a transparent-PNG cutout of the user.
- Client-side canvas compositing: the cutout is a draggable / scalable / rotatable layer
  over the advocate frame.
- Export: Download + one-click Web Share (with a guaranteed download fallback).
- Everything runs in the browser — the photo never leaves the device.

**Non-goals (later tiers)**
- Filters/effects (#1516), stickers/captions (#1517), branded polaroid border (#1518),
  AI generative backgrounds (#1520).
- Any change to the gameboard-api `/community/upload_selfie` endpoint beyond confirming
  nothing else depends on it. This flow simply stops calling it.

## 3. Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Compositing model | **Fully client-side** | Cleanest architecture; strongest privacy story; removes server round-trip |
| Frame assets | **Vendor full-res frames into this repo** | Assets live with the app that uses them; no runtime cross-repo/CORS dependency |
| Background-removal lib | **`@imgly/background-removal`** | Higher edge quality (hair/fine detail) than MediaPipe; worth the first-load weight for a hero feature |
| Photo input | **Camera-first + upload fallback** | Widest reach; desktop-no-webcam and permission-denied users still work |
| Editing UX | **Drag + scale + rotate cutout** | Delivers the "stand next to the advocate" feel; requires a layered interactive canvas |
| Slice boundary | **Tier 1 + Web Share (#1519)** | Export/canvas plumbing is already present; share is what drives the campaign |

## 4. Architecture & data flow

Fully client-side pipeline:

```
1. Capture    → live camera (getUserMedia) OR file upload  → raw photo bitmap/blob
2. Segment    → @imgly/background-removal (lazy-loaded)     → transparent-PNG cutout
3. Compose    → Konva stage: advocate frame + draggable cutout layer
                (drag / scale / rotate the cutout)          → composited scene
4. Export     → canvas → PNG                                → Download + Web Share
```

- Full-res advocate frames are vendored into
  `hugo/static/images/devtoberfest/selfie/frames/` (only `thumbnails/` live here today).
- The `/community/upload_selfie` call is **removed from this flow**. The endpoint remains in
  gameboard-api; we stop calling it after confirming no other consumer depends on it.
- The layout's `data-api-upload` attribute and `upload.ts` are removed; `main.ts` mount
  config drops `apiUpload`.

**Open item resolved at frame-vendoring time:** confirm the frame layering model — whether
advocate frames are transparent overlays that sit *in front of* the user (photo-booth style,
user behind the frame) or backgrounds the user sits *on top of*. This determines the Konva
z-order. Verify against the actual assets; do not guess. The `Group*` frames (multiple
advocates) may layer differently from single-advocate frames — check each family.

## 5. Components & module boundaries

Vue components (`hugo-apps/src/selfie/`):

- **`Selfie.vue`** — orchestrator / state machine. Owns step state
  (`capture → segment → compose → export`) and the single error banner. Stays thin.
- **`Capture.vue`** — *new*, replaces `Uploader.vue`. Camera-first: live `<video>` preview +
  capture button, existing file input as fallback. Emits a raw photo blob. Owns the
  permission-denied → upload fallback UX.
- **`FramePicker.vue`** — largely unchanged; repointed at full-res frames (thumbnails still
  used for the picker grid).
- **`Composer.vue`** — *new*, replaces `Editor.vue`. Hosts the Konva stage: advocate frame +
  draggable/scalable/rotatable cutout layer. Emits the final composited canvas.
- **`ExportBar.vue`** — *new*. Download + Web Share buttons; feature-detects
  `navigator.canShare({ files })`.

Framework-free helper modules (pure, unit-testable without Vue / DOM-heavy deps):

- **`camera.ts`** — thin wrapper over `getUserMedia` + capture-to-blob. Cribs the
  acquire/release lifecycle from `hugo-apps/src/tutorial-prefs/camera-session.ts`.
- **`segment.ts`** — lazy-loads `@imgly/background-removal`, runs it, returns a cutout blob.
  Owns the loading-progress signal and the fail-soft fallback (segmentation fails → original
  photo).
- **`compose.ts`** — Konva stage setup + export-to-PNG. Keeps all Konva usage in one place.
- **`share.ts`** — Web Share with download fallback; friendly-error posture mirroring today's
  `upload.ts`.

**Deleted:** `upload.ts` and its server coupling (the `csrf-exempt-anon` marker goes away
with it).

New dependencies added to `hugo-apps/package.json`: `@imgly/background-removal`, `konva`.
Both must be **self-hosted/vendored** (model + WASM), not loaded from a CDN, to satisfy the
approuter CSP and keep processing in-browser.

## 6. Error handling, performance & privacy

**Fail-soft everywhere** — an island failure must never crash the page (existing posture in
`Editor.vue`/`Uploader.vue`):

| Failure | Behavior |
|---|---|
| Camera denied / no webcam | Fall back to file upload, friendly note. No crash. |
| `@imgly` model load / segmentation throws | Fall back to the **original photo** (no cutout); note: "Couldn't remove the background — using your full photo." Compose + download still work. |
| Konva stage init fails | Fall back to a flat photo-in-frame render + download (degraded but functional). |
| Web Share unsupported / cancelled | Download button always present as the guaranteed path. |

**Performance** (the `@imgly` model is ~5–6 MB — the main risk):
- **Lazy-load the model** only when the user has a photo and invokes background removal —
  never on page load. Keep the island's initial bundle light.
- **Self-host** model + WASM (vendored, following the `scripts/vendor-mediapipe.cjs`
  pattern). No CDN.
- Explicit **loading/progress state** during model download + inference so the
  seconds-long first run does not look frozen.
- Konva and `@imgly` are new deps to vet; frames are static, cache-friendly assets.

**Privacy:** update the on-screen note to reflect the new reality — the photo **never leaves
the browser** (no upload at all). Stronger and now accurate. (Current copy: "Your photo is
uploaded to build the image and is not stored.")

## 7. Testing

Conventions: Vitest unit/component + a committed `test/e2e/` spec (this touches
`hugo-apps/**` and is exactly the "user-facing UI wants an e2e spec" gotcha in CLAUDE.md).

**Unit tests** (pure helpers — no webcam, no 6 MB model in CI):
- `camera.ts` — capture-to-blob with `getUserMedia` mocked; permission-denial returns the
  fallback signal.
- `segment.ts` — model loader mocked; **highest-value test**: fail-soft fallback returns the
  original image when segmentation throws.
- `compose.ts` — Konva mocked/stubbed; asserts layer order + export produces a PNG blob.
- `share.ts` — `navigator.canShare`/`share` mocked; share path when supported, download
  fallback when not (mirrors the branch-coverage style of the existing `upload.test.ts`).

**Component tests** (Vue Testing Library, as today):
- `Capture.vue` — camera-first render; falls back to file input on denial.
- `Composer.vue` — mounts a stage; wires drag/scale/rotate handlers.
- `Selfie.vue` — state-machine transitions `capture → segment → compose → export`.

**E2E** (`test/e2e/selfie.test.js` — already exists; extend it): post-DEV-deploy Playwright,
self-skips without `SMOKE_BASE_URL`. Fake camera via Chromium
`--use-fake-device-for-media-stream`; walk capture → compose → download and assert a PNG
downloads. Selector caution: served pages render `<main>`, not `<article>`.

**Manual QA gate** (test the real thing through the real browser): exercise camera + real
background removal on the deployed DEV approuter before calling it done — CI cannot run the
real model.

## 8. Risks & mitigations

- **Model weight / first-load latency** → lazy-load + progress UI + self-host.
- **Segmentation edge quality on hair** → `@imgly` chosen precisely for this; manual QA gate
  confirms on real photos before ship.
- **Frame layering ambiguity** → resolved by inspecting real assets at vendoring time, per §4.
- **Removing the server call breaks a hidden consumer** → grep + confirm before deletion;
  the gameboard-api endpoint itself is left intact.
- **CSP blocks model/WASM** → self-host everything; no CDN. (Prior art:
  `ui5-csp-blocks-dynamic-import` gotcha.)
- **Touch fiddliness of drag/scale/rotate on mobile** → Konva Transformer handles + pinch;
  validated in manual QA.

## 9. Out of scope / follow-ups

Tier 2/3 issues (#1516–#1518, #1520) build on this slice's client-side canvas foundation.

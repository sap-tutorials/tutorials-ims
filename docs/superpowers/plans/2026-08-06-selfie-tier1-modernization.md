# Selfie with an Advocate — Tier 1 Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Selfie with an Advocate tool (`/devtoberfest/selfie/`) as a fully client-side, in-browser experience: live camera capture, background removal, drag/scale/rotate compositing of the user into the advocate scene, and one-click download + Web Share.

**Architecture:** A Vue island (`hugo-apps/src/selfie/`) drives a four-step state machine (capture → segment → compose → export). Heavy/awkward-to-test concerns (camera, the `@imgly` segmentation model, the Konva canvas, Web Share) live behind small pure helper modules so the Vue components stay thin and the logic is unit-testable without a real webcam or a multi-MB model. The photo never leaves the browser; the `/community/upload_selfie` server round-trip is removed.

**Tech Stack:** Vue 3 (`<script setup>` + TS), Vite, Vitest + `@vue/test-utils` (happy-dom), Playwright (post-deploy e2e), `@imgly/background-removal` (vendored/self-hosted), Konva.

## Global Constraints

- **All processing in-browser** — the photo is never uploaded. Remove the `/community/upload_selfie` call and `upload.ts` from this flow. Leave the gameboard-api endpoint itself intact.
- **Self-host all model/WASM assets** — no CDN references, to satisfy the approuter CSP. Vendor following the `scripts/vendor-mediapipe.cjs` pattern.
- **Lazy-load the `@imgly` model** only when background removal is invoked — never on page load.
- **Fail-soft everywhere** — an island failure must never crash the page. Every stage has a documented degraded fallback.
- **Privacy copy must be accurate** — the on-screen note must say the photo never leaves the browser (no upload).
- **New deps** added to `hugo-apps/package.json`: `@imgly/background-removal` (^1.7.0), `konva`.
- **Test conventions:** unit/component tests under `hugo-apps/src/selfie/__tests__/`, discovered by `npm test` (`vitest run --project unit`). DOM tests require the first line `// @vitest-environment happy-dom`. E2E lives in `test/e2e/selfie.test.js`, self-skips without `SMOKE_BASE_URL`, and served pages render `<main>` (never `<article>`).
- **Frame layering (open item):** confirm whether advocate frames are transparent overlays that sit *in front of* the user (photo-booth) or backgrounds the user sits *on top of*, per family (single-advocate vs `Group*`). Resolve by inspecting real assets in Task 1; do not guess.

---

## File Structure

**Helper modules (pure, framework-free) — `hugo-apps/src/selfie/`**
- `camera.ts` — `getUserMedia` wrapper + capture-to-blob; permission-denial signal.
- `segment.ts` — lazy-load `@imgly/background-removal`, run it, return cutout blob; fail-soft to original.
- `compose.ts` — Konva stage build + export-to-PNG; layer order.
- `share.ts` — Web Share with download fallback.
- `constants.ts` — asset base paths, stage dimensions (new).
- `types.ts` — extend `MountConfig` (drop `apiUpload`).

**Vue components — `hugo-apps/src/selfie/`**
- `Selfie.vue` — orchestrator / state machine (rewrite).
- `Capture.vue` — camera-first + upload fallback (new; replaces `Uploader.vue`).
- `FramePicker.vue` — unchanged behavior, repointed at full-res frames.
- `Composer.vue` — Konva editor (new; replaces `Editor.vue`).
- `ExportBar.vue` — download + share (new).
- `main.ts` — mount config (drop `apiUpload`).

**Deleted:** `Uploader.vue`, `Editor.vue`, `upload.ts`, `__tests__/upload.test.ts`.

**Assets / build**
- `hugo/static/images/devtoberfest/selfie/frames/*.png` — vendored full-res frames.
- `hugo/static/vendor/imgly/` — vendored `@imgly` model + WASM.
- `scripts/vendor-imgly.cjs` — vendoring script (mirrors `vendor-mediapipe.cjs`).
- `package.json` — `vendor:imgly` script + wire into `build:apps`.
- `hugo/layouts/devtoberfest/selfie.html` — drop `data-api-upload`, keep `data-frames`/`data-img-base`.

**Tests — `hugo-apps/src/selfie/__tests__/`**
- `camera.test.ts`, `segment.test.ts`, `compose.test.ts`, `share.test.ts`
- `Capture.test.ts`, `Composer.test.ts`, `Selfie.test.ts`
- Extend `test/e2e/selfie.test.js`.

---

## Task 1: Vendor full-res frames + resolve layering

**Files:**
- Create: `hugo/static/images/devtoberfest/selfie/frames/*.png` (25 frames matching `data-frames`)
- Reference: `hugo/layouts/devtoberfest/selfie.html` (frame list), gameboard-api source frames

**Interfaces:**
- Produces: full-res frame PNGs at `/images/devtoberfest/selfie/frames/<Name>.png`; a documented layering decision (`FRAME_LAYERING`) — either `"overlay"` (frame in front of user) or `"background"` (user in front of frame), per frame family.

- [ ] **Step 1: Locate source frames.** Find the full-res advocate frames in the gameboard-api repo/deployment (the `multer + sharp` compositor's asset dir). Confirm all 25 names from `selfie.html` `data-frames` are present: `Antonio,Antonio2,Background,Background2,Daniel,DJ,DJ2,Group1,Group2,Group3,Group4,Josh,Josh2,Josh3,Kasmire,Kevin,Kevin2,Mamikee,Michelle,Nico,Nora,Rich,Rich2,Thomas,Witalij`.

- [ ] **Step 2: Determine layering.** Open 2-3 frames (a single-advocate, a `Background*`, and a `Group*`) in an image viewer. Check for transparency (alpha channel) and where the advocate sits. Record the decision: is the user composited *behind* a transparent frame, or *on top of* an opaque background? Note per-family differences.

- [ ] **Step 3: Copy frames in.** Place full-res PNGs into `hugo/static/images/devtoberfest/selfie/frames/`. Keep the existing `thumbnails/` untouched (picker still uses them).

- [ ] **Step 4: Verify assets resolve.** From repo root run `ls hugo/static/images/devtoberfest/selfie/frames/ | wc -l` — expected: 25 (or documented count if some frames are picker-only/background-only).

- [ ] **Step 5: Record the layering decision** as a comment block in `hugo-apps/src/selfie/constants.ts` (created in Task 4) — but for now capture it in the commit message.

- [ ] **Step 6: Commit**

```bash
git add hugo/static/images/devtoberfest/selfie/frames/
git commit -m "assets(selfie): vendor full-res advocate frames; layering=<overlay|background> (#1515)"
```

---

## Task 2: Add and vendor dependencies

**Files:**
- Modify: `hugo-apps/package.json` (add deps)
- Create: `scripts/vendor-imgly.cjs`
- Modify: `package.json:64` (`build:apps` script), add `vendor:imgly` script
- Create: `hugo/static/vendor/imgly/` (vendored model + WASM)

**Interfaces:**
- Produces: `@imgly/background-removal` + `konva` installed; `@imgly` assets self-hosted under `/vendor/imgly/`; `npm run vendor:imgly` idempotent (skips present files).

- [ ] **Step 1: Add deps to `hugo-apps/package.json` dependencies:**

```json
"@imgly/background-removal": "^1.7.0",
"konva": "^9.3.0",
```

- [ ] **Step 2: Install.**

Run: `npm --prefix hugo-apps install --no-audit --no-fund`
Expected: both packages resolve; `hugo-apps/node_modules/@imgly/background-removal` and `.../konva` exist.

- [ ] **Step 3: Identify `@imgly` runtime assets.** Inspect `hugo-apps/node_modules/@imgly/background-removal/dist/` for the model (`.onnx`) + WASM (`.wasm`) + resource files it fetches at runtime.

Run: `ls hugo-apps/node_modules/@imgly/background-removal/dist/`

- [ ] **Step 4: Write `scripts/vendor-imgly.cjs`** mirroring `scripts/vendor-mediapipe.cjs`: copy the runtime `.wasm`/`.onnx`/resource files from `dist/` into `hugo/static/vendor/imgly/`, with an explicit `RUNTIME_FILES` allowlist guard that throws if the package contents change (so a human vets an upgrade before it ships to browsers). Skip files already present.

- [ ] **Step 5: Add npm scripts** to root `package.json`:

```json
"vendor:imgly": "node scripts/vendor-imgly.cjs",
```

And change `build:apps` to run it:

```json
"build:apps": "npm run vendor:mediapipe && npm run vendor:imgly && npm --prefix hugo-apps run build",
```

- [ ] **Step 6: Run the vendor script.**

Run: `npm run vendor:imgly`
Expected: assets appear under `hugo/static/vendor/imgly/`; re-running prints "skipped" for each.

- [ ] **Step 7: Run shellcheck-equivalent sanity + lint the cjs.**

Run: `node -c scripts/vendor-imgly.cjs`
Expected: no syntax error.

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/package.json hugo-apps/package-lock.json scripts/vendor-imgly.cjs package.json hugo/static/vendor/imgly/
git commit -m "build(selfie): add konva + @imgly, vendor imgly model/WASM self-hosted (#1514)"
```

---

## Task 3: `camera.ts` — capture helper

**Files:**
- Create: `hugo-apps/src/selfie/camera.ts`
- Test: `hugo-apps/src/selfie/__tests__/camera.test.ts`

**Interfaces:**
- Produces:
  - `async function startCamera(): Promise<MediaStream>` — calls `navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: 1280, height: 720 } })`.
  - `function stopCamera(stream: MediaStream): void` — stops all tracks.
  - `async function captureFrame(video: HTMLVideoElement): Promise<Blob>` — draws the current video frame to a canvas (un-mirrored) and returns a PNG blob.
  - `class CameraUnavailableError extends Error` — thrown when `getUserMedia` rejects (denial/no device).

- [ ] **Step 1: Write the failing test** `__tests__/camera.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startCamera, captureFrame, CameraUnavailableError } from '../camera'

describe('camera', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('startCamera resolves the getUserMedia stream', async () => {
    const fakeStream = { getTracks: () => [] } as unknown as MediaStream
    const gum = vi.fn().mockResolvedValue(fakeStream)
    ;(navigator as any).mediaDevices = { getUserMedia: gum }
    await expect(startCamera()).resolves.toBe(fakeStream)
    expect(gum).toHaveBeenCalledWith(expect.objectContaining({ audio: false }))
  })

  it('startCamera throws CameraUnavailableError when getUserMedia rejects', async () => {
    ;(navigator as any).mediaDevices = { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) }
    await expect(startCamera()).rejects.toBeInstanceOf(CameraUnavailableError)
  })

  it('captureFrame returns a PNG blob from the video frame', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    const canvasProto = HTMLCanvasElement.prototype as any
    vi.spyOn(canvasProto, 'getContext').mockReturnValue({ drawImage: vi.fn() })
    vi.spyOn(canvasProto, 'toBlob').mockImplementation((cb: (b: Blob | null) => void) => cb(blob))
    const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement
    await expect(captureFrame(video)).resolves.toBe(blob)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- camera.test`
Expected: FAIL — cannot resolve `../camera`.

- [ ] **Step 3: Implement `camera.ts`:**

```ts
export class CameraUnavailableError extends Error {
  constructor(cause?: unknown) { super('Camera unavailable'); this.name = 'CameraUnavailableError'; (this as any).cause = cause }
}

const CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: 'user', width: 1280, height: 720 },
}

export async function startCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(CONSTRAINTS)
  } catch (e) {
    throw new CameraUnavailableError(e)
  }
}

export function stopCamera(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop())
}

export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth || 1280
  canvas.height = video.videoHeight || 720
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get canvas context')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('capture failed'))), 'image/png')
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- camera.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/camera.ts hugo-apps/src/selfie/__tests__/camera.test.ts
git commit -m "feat(selfie): camera capture helper with fail-soft denial (#1513)"
```

---

## Task 4: `constants.ts` + `types.ts` — config

**Files:**
- Create: `hugo-apps/src/selfie/constants.ts`
- Modify: `hugo-apps/src/selfie/types.ts`
- Test: `hugo-apps/src/selfie/__tests__/constants.test.ts`

**Interfaces:**
- Produces:
  - `constants.ts`: `IMGLY_PUBLIC_PATH = '/vendor/imgly/'`, `STAGE_WIDTH = 1080`, `STAGE_HEIGHT = 1080`, `FRAME_LAYERING: 'overlay' | 'background'` (from Task 1), plus a comment documenting the Task 1 decision.
  - `types.ts`: `MountConfig` becomes `{ imgBase: string; frames: string[] }` (drop `apiUpload`); add `type SelfieStep = 'capture' | 'segment' | 'compose' | 'export'`.

- [ ] **Step 1: Write the failing test** `__tests__/constants.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { IMGLY_PUBLIC_PATH, STAGE_WIDTH, STAGE_HEIGHT, FRAME_LAYERING } from '../constants'

describe('selfie constants', () => {
  it('exposes a self-hosted imgly path (no CDN)', () => {
    expect(IMGLY_PUBLIC_PATH).toBe('/vendor/imgly/')
    expect(IMGLY_PUBLIC_PATH.startsWith('http')).toBe(false)
  })
  it('defines a square stage', () => {
    expect(STAGE_WIDTH).toBeGreaterThan(0)
    expect(STAGE_HEIGHT).toBe(STAGE_WIDTH)
  })
  it('records the frame layering decision', () => {
    expect(['overlay', 'background']).toContain(FRAME_LAYERING)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- constants.test`
Expected: FAIL — cannot resolve `../constants`.

- [ ] **Step 3: Implement `constants.ts`** (set `FRAME_LAYERING` to the Task 1 value):

```ts
// Self-hosted @imgly assets (no CDN — approuter CSP). Vendored by scripts/vendor-imgly.cjs.
export const IMGLY_PUBLIC_PATH = '/vendor/imgly/'

// Square export canvas — good default for social share.
export const STAGE_WIDTH = 1080
export const STAGE_HEIGHT = 1080

// Frame layering decision from Task 1 (inspect real assets, do not guess):
//   'overlay'    → advocate frame is a transparent PNG drawn IN FRONT of the user cutout
//   'background' → advocate frame is opaque; user cutout is drawn ON TOP
export const FRAME_LAYERING: 'overlay' | 'background' = 'overlay'
```

- [ ] **Step 4: Modify `types.ts`:**

```ts
export interface MountConfig { imgBase: string; frames: string[] }
export type SelfieStep = 'capture' | 'segment' | 'compose' | 'export'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- constants.test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/selfie/constants.ts hugo-apps/src/selfie/types.ts hugo-apps/src/selfie/__tests__/constants.test.ts
git commit -m "feat(selfie): config constants + MountConfig without apiUpload (#1512)"
```

---

## Task 5: `segment.ts` — background removal with fail-soft

**Files:**
- Create: `hugo-apps/src/selfie/segment.ts`
- Test: `hugo-apps/src/selfie/__tests__/segment.test.ts`

**Interfaces:**
- Consumes: `IMGLY_PUBLIC_PATH` from `constants.ts`.
- Produces:
  - `async function removeBackground(input: Blob, onProgress?: (p: number) => void): Promise<{ blob: Blob; removed: boolean }>` — lazy-imports `@imgly/background-removal`, returns `{ blob: cutout, removed: true }` on success, or `{ blob: input, removed: false }` on any failure (fail-soft).

- [ ] **Step 1: Write the failing test** `__tests__/segment.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

const removeBackgroundMock = vi.fn()
vi.mock('@imgly/background-removal', () => ({ removeBackground: removeBackgroundMock }))

import { removeBackground } from '../segment'

describe('segment.removeBackground', () => {
  it('returns the cutout with removed=true on success', async () => {
    const cut = new Blob(['cut'], { type: 'image/png' })
    removeBackgroundMock.mockResolvedValueOnce(cut)
    const input = new Blob(['in'], { type: 'image/png' })
    const out = await removeBackground(input)
    expect(out).toEqual({ blob: cut, removed: true })
  })

  it('FAIL-SOFT: returns the original blob with removed=false when the model throws', async () => {
    removeBackgroundMock.mockRejectedValueOnce(new Error('model load failed'))
    const input = new Blob(['in'], { type: 'image/png' })
    const out = await removeBackground(input)
    expect(out).toEqual({ blob: input, removed: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- segment.test`
Expected: FAIL — cannot resolve `../segment`.

- [ ] **Step 3: Implement `segment.ts`:**

```ts
import { IMGLY_PUBLIC_PATH } from './constants'

export async function removeBackground(
  input: Blob,
  onProgress?: (p: number) => void,
): Promise<{ blob: Blob; removed: boolean }> {
  try {
    // Lazy import: the ~5-6MB model + WASM must never load on page load.
    const { removeBackground: imglyRemove } = await import('@imgly/background-removal')
    const blob = await imglyRemove(input, {
      publicPath: new URL(IMGLY_PUBLIC_PATH, window.location.origin).href,
      progress: (_key: string, current: number, total: number) => {
        if (onProgress && total > 0) onProgress(current / total)
      },
    })
    return { blob, removed: true }
  } catch (e) {
    // Fail-soft: segmentation failure must never block the flow.
    console.warn('[selfie] background removal failed; using original photo', e)
    return { blob: input, removed: false }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- segment.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/segment.ts hugo-apps/src/selfie/__tests__/segment.test.ts
git commit -m "feat(selfie): @imgly background removal, lazy-loaded + fail-soft (#1514)"
```

---

## Task 6: `compose.ts` — Konva stage + export

**Files:**
- Create: `hugo-apps/src/selfie/compose.ts`
- Test: `hugo-apps/src/selfie/__tests__/compose.test.ts`

**Interfaces:**
- Consumes: `STAGE_WIDTH`, `STAGE_HEIGHT`, `FRAME_LAYERING` from `constants.ts`.
- Produces:
  - `interface SelfieStage { addCutout(img: HTMLImageElement): void; exportPng(): Promise<Blob>; destroy(): void }`
  - `async function buildStage(container: HTMLDivElement, frameUrl: string, opts?: { layering?: 'overlay' | 'background' }): Promise<SelfieStage>` — creates a Konva stage sized `STAGE_WIDTH×STAGE_HEIGHT`, adds the frame layer and a cutout layer with a `Transformer` (drag/scale/rotate). Layer order honors `FRAME_LAYERING`.

- [ ] **Step 1: Write the failing test** `__tests__/compose.test.ts` (Konva mocked — no real canvas):

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'

const addMock = vi.fn()
const layerAddMock = vi.fn()
const toBlobMock = vi.fn((opts: any) => opts.callback(new Blob(['png'], { type: 'image/png' })))

vi.mock('konva', () => {
  class Stage { add = addMock; toBlob = toBlobMock; destroy = vi.fn(); width() { return 1080 } height() { return 1080 } }
  class Layer { add = layerAddMock; draw = vi.fn(); batchDraw = vi.fn() }
  class KImage { constructor() {} }
  ;(KImage as any).fromURL = (_u: string, cb: (n: any) => void) => cb({ setAttrs: vi.fn(), width: () => 1080, height: () => 1080 })
  class Transformer { nodes = vi.fn() }
  return { default: { Stage, Layer, Image: KImage, Transformer }, Stage, Layer, Image: KImage, Transformer }
})

import { buildStage } from '../compose'

describe('compose.buildStage', () => {
  it('builds a stage and exports a PNG blob', async () => {
    const container = document.createElement('div')
    const stage = await buildStage(container, '/images/devtoberfest/selfie/frames/Thomas.png')
    const out = await stage.exportPng()
    expect(out).toBeInstanceOf(Blob)
    expect(out.type).toBe('image/png')
    expect(addMock).toHaveBeenCalled() // layers added to stage
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- compose.test`
Expected: FAIL — cannot resolve `../compose`.

- [ ] **Step 3: Implement `compose.ts`:**

```ts
import Konva from 'konva'
import { STAGE_WIDTH, STAGE_HEIGHT, FRAME_LAYERING } from './constants'

export interface SelfieStage {
  addCutout(img: HTMLImageElement): void
  exportPng(): Promise<Blob>
  destroy(): void
}

function loadKImage(url: string): Promise<Konva.Image> {
  return new Promise((resolve) => Konva.Image.fromURL(url, (node: Konva.Image) => resolve(node)))
}

export async function buildStage(
  container: HTMLDivElement,
  frameUrl: string,
  opts?: { layering?: 'overlay' | 'background' },
): Promise<SelfieStage> {
  const layering = opts?.layering ?? FRAME_LAYERING
  const stage = new Konva.Stage({ container, width: STAGE_WIDTH, height: STAGE_HEIGHT })
  const frameLayer = new Konva.Layer()
  const cutoutLayer = new Konva.Layer()

  const frameNode = await loadKImage(frameUrl)
  frameNode.setAttrs({ x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT })
  frameLayer.add(frameNode)

  // Layer order per Task 1 decision:
  //   background → frame behind, cutout on top; overlay → cutout behind, frame in front.
  if (layering === 'background') { stage.add(frameLayer); stage.add(cutoutLayer) }
  else { stage.add(cutoutLayer); stage.add(frameLayer) }

  const transformer = new Konva.Transformer()
  cutoutLayer.add(transformer)

  return {
    addCutout(img: HTMLImageElement) {
      const node = new Konva.Image({ image: img, draggable: true, x: STAGE_WIDTH / 4, y: STAGE_HEIGHT / 4 })
      cutoutLayer.add(node)
      transformer.nodes([node])
      cutoutLayer.batchDraw()
    },
    exportPng() {
      return new Promise<Blob>((resolve, reject) => {
        stage.toBlob({ mimeType: 'image/png', callback: (b: Blob | null) => (b ? resolve(b) : reject(new Error('export failed'))) })
      })
    },
    destroy() { stage.destroy() },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- compose.test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/compose.ts hugo-apps/src/selfie/__tests__/compose.test.ts
git commit -m "feat(selfie): Konva compositing stage with drag/scale/rotate + PNG export (#1515)"
```

---

## Task 7: `share.ts` — Web Share + download fallback

**Files:**
- Create: `hugo-apps/src/selfie/share.ts`
- Test: `hugo-apps/src/selfie/__tests__/share.test.ts`

**Interfaces:**
- Produces:
  - `function canShareImage(): boolean` — feature-detects `navigator.canShare?.({ files: [pngFile] })`.
  - `async function shareOrDownload(blob: Blob, filename?: string): Promise<'shared' | 'downloaded'>` — uses `navigator.share` when supported, else triggers a download; returns which path ran.
  - `function downloadBlob(blob: Blob, filename?: string): void` — anchor-click download (extracted from the old `Editor.vue`).

- [ ] **Step 1: Write the failing test** `__tests__/share.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shareOrDownload } from '../share'

describe('share.shareOrDownload', () => {
  beforeEach(() => {
    ;(globalThis.URL as any).createObjectURL = vi.fn(() => 'blob:x')
    ;(globalThis.URL as any).revokeObjectURL = vi.fn()
  })

  it('shares via navigator.share when files are shareable', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    ;(navigator as any).canShare = vi.fn(() => true)
    ;(navigator as any).share = share
    const out = await shareOrDownload(new Blob(['x'], { type: 'image/png' }))
    expect(out).toBe('shared')
    expect(share).toHaveBeenCalled()
  })

  it('falls back to download when share is unsupported', async () => {
    ;(navigator as any).canShare = undefined
    ;(navigator as any).share = undefined
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const out = await shareOrDownload(new Blob(['x'], { type: 'image/png' }))
    expect(out).toBe('downloaded')
    expect(clickSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- share.test`
Expected: FAIL — cannot resolve `../share`.

- [ ] **Step 3: Implement `share.ts`:**

```ts
export function downloadBlob(blob: Blob, filename = 'selfie.png'): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function canShareImage(): boolean {
  try {
    const f = new File([new Blob()], 'selfie.png', { type: 'image/png' })
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [f] })
  } catch { return false }
}

export async function shareOrDownload(blob: Blob, filename = 'selfie.png'): Promise<'shared' | 'downloaded'> {
  if (canShareImage() && typeof navigator.share === 'function') {
    try {
      const file = new File([blob], filename, { type: 'image/png' })
      await navigator.share({ files: [file], title: 'Selfie with an Advocate', text: 'I met an SAP Developer Advocate! #Devtoberfest' })
      return 'shared'
    } catch {
      // User cancelled or share failed → guaranteed download path.
    }
  }
  downloadBlob(blob, filename)
  return 'downloaded'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- share.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/share.ts hugo-apps/src/selfie/__tests__/share.test.ts
git commit -m "feat(selfie): Web Share with guaranteed download fallback (#1519)"
```

---

## Task 8: `Capture.vue` — camera-first + upload fallback

**Files:**
- Create: `hugo-apps/src/selfie/Capture.vue`
- Delete: `hugo-apps/src/selfie/Uploader.vue`
- Test: `hugo-apps/src/selfie/__tests__/Capture.test.ts`

**Interfaces:**
- Consumes: `startCamera`, `stopCamera`, `captureFrame`, `CameraUnavailableError` from `camera.ts`.
- Produces: emits `photo` with a `Blob` payload. Props: none required. Renders a `<video>` preview + "Take photo" button when the camera is available; falls back to `<input type="file" accept="image/*">` on `CameraUnavailableError`. File-input path validates `image/*` and a 20 MB cap (ported from the old `upload.ts`), emitting `error` with a friendly message otherwise.

- [ ] **Step 1: Write the failing test** `__tests__/Capture.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../camera', () => ({
  startCamera: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'CameraUnavailableError' })),
  stopCamera: vi.fn(),
  captureFrame: vi.fn(),
  CameraUnavailableError: class extends Error {},
}))

import Capture from '../Capture.vue'

describe('Capture.vue', () => {
  it('falls back to a file input when the camera is unavailable', async () => {
    const w = mount(Capture)
    await flushPromises()
    expect(w.find('input[type="file"]').exists()).toBe(true)
  })

  it('emits error for a non-image file', async () => {
    const w = mount(Capture)
    await flushPromises()
    const input = w.find('input[type="file"]')
    const file = new File(['x'], 'x.txt', { type: 'text/plain' })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    expect(w.emitted('error')?.[0]?.[0]).toMatch(/image/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- Capture.test`
Expected: FAIL — cannot resolve `../Capture.vue`.

- [ ] **Step 3: Implement `Capture.vue`:**

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { startCamera, stopCamera, captureFrame } from './camera'

const emit = defineEmits<{ photo: [blob: Blob]; error: [message: string] }>()
const MAX = 20 * 1024 * 1024

const videoEl = ref<HTMLVideoElement | null>(null)
const cameraReady = ref(false)
let stream: MediaStream | null = null

onMounted(async () => {
  try {
    stream = await startCamera()
    if (videoEl.value) { videoEl.value.srcObject = stream; await videoEl.value.play() }
    cameraReady.value = true
  } catch {
    // Fail-soft: no camera / denied → file upload fallback renders.
    cameraReady.value = false
  }
})
onBeforeUnmount(() => { if (stream) stopCamera(stream) })

async function snap() {
  if (!videoEl.value) return
  try { emit('photo', await captureFrame(videoEl.value)) }
  catch { emit('error', 'Could not capture the photo — please try again.') }
}

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  if (!f) return
  if (!/^image\//.test(f.type)) return emit('error', 'Please choose an image file.')
  if (f.size > MAX) return emit('error', 'Image is too large (max 20 MB).')
  emit('photo', f)
}
</script>
<template>
  <div class="selfie-capture">
    <template v-if="cameraReady">
      <video ref="videoEl" class="selfie-video" playsinline muted aria-label="Camera preview"></video>
      <button type="button" class="selfie-btn" data-testid="snap" @click="snap">Take photo</button>
      <p class="selfie-busy">Or <label class="selfie-link">upload a photo<input type="file" accept="image/*" hidden @change="onPick" /></label> instead.</p>
    </template>
    <template v-else>
      <p class="selfie-busy">Camera unavailable — choose a photo to upload.</p>
      <input type="file" accept="image/*" aria-label="Choose a photo" @change="onPick" />
    </template>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- Capture.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Delete `Uploader.vue`** (its role is fully replaced).

```bash
git rm hugo-apps/src/selfie/Uploader.vue
```

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/selfie/Capture.vue hugo-apps/src/selfie/__tests__/Capture.test.ts
git commit -m "feat(selfie): Capture.vue camera-first with upload fallback (#1513)"
```

---

## Task 9: `Composer.vue` — Konva editor component

**Files:**
- Create: `hugo-apps/src/selfie/Composer.vue`
- Delete: `hugo-apps/src/selfie/Editor.vue`, `hugo-apps/src/selfie/upload.ts`, `hugo-apps/src/selfie/__tests__/upload.test.ts`
- Test: `hugo-apps/src/selfie/__tests__/Composer.test.ts`

**Interfaces:**
- Consumes: `buildStage` + `SelfieStage` from `compose.ts`; `blobToImage` (helper defined here) to turn the cutout blob into an `HTMLImageElement`.
- Produces: Props `{ cutout: Blob; frameName: string; imgBase: string }`. On mount, builds the Konva stage over `${imgBase}/frames/${frameName}.png`, adds the cutout. Emits `export` with the composited PNG `Blob` when the user clicks Export. Fail-soft: if `buildStage` throws, emits `fallback` with the raw cutout so the parent can offer a plain download.

- [ ] **Step 1: Write the failing test** `__tests__/Composer.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const exportPng = vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
vi.mock('../compose', () => ({
  buildStage: vi.fn().mockResolvedValue({ addCutout: vi.fn(), exportPng, destroy: vi.fn() }),
}))

import Composer from '../Composer.vue'

describe('Composer.vue', () => {
  it('emits export with a PNG blob when Export is clicked', async () => {
    const w = mount(Composer, { props: { cutout: new Blob(['c'], { type: 'image/png' }), frameName: 'Thomas', imgBase: '/images/devtoberfest/selfie' } })
    await flushPromises()
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    const payload = w.emitted('export')?.[0]?.[0] as Blob
    expect(payload).toBeInstanceOf(Blob)
    expect(payload.type).toBe('image/png')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- Composer.test`
Expected: FAIL — cannot resolve `../Composer.vue`.

- [ ] **Step 3: Implement `Composer.vue`:**

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { buildStage, type SelfieStage } from './compose'

const props = defineProps<{ cutout: Blob; frameName: string; imgBase: string }>()
const emit = defineEmits<{ export: [blob: Blob]; fallback: [blob: Blob] }>()

const stageEl = ref<HTMLDivElement | null>(null)
let stage: SelfieStage | null = null

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = URL.createObjectURL(blob)
  })
}

onMounted(async () => {
  if (!stageEl.value) return
  try {
    stage = await buildStage(stageEl.value, `${props.imgBase}/frames/${props.frameName}.png`)
    stage.addCutout(await blobToImage(props.cutout))
  } catch (e) {
    // Fail-soft: stage init failed → let the parent offer a plain download.
    console.warn('[selfie] stage init failed', e)
    emit('fallback', props.cutout)
  }
})
onBeforeUnmount(() => { try { stage?.destroy() } catch { /* noop */ } })

async function doExport() {
  if (!stage) return emit('fallback', props.cutout)
  try { emit('export', await stage.exportPng()) }
  catch { emit('fallback', props.cutout) }
}
</script>
<template>
  <div class="selfie-composer">
    <div ref="stageEl" class="selfie-stage"></div>
    <div class="selfie-editor-toolbar">
      <button type="button" class="selfie-btn" data-testid="export" @click="doExport">Export</button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- Composer.test`
Expected: PASS (1 test).

- [ ] **Step 5: Delete the superseded upload/editor files.**

```bash
git rm hugo-apps/src/selfie/Editor.vue hugo-apps/src/selfie/upload.ts hugo-apps/src/selfie/__tests__/upload.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/selfie/Composer.vue hugo-apps/src/selfie/__tests__/Composer.test.ts
git commit -m "feat(selfie): Composer.vue Konva editor; remove server upload path (#1515)"
```

---

## Task 10: `ExportBar.vue` — download + share UI

**Files:**
- Create: `hugo-apps/src/selfie/ExportBar.vue`
- Test: `hugo-apps/src/selfie/__tests__/ExportBar.test.ts`

**Interfaces:**
- Consumes: `shareOrDownload`, `downloadBlob` from `share.ts`.
- Produces: Props `{ image: Blob }`. Renders a Download button (always) and a Share button (rendered only when `canShareImage()` is true). Emits `restart`. On Download → `downloadBlob`; on Share → `shareOrDownload`.

- [ ] **Step 1: Write the failing test** `__tests__/ExportBar.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const downloadBlob = vi.fn()
vi.mock('../share', () => ({ downloadBlob, shareOrDownload: vi.fn(), canShareImage: () => false }))

import ExportBar from '../ExportBar.vue'

describe('ExportBar.vue', () => {
  it('downloads on click and hides Share when unsupported', async () => {
    const w = mount(ExportBar, { props: { image: new Blob(['x'], { type: 'image/png' }) } })
    expect(w.find('[data-testid="share"]').exists()).toBe(false)
    await w.find('[data-testid="download"]').trigger('click')
    expect(downloadBlob).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ExportBar.test`
Expected: FAIL — cannot resolve `../ExportBar.vue`.

- [ ] **Step 3: Implement `ExportBar.vue`:**

```vue
<script setup lang="ts">
import { shareOrDownload, downloadBlob, canShareImage } from './share'

const props = defineProps<{ image: Blob }>()
const emit = defineEmits<{ restart: [] }>()
const showShare = canShareImage()
</script>
<template>
  <div class="selfie-editor-toolbar">
    <button type="button" class="selfie-btn" data-testid="download" @click="downloadBlob(props.image)">Download</button>
    <button v-if="showShare" type="button" class="selfie-btn" data-testid="share" @click="shareOrDownload(props.image)">Share</button>
    <button type="button" class="selfie-btn" data-testid="restart" @click="emit('restart')">Start over</button>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ExportBar.test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/ExportBar.vue hugo-apps/src/selfie/__tests__/ExportBar.test.ts
git commit -m "feat(selfie): ExportBar.vue download + conditional share (#1519)"
```

---

## Task 11: `Selfie.vue` orchestrator + `main.ts` + styles

**Files:**
- Modify: `hugo-apps/src/selfie/Selfie.vue` (rewrite as state machine)
- Modify: `hugo-apps/src/selfie/main.ts` (drop `apiUpload`)
- Modify: `hugo-apps/src/selfie/styles.css` (video/stage styles)
- Test: `hugo-apps/src/selfie/__tests__/Selfie.test.ts`

**Interfaces:**
- Consumes: `FramePicker.vue`, `Capture.vue`, `Composer.vue`, `ExportBar.vue`; `removeBackground` from `segment.ts`; `SelfieStep` from `types.ts`.
- Produces: the full flow. Step order: pick frame → capture photo → segment (with progress) → compose → export. Single error banner (`role="alert"`). Privacy note updated to "never leaves your browser".

- [ ] **Step 1: Write the failing test** `__tests__/Selfie.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../segment', () => ({ removeBackground: vi.fn().mockResolvedValue({ blob: new Blob(['c'], { type: 'image/png' }), removed: true }) }))
vi.mock('../Capture.vue', () => ({ default: { name: 'Capture', emits: ['photo', 'error'], template: '<button data-testid="fake-snap" @click="$emit(\'photo\', new Blob([\'x\'], { type: \'image/png\' }))">snap</button>' } }))
vi.mock('../Composer.vue', () => ({ default: { name: 'Composer', props: ['cutout', 'frameName', 'imgBase'], emits: ['export', 'fallback'], template: '<div data-testid="composer"></div>' } }))

import Selfie from '../Selfie.vue'

const config = { imgBase: '/images/devtoberfest/selfie', frames: ['Thomas', 'DJ2'] }

describe('Selfie.vue', () => {
  it('shows the privacy note that the photo never leaves the browser', () => {
    const w = mount(Selfie, { props: { config } })
    expect(w.text()).toMatch(/never leaves your browser/i)
  })

  it('advances to the composer after a frame is picked and a photo is captured', async () => {
    const w = mount(Selfie, { props: { config } })
    await w.findAll('.frame-thumb')[0].trigger('click')
    await w.find('[data-testid="fake-snap"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="composer"]').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- Selfie.test`
Expected: FAIL — old `Selfie.vue` renders `Uploader`, has no composer step / privacy copy.

- [ ] **Step 3: Rewrite `Selfie.vue`:**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { MountConfig, SelfieStep } from './types'
import FramePicker from './FramePicker.vue'
import Capture from './Capture.vue'
import Composer from './Composer.vue'
import ExportBar from './ExportBar.vue'
import { removeBackground } from './segment'

defineProps<{ config: MountConfig }>()

const step = ref<SelfieStep>('capture')
const selectedFrame = ref<string | null>(null)
const cutout = ref<Blob | null>(null)
const finalImage = ref<Blob | null>(null)
const errorMsg = ref<string | null>(null)
const segmentProgress = ref(0)
const segmenting = ref(false)

async function onPhoto(blob: Blob) {
  errorMsg.value = null
  segmenting.value = true
  step.value = 'segment'
  try {
    const { blob: cut, removed } = await removeBackground(blob, (p) => { segmentProgress.value = p })
    if (!removed) errorMsg.value = 'Couldn’t remove the background — using your full photo.'
    cutout.value = cut
    step.value = 'compose'
  } finally {
    segmenting.value = false
  }
}
function onExport(blob: Blob) { finalImage.value = blob; step.value = 'export' }
function onFallback(blob: Blob) { finalImage.value = blob; step.value = 'export' }
function onError(msg: string) { errorMsg.value = msg }
function restart() {
  step.value = 'capture'; cutout.value = null; finalImage.value = null; errorMsg.value = null; segmentProgress.value = 0
}
</script>
<template>
  <div class="selfie-root">
    <p class="selfie-note">Your photo is processed entirely on your device — it <strong>never leaves your browser</strong>.</p>

    <p v-if="errorMsg" class="selfie-error" role="alert">{{ errorMsg }}</p>

    <template v-if="step === 'capture'">
      <FramePicker :frames="config.frames" :img-base="config.imgBase" @select="selectedFrame = $event" />
      <Capture v-if="selectedFrame" @photo="onPhoto" @error="onError" />
      <p v-else class="selfie-busy">Pick an advocate frame above to start.</p>
    </template>

    <p v-else-if="step === 'segment'" class="selfie-busy" role="status">
      Removing the background… {{ Math.round(segmentProgress * 100) }}%
    </p>

    <Composer
      v-else-if="step === 'compose' && cutout && selectedFrame"
      :cutout="cutout" :frame-name="selectedFrame" :img-base="config.imgBase"
      @export="onExport" @fallback="onFallback"
    />

    <template v-else-if="step === 'export' && finalImage">
      <img class="selfie-final" :src="''" :alt="'Your finished selfie'" ref="finalPreview" />
      <ExportBar :image="finalImage" @restart="restart" />
    </template>
  </div>
</template>
```

- [ ] **Step 4: Update `main.ts`** to drop `apiUpload`:

```ts
import { createApp } from 'vue'
import Selfie from './Selfie.vue'
import type { MountConfig } from './types'
import './styles.css'
const el = document.getElementById('selfie-mount')
if (el) {
  const d = el.dataset
  const config: MountConfig = {
    imgBase: d.imgBase || '/images/devtoberfest/selfie',
    frames: (d.frames || '').split(',').map(s => s.trim()).filter(Boolean),
  }
  createApp(Selfie, { config }).mount(el)
}
```

- [ ] **Step 5: Add styles** to `styles.css` (append):

```css
/* ---- Capture (camera) ---- */
.selfie-video { display: block; width: 100%; max-width: 640px; border-radius: 8px; background: #000; margin: 0 0 .75rem; transform: scaleX(-1); }
.selfie-link { color: var(--sapLinkColor, #0070f2); cursor: pointer; text-decoration: underline; }
/* ---- Composer (Konva stage) ---- */
.selfie-composer { margin: 1rem 0; }
.selfie-stage { max-width: 100%; margin: 0 auto; touch-action: none; }
.selfie-final { display: block; max-width: 100%; margin: 1rem auto; border-radius: 8px; }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- Selfie.test`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full selfie unit suite.**

Run: `npm test -- selfie`
Expected: PASS across camera/segment/compose/share/Capture/Composer/ExportBar/Selfie/FramePicker.

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/selfie/Selfie.vue hugo-apps/src/selfie/main.ts hugo-apps/src/selfie/styles.css hugo-apps/src/selfie/__tests__/Selfie.test.ts
git commit -m "feat(selfie): orchestrate capture→segment→compose→export state machine (#1512)"
```

---

## Task 12: Layout wiring + build verification

**Files:**
- Modify: `hugo/layouts/devtoberfest/selfie.html`

**Interfaces:**
- Consumes: the built `/js/selfie.js` island.
- Produces: layout no longer passes `data-api-upload`; the island builds entirely client-side.

- [ ] **Step 1: Edit `selfie.html`** — remove the `data-api-upload` attribute (keep `data-img-base` and `data-frames`):

```html
{{ define "main" }}
<main id="selfie-mount"
      data-img-base="/images/devtoberfest/selfie"
      data-frames="Antonio,Antonio2,Background,Background2,Daniel,DJ,DJ2,Group1,Group2,Group3,Group4,Josh,Josh2,Josh3,Kasmire,Kevin,Kevin2,Mamikee,Michelle,Nico,Nora,Rich,Rich2,Thomas,Witalij"></main>
<noscript>
  <div class="ds-noscript-fallback">
    <h1>Selfie with an Advocate</h1>
    <p>This tool needs JavaScript. Enable it and refresh.</p>
  </div>
</noscript>
<script type="module" src="{{ "/js/selfie.js" | relURL }}"></script>
{{ end }}
```

- [ ] **Step 2: Grep for any remaining `upload_selfie` / `apiUpload` references in this repo.**

Run: `grep -rn "upload_selfie\|apiUpload" hugo-apps/src hugo/layouts` — expected: no matches (the approuter `/community/*` route + gameboard-api endpoint stay; this repo just stops calling it).

- [ ] **Step 3: Build the apps** (runs both vendor steps + vite).

Run: `npm run build:apps`
Expected: build succeeds; `/js/selfie.js` emitted; no unresolved `@imgly`/`konva` imports.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/devtoberfest/selfie.html
git commit -m "feat(selfie): drop server upload wiring from layout; fully client-side (#1512)"
```

---

## Task 13: Extend the e2e spec

**Files:**
- Modify: `test/e2e/selfie.test.js`

**Interfaces:**
- Consumes: the deployed island at `/devtoberfest/selfie/`.
- Produces: an e2e assertion that the frame picker renders and (with a fake camera) the capture control appears. No real model run in CI.

- [ ] **Step 1: Update the spec** to reflect the new UI. Replace the uploader/`not stored` assertions with the new flow. Keep the self-skip + `<main>` conventions:

```js
// e2e: public "Selfie with an Advocate" Vue island. Anonymous, fully client-side.
// Path: browser → approuter /devtoberfest/selfie/ (static) → /js/selfie.js
//       → island renders the advocate frame picker; picking one reveals capture.
//       (No real background-removal model here — that's manual post-deploy QA;
//        this spec asserts the island hydrates the picker + capture affordance.)
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: devtoberfest selfie (anonymous)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('renders the frame picker and reveals capture after a frame is picked', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/selfie/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Island hydrates the advocate frame picker.
      await page.locator('.frame-thumb').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('.frame-thumb').count()).toBeGreaterThan(0);

      // Privacy messaging: photo never leaves the browser.
      expect(await page.getByText(/never leaves your browser/i).count()).toBeGreaterThan(0);

      // Picking a frame reveals a capture affordance (camera button or upload fallback).
      await page.locator('.frame-thumb').first().click();
      const hasCapture = await page.locator('[data-testid="snap"], input[type="file"]').first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
      expect(hasCapture, 'capture control should appear after picking a frame').toBe(true);
    } finally {
      await context.close();
    }
  });
});
```

- [ ] **Step 2: Syntax-check the spec locally** (it self-skips without a base URL, so this just confirms it parses/collects).

Run: `npm run test:e2e`
Expected: the suite is collected and **skipped** (no `SMOKE_BASE_URL`), no parse errors.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/selfie.test.js
git commit -m "test(selfie): e2e picker + capture affordance for client-side flow (#1512)"
```

---

## Task 14: Full-suite gate + manual QA checklist

**Files:** none (verification task)

- [ ] **Step 1: Run the full unit suite.**

Run: `npm test`
Expected: PASS (no regressions; selfie suite green).

- [ ] **Step 2: Production build.**

Run: `npm run build:apps`
Expected: succeeds; `/js/selfie.js` present; vendored `@imgly` assets under `hugo/static/vendor/imgly/`.

- [ ] **Step 3: Confirm no CDN leakage.** Grep the built island for external `@imgly` hosts.

Run: `grep -rn "cdn\|unpkg\|jsdelivr\|staticimgly" hugo/static/js/selfie.js` — expected: no external model/WASM host; assets resolve to `/vendor/imgly/`.

- [ ] **Step 4: Manual QA checklist** (post-DEV-deploy, real browser — Tom's #1 rule; CI cannot run the real model). Record results in the PR:
  - [ ] Camera permission prompt appears; live preview shows (mirrored).
  - [ ] "Take photo" captures; background removal runs with a visible progress %.
  - [ ] Cutout is draggable / scalable / rotatable over the advocate frame; layering looks correct for a single-advocate frame AND a `Group*` frame.
  - [ ] Deny camera → file-upload fallback works end-to-end.
  - [ ] Force a segmentation failure (offline after page load) → falls back to full photo with the friendly note; flow still completes.
  - [ ] Download produces a correct PNG; on mobile, Share opens the native sheet with the image.
  - [ ] Privacy note reads "never leaves your browser".

- [ ] **Step 5: Open a PR** (never direct-merge; PR over direct merge per repo rules).

```bash
git push -u origin worktree-selfie-tier1-spec
gh pr create --repo sap-tutorials/tutorials-ims --title "Selfie Tier 1: client-side camera + bg-removal + compositing + share (#1512)" --body "Implements the Tier 1 slice of #1512 — #1513, #1514, #1515, #1519. Fully client-side; removes the /community/upload_selfie round-trip. Manual QA checklist in the plan (Task 14) to be completed against DEV before merge."
```

---

## Self-Review

**Spec coverage:**
- §4 fully client-side pipeline → Tasks 3–12. ✓
- §4 vendor full-res frames + layering open-item → Task 1. ✓
- §5 component boundaries (Selfie/Capture/FramePicker/Composer/ExportBar + camera/segment/compose/share) → Tasks 3, 5–11. ✓
- §5 delete `upload.ts`/`Uploader.vue`/`Editor.vue` → Tasks 8, 9. ✓
- §6 fail-soft (camera denial, segmentation, Konva init, share) → Tasks 3, 5, 9, 7 tests. ✓
- §6 lazy-load + self-host → Tasks 2, 5; verified Task 14 Step 3. ✓
- §6 privacy copy → Task 11; asserted Task 11/13. ✓
- §7 unit + component + e2e + manual QA → Tasks 3–13 tests, Task 14. ✓
- Web Share (#1519) → Task 7, 10; folded in per decision. ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete content. ✓

**Type consistency:** `removeBackground` returns `{ blob, removed }` (Task 5) — consumed as such in Task 11. `buildStage`/`SelfieStage` (Task 6) consumed in Task 9. `shareOrDownload`/`downloadBlob`/`canShareImage` (Task 7) consumed in Task 10. `MountConfig` loses `apiUpload` (Task 4) — reflected in Tasks 11 (`main.ts`) and 12 (layout). `SelfieStep` (Task 4) used in Task 11. ✓

**Note on Task 11 export preview:** the final `<img>` src is bound to `''` as a placeholder; the implementer wires an object URL from `finalImage` via a small `watch`/computed. Flagged here so it isn't missed — the export/share path (ExportBar) does not depend on the preview.

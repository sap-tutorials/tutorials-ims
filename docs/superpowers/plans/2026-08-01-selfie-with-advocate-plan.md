# Selfie with an Advocate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild "Selfie with an Advocate" as a Vue island at `/devtoberfest/selfie/` — pick an advocate frame, upload a photo to the deployed `POST /community/upload_selfie`, crop/rotate the composite, download it.

**Architecture:** Hugo page + Vue 3 island (same pattern as `hugo-apps/src/gameboard/`), built into `hugo/static/js/selfie.js`, served through the approuter. Uploads multipart to the already-deployed `/community/upload_selfie`; crop/rotate via cropperjs. No backend/MTA/route changes.

**Tech Stack:** Vue 3 (`<script setup>` + TS), Vite, Hugo, cropperjs, vitest, Playwright. Independent of the arcade island (no shared files) — build in parallel.

## Global Constraints

- **Backend is deployed + unchanged** — `POST /community/upload_selfie`, multipart fields: `<image file>` (jpeg/png/gif, ≤20 MB) + `selectedPic=<frameName>`; returns a **base64 PNG string** (render as `data:image/png;base64,` + body).
- **No UI5 / FLP** — pure Vue island.
- **Send a clean `selectedPic`** (bare frame name) — no UI5 id prefix.
- **Client-side guardrails** mirror the backend: image mime only, ≤20 MB; friendly error on reject/failure (fail-soft, never a crashed UI).
- **"Photo is NOT stored"** messaging visible (as legacy).
- **Vite entry** (verbatim): `selfie: resolve(__dirname, 'src/selfie/main.ts'),` beside `arcade:`/`gameboard:` in `hugo-apps/vite.config.ts`.
- **Frame list** (bare names, matching the backend's `images/devtoberfest/selfie/*.png`):
  `Antonio, Antonio2, Background, Background2, Daniel, DJ, DJ2, Group1, Group2, Group3, Group4, Josh, Josh2, Josh3, Kasmire, Kevin, Kevin2, Mamikee, Michelle, Nico, Nora, Rich, Rich2, Thomas, Witalij`.
- **Island test style** — match `hugo-apps/src/gameboard/__tests__` (assertion lib + fetch mocking).

## Data contract (consumed, frozen)

```
POST /community/upload_selfie  (multipart/form-data)
  file field: the user's image ; field selectedPic=<frameName>
  → 200 text body = base64 PNG (composite)  ; non-200 → show friendly error
```

---

### Task 1: Hugo page + layout

**Files:** Create `hugo/content/devtoberfest/selfie/_index.md`, `hugo/layouts/devtoberfest/selfie.html`.

- [ ] **Step 1: Content file**

```markdown
---
title: "Selfie with an Advocate"
description: "Take a selfie with your favorite SAP Developer Advocate."
layout: selfie
type: devtoberfest
---
```

- [ ] **Step 2: Layout with mount node**

`hugo/layouts/devtoberfest/selfie.html`:

```html
{{ define "main" }}
<main id="selfie-mount"
      data-api-upload="/community/upload_selfie"
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

- [ ] **Step 3: Verify Hugo builds** — `npm run build:hugo`; confirm `hugo/public/devtoberfest/selfie/index.html` has `id="selfie-mount"`.

- [ ] **Step 4: Commit** — `feat(selfie): Hugo page + layout with island mount at /devtoberfest/selfie/`

---

### Task 2: Vite entry + island bootstrap + types + frame picker

**Files:** Modify `hugo-apps/vite.config.ts`; create `hugo-apps/src/selfie/{main.ts,types.ts,Selfie.vue,FramePicker.vue}`; test `__tests__/FramePicker.test.ts`.

**Interfaces:** Produces `MountConfig` (apiUpload, imgBase, frames[]); `FramePicker.vue` emits the selected bare frame name.

- [ ] **Step 1: Failing test** `__tests__/FramePicker.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FramePicker from '../FramePicker.vue'
describe('FramePicker', () => {
  it('renders a thumbnail per frame and emits the bare name on select', async () => {
    const frames = ['Thomas', 'DJ2', 'Kasmire']
    const w = mount(FramePicker, { props: { frames, imgBase: '/images/devtoberfest/selfie' } })
    expect(w.findAll('.frame-thumb')).toHaveLength(3)
    await w.findAll('.frame-thumb')[1].trigger('click')
    expect(w.emitted('select')![0]).toEqual(['DJ2'])
    // thumbnail src points at the thumbnails dir
    expect(w.findAll('img')[0].attributes('src')).toBe('/images/devtoberfest/selfie/thumbnails/Thomas.png')
  })
})
```

- [ ] **Step 2: Run — fails.** `npm --prefix hugo-apps run test -- src/selfie`

- [ ] **Step 3: Vite entry** — add `selfie: resolve(__dirname, 'src/selfie/main.ts'),`.

- [ ] **Step 4: `types.ts`**

```ts
export interface MountConfig { apiUpload: string; imgBase: string; frames: string[] }
```

- [ ] **Step 5: `FramePicker.vue`**

```vue
<script setup lang="ts">
defineProps<{ frames: string[]; imgBase: string }>()
const emit = defineEmits<{ select: [name: string] }>()
</script>
<template>
  <ul class="frame-picker" role="listbox" aria-label="Choose an advocate frame">
    <li v-for="f in frames" :key="f" class="frame-thumb" role="option" @click="emit('select', f)">
      <img :src="`${imgBase}/thumbnails/${f}.png`" :alt="f" loading="lazy" />
    </li>
  </ul>
</template>
```

- [ ] **Step 6: `main.ts`** (reads mount, parses `data-frames` CSV, mounts `Selfie`)

```ts
import { createApp } from 'vue'
import Selfie from './Selfie.vue'
import type { MountConfig } from './types'
import './styles.css'
const el = document.getElementById('selfie-mount')
if (el) {
  const d = el.dataset
  const config: MountConfig = {
    apiUpload: d.apiUpload || '/community/upload_selfie',
    imgBase: d.imgBase || '/images/devtoberfest/selfie',
    frames: (d.frames || '').split(',').map(s => s.trim()).filter(Boolean)
  }
  createApp(Selfie, { config }).mount(el)
}
```

- [ ] **Step 7: `Selfie.vue`** (skeleton wiring FramePicker; upload/editor added in Tasks 3–4)

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { MountConfig } from './types'
import FramePicker from './FramePicker.vue'
defineProps<{ config: MountConfig }>()
const selectedFrame = ref<string | null>(null)
defineExpose({ selectedFrame })
</script>
<template>
  <div class="selfie-root">
    <p class="selfie-note">Your photo is uploaded to build the image and is <strong>not stored</strong>.</p>
    <FramePicker :frames="config.frames" :img-base="config.imgBase" @select="selectedFrame = $event" />
  </div>
</template>
```

- [ ] **Step 8: Run — passes.** Commit: `feat(selfie): island bootstrap + advocate frame picker`

---

### Task 3: Upload → composite

**Files:** Create `hugo-apps/src/selfie/Uploader.vue`, `hugo-apps/src/selfie/upload.ts` (pure-ish helper); modify `Selfie.vue`; test `__tests__/upload.test.ts`.

**Interfaces:** `uploadSelfie(apiUrl, file, frameName)` → returns `data:image/png;base64,...` string; throws a friendly Error on non-200.

- [ ] **Step 1: Failing test** `__tests__/upload.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { uploadSelfie } from '../upload'
describe('uploadSelfie', () => {
  it('POSTs multipart with the file + selectedPic and returns a data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'QUJD' })
    globalThis.fetch = fetchMock as any
    const file = new File([new Uint8Array([1,2,3])], 'me.png', { type: 'image/png' })
    const out = await uploadSelfie('/community/upload_selfie', file, 'Thomas')
    expect(out).toBe('data:image/png;base64,QUJD')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/community/upload_selfie')
    expect(opts.method).toBe('POST')
    const fd = opts.body as FormData
    expect(fd.get('selectedPic')).toBe('Thomas')
    expect(fd.get('file')).toBeInstanceOf(File)
  })
  it('rejects a non-image / oversize file before uploading', async () => {
    const big = new File([new Uint8Array(1)], 'x.txt', { type: 'text/plain' })
    await expect(uploadSelfie('/x', big, 'Thomas')).rejects.toThrow(/image/i)
  })
  it('throws a friendly error on non-200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' }) as any
    const file = new File([new Uint8Array([1])], 'me.png', { type: 'image/png' })
    await expect(uploadSelfie('/x', file, 'Thomas')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: `upload.ts`**

```ts
const MAX = 20 * 1024 * 1024
export async function uploadSelfie(apiUrl: string, file: File, frameName: string): Promise<string> {
  if (!file || !/^image\//.test(file.type)) throw new Error('Please choose an image file.')
  if (file.size > MAX) throw new Error('Image is too large (max 20 MB).')
  const fd = new FormData()
  fd.append('file', file)
  fd.append('selectedPic', frameName)
  const res = await fetch(apiUrl, { method: 'POST', body: fd })
  if (!res.ok) throw new Error('Could not build your selfie — please try again.')
  const b64 = await res.text()
  return `data:image/png;base64,${b64}`
}
```

- [ ] **Step 4: `Uploader.vue`** — file input (accept="image/*") + upload button; disabled until a frame is selected; busy state; emits `result` (data URL) or shows the error message.

- [ ] **Step 5: Wire into `Selfie.vue`** — pass `selectedFrame`; on `result`, hand to the editor (Task 4). Show a friendly error banner on failure.

- [ ] **Step 6: Run — passes.** Commit: `feat(selfie): multipart upload to /community/upload_selfie → composite (fail-soft)`

---

### Task 4: Crop/rotate editor + download

**Files:** Add `cropperjs` to `hugo-apps/package.json`; create `hugo-apps/src/selfie/Editor.vue`; modify `Selfie.vue`; test `__tests__/Editor.test.ts`.

**Interfaces:** `Editor.vue` takes a data-URL image, offers crop + rotate, and a Download that saves the edited canvas as PNG.

- [ ] **Step 1: Add the dep** — `npm --prefix hugo-apps install cropperjs`. Verify bundle-size check still passes (Task 5); if cropperjs is too heavy for the island budget, substitute a lighter crop lib and note it.

- [ ] **Step 2: Failing test** `__tests__/Editor.test.ts` — mount with a data-URL prop; assert Rotate calls the cropper's rotate, and Download triggers a canvas→blob save (mock the cropper + `URL.createObjectURL`). Assert no crash when the image is empty.

- [ ] **Step 3: `Editor.vue`** — wrap cropperjs over an `<img :src="dataUrl">`; buttons: Rotate Left/Right, reset crop, Download (`cropper.getCroppedCanvas().toBlob(...)` → anchor download `selfie.png`).

- [ ] **Step 4: Wire into `Selfie.vue`** — show `Editor` once a composite result exists; collapse the picker/uploader (as legacy did on image load).

- [ ] **Step 5: Run — passes.** Commit: `feat(selfie): crop/rotate editor + download (cropperjs)`

---

### Task 5: Assets, build, e2e, deploy verification

**Files:** Create `hugo/static/images/devtoberfest/selfie/thumbnails/*.png`; create `test/e2e/selfie.test.js`.

- [ ] **Step 1: Carry + optimize thumbnails** — copy the frame thumbnails from `D:/projects/sap-community-activity-badges/srv/images/devtoberfest/selfie/thumbnails/` for the frame-name list (Global Constraints) into `hugo/static/images/devtoberfest/selfie/thumbnails/`. Optimize (the picker needs small images; `Background2` was huge). Skip `Originals/`, `Silhouette*`, unused names.

- [ ] **Step 2: Verify referenced paths exist** — each `frames` name has a `thumbnails/<name>.png`.

- [ ] **Step 3: Build the island** — `npm --prefix hugo-apps run build`; confirm `hugo/static/js/selfie.js` emitted, no budget errors (this is where a too-heavy cropperjs would fail — address per Task 4 Step 1).

- [ ] **Step 4: Full selfie unit suite** — `npm --prefix hugo-apps run test -- src/selfie`; all pass.

- [ ] **Step 5: Committed e2e** `test/e2e/selfie.test.js` (self-skips without base URL): loads `/devtoberfest/selfie/`, asserts the frame picker (`.frame-thumb`) and uploader render. (No real photo upload in e2e.)

- [ ] **Step 6: Commit** — `feat(selfie): thumbnails + e2e; build verified`

- [ ] **Step 7: Deploy + verify (post-merge)** — deploy tutorials-ims to DEV; **verification-before-done**: open `/devtoberfest/selfie/`, pick a frame, upload a test image through the browser, confirm a composite returns and downloads. **This also verifies the multipart POST works through the approuter** (only tested at srv level before — Design §10 risk).

---

## Self-Review

**Spec coverage:** frame picker → Task 2; upload→composite → Task 3; crop/rotate+download → Task 4; assets/build/e2e/verify → Task 5; "not stored" note → Task 2; Vue island / no UI5 → all. ✅

**Placeholder scan:** No TBDs. The cropperjs-vs-lighter-lib and frame-list-source are flagged as explicit conditionals with a default, not gaps.

**Type consistency:** `MountConfig` (apiUpload, imgBase, frames) consistent across `types.ts`/`main.ts`/`Selfie.vue`; `uploadSelfie` signature matches test + `Uploader` usage; frame-name list in the layout `data-frames` matches the backend frame PNGs and Task 5's thumbnail carry.

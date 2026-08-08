# Selfie One-Click Share (#1519) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a desktop social-share fallback (Download / Copy image / X / LinkedIn) to the finished-selfie screen, alongside the existing mobile native share sheet.

**Architecture:** All share logic lives as pure, unit-testable functions in `hugo-apps/src/selfie/share.ts`; `ExportBar.vue` stays a thin presentation layer that picks one of two mutually exclusive branches based on `canShareImage()` — mobile native sheet (unchanged) vs. an explicit desktop button row. X/LinkedIn buttons auto-download the PNG then open a prefilled share-intent popup (intents cannot attach files). Every new helper is fail-soft so a blocked API never crashes the island.

**Tech Stack:** Vue 3 `<script setup>` SFC, TypeScript, Vitest + happy-dom + `@vue/test-utils`, Web Share API, Clipboard API (`ClipboardItem`), X/LinkedIn share-intent URLs.

## Global Constraints

- **No semicolons** in selfie `.ts`/`.vue` files (match existing style).
- **LF line endings** (Windows CRLF regressions are a known hazard).
- **Fail-soft always** — the selfie island must never throw into the page; wrap every new browser-API call in try/catch that degrades to a no-op or the guaranteed download.
- **Feature detection only** — `canShareImage()` is the sole mobile/desktop discriminator; NO user-agent sniffing.
- **Share text (verbatim):** `I met an SAP Developer Advocate! #Devtoberfest` — generic, no advocate name/handle plumbing.
- **Share link URL (verbatim):** `https://developers.sap.com/devtoberfest/`
- **X intent host (verbatim):** `https://twitter.com/intent/tweet`
- **LinkedIn intent host (verbatim):** `https://www.linkedin.com/sharing/share-offsite/` — accepts only `url`; it ignores any prefilled text (intentional, accepted).
- **No new files, no new props.** Do NOT touch `Selfie.vue`, `MountConfig`, or `types.ts`.
- **Konva stays `^9.3.0`** (hugo-apps only) — not touched here.
- **Run tests from repo root:** `npm test -- --project unit <file>`.
- **Pre-existing failure to ignore:** `segment.test.ts` fails to resolve `@imgly/background-removal` — out of scope, do NOT "fix" it.

---

### Task 1: `share.ts` — text/URL constants + intent-URL builders

Add the single source of truth for share copy and the two pure intent-URL builders. Refactor `shareOrDownload` to reference `SHARE_TEXT` (no behavior change) so the literal exists in exactly one place.

**Files:**
- Modify: `hugo-apps/src/selfie/share.ts` (append helpers; edit line 23 to use `SHARE_TEXT`)
- Test: `hugo-apps/src/selfie/__tests__/share.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `downloadBlob(blob, filename='selfie.png')`, `canShareImage()`, `shareOrDownload(blob, filename)` from this file.
- Produces:
  - `SHARE_TEXT: string` = `'I met an SAP Developer Advocate! #Devtoberfest'`
  - `SHARE_URL: string` = `'https://developers.sap.com/devtoberfest/'`
  - `xIntentUrl(): string`
  - `linkedInIntentUrl(): string`

- [ ] **Step 1: Write the failing tests**

Append to `hugo-apps/src/selfie/__tests__/share.test.ts`:

```ts
import { xIntentUrl, linkedInIntentUrl, SHARE_TEXT, SHARE_URL } from '../share'

describe('share intent URLs', () => {
  it('xIntentUrl targets the X/Twitter intent host with encoded text and url', () => {
    const u = xIntentUrl()
    expect(u).toContain('https://twitter.com/intent/tweet?')
    const q = new URLSearchParams(u.split('?')[1])
    expect(q.get('text')).toBe(SHARE_TEXT)
    expect(q.get('url')).toBe(SHARE_URL)
  })

  it('linkedInIntentUrl targets share-offsite with only the url param', () => {
    const u = linkedInIntentUrl()
    expect(u).toContain('https://www.linkedin.com/sharing/share-offsite/?')
    const q = new URLSearchParams(u.split('?')[1])
    expect(q.get('url')).toBe(SHARE_URL)
    expect(q.get('text')).toBeNull()
    expect(q.get('summary')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/share.test.ts`
Expected: FAIL — `xIntentUrl`/`linkedInIntentUrl`/`SHARE_TEXT`/`SHARE_URL` are not exported.

- [ ] **Step 3: Add constants + builders and refactor `shareOrDownload`**

At the TOP of `hugo-apps/src/selfie/share.ts` (before `downloadBlob`), add:

```ts
// Single source of truth for share copy + link.
export const SHARE_TEXT = 'I met an SAP Developer Advocate! #Devtoberfest'
export const SHARE_URL = 'https://developers.sap.com/devtoberfest/'

export function xIntentUrl(): string {
  const p = new URLSearchParams({ text: SHARE_TEXT, url: SHARE_URL })
  return `https://twitter.com/intent/tweet?${p}`
}

export function linkedInIntentUrl(): string {
  const p = new URLSearchParams({ url: SHARE_URL })
  return `https://www.linkedin.com/sharing/share-offsite/?${p}`
}
```

Then in the existing `shareOrDownload`, replace the inline literal on the `navigator.share` call so it reads:

```ts
      await navigator.share({ files: [file], title: 'Selfie with an Advocate', text: SHARE_TEXT })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/share.test.ts`
Expected: PASS — new intent-URL tests green AND the two pre-existing `shareOrDownload` tests still green (proves the `SHARE_TEXT` refactor didn't regress).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/share.ts hugo-apps/src/selfie/__tests__/share.test.ts
git commit -m "feat(#1519): share text/url constants + X/LinkedIn intent URL builders"
```

---

### Task 2: `share.ts` — `copyImage` (Clipboard API, fail-soft)

Add clipboard copy of the PNG, feature-detected and fail-soft.

**Files:**
- Modify: `hugo-apps/src/selfie/share.ts` (append `copyImage`)
- Test: `hugo-apps/src/selfie/__tests__/share.test.ts` (add cases)

**Interfaces:**
- Produces: `copyImage(blob: Blob): Promise<'copied' | 'unavailable'>`

- [ ] **Step 1: Write the failing tests**

Append to `hugo-apps/src/selfie/__tests__/share.test.ts`:

```ts
import { copyImage } from '../share'

describe('share.copyImage', () => {
  const png = new Blob(['x'], { type: 'image/png' })

  it('returns "copied" and calls clipboard.write when the API is present', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).ClipboardItem = class { constructor(_: any) {} }
    ;(navigator as any).clipboard = { write }
    expect(await copyImage(png)).toBe('copied')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('returns "unavailable" when ClipboardItem is missing (no throw)', async () => {
    ;(globalThis as any).ClipboardItem = undefined
    ;(navigator as any).clipboard = { write: vi.fn() }
    expect(await copyImage(png)).toBe('unavailable')
  })

  it('returns "unavailable" when clipboard.write rejects (fail-soft)', async () => {
    ;(globalThis as any).ClipboardItem = class { constructor(_: any) {} }
    ;(navigator as any).clipboard = { write: vi.fn().mockRejectedValue(new Error('denied')) }
    expect(await copyImage(png)).toBe('unavailable')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/share.test.ts`
Expected: FAIL — `copyImage` is not exported.

- [ ] **Step 3: Add `copyImage`**

Append to `hugo-apps/src/selfie/share.ts`:

```ts
// Copy the PNG to the clipboard. Feature-detected + fail-soft.
export async function copyImage(blob: Blob): Promise<'copied' | 'unavailable'> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return 'unavailable'
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
    return 'copied'
  } catch { return 'unavailable' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/share.test.ts`
Expected: PASS — all three `copyImage` cases green.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/share.ts hugo-apps/src/selfie/__tests__/share.test.ts
git commit -m "feat(#1519): copyImage clipboard helper (feature-detected, fail-soft)"
```

---

### Task 3: `share.ts` — `openSocialShare` (download-then-open-intent)

Add the desktop social action: guarantee the file via `downloadBlob`, then open the prefilled intent popup. Fail-soft on popup blockers.

**Files:**
- Modify: `hugo-apps/src/selfie/share.ts` (append `openSocialShare`)
- Test: `hugo-apps/src/selfie/__tests__/share.test.ts` (add cases)

**Interfaces:**
- Consumes: `downloadBlob`, `xIntentUrl`, `linkedInIntentUrl` (this file, Task 1).
- Produces: `openSocialShare(blob: Blob, network: 'x' | 'linkedin', filename?: string): void`

- [ ] **Step 1: Write the failing tests**

Append to `hugo-apps/src/selfie/__tests__/share.test.ts`:

```ts
import { openSocialShare } from '../share'

describe('share.openSocialShare', () => {
  const png = new Blob(['x'], { type: 'image/png' })

  beforeEach(() => {
    ;(globalThis.URL as any).createObjectURL = vi.fn(() => 'blob:x')
    ;(globalThis.URL as any).revokeObjectURL = vi.fn()
  })

  it('downloads the file then opens the X intent popup', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    openSocialShare(png, 'x')
    expect(clickSpy).toHaveBeenCalled() // download fired first
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy.mock.calls[0][0]).toContain('twitter.com/intent/tweet')
  })

  it('opens the LinkedIn intent popup', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    openSocialShare(png, 'linkedin')
    expect(openSpy.mock.calls[0][0]).toContain('linkedin.com/sharing/share-offsite')
  })

  it('does not throw when window.open is blocked (fail-soft)', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(window, 'open').mockImplementation(() => { throw new Error('popup blocked') })
    expect(() => openSocialShare(png, 'x')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/share.test.ts`
Expected: FAIL — `openSocialShare` is not exported.

- [ ] **Step 3: Add `openSocialShare`**

Append to `hugo-apps/src/selfie/share.ts`:

```ts
// Desktop social: guarantee the user has the file (auto-download), then open the
// prefilled intent popup so they can attach it. Fail-soft on popup blockers.
export function openSocialShare(blob: Blob, network: 'x' | 'linkedin', filename = 'selfie.png'): void {
  try { downloadBlob(blob, filename) } catch { /* download best-effort */ }
  const url = network === 'x' ? xIntentUrl() : linkedInIntentUrl()
  try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* popup blocked → no-op */ }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/share.test.ts`
Expected: PASS — all three `openSocialShare` cases green; full `share.test.ts` file green.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/selfie/share.ts hugo-apps/src/selfie/__tests__/share.test.ts
git commit -m "feat(#1519): openSocialShare downloads then opens prefilled intent popup"
```

---

### Task 4: `ExportBar.vue` — mobile/desktop branch split

Rework the component into two mutually exclusive branches: mobile native share (unchanged) vs. the desktop row (Download / Copy image / X / LinkedIn). Add a transient copy-state label.

**Files:**
- Modify: `hugo-apps/src/selfie/ExportBar.vue` (full rewrite of the 15-line file)
- Test: `hugo-apps/src/selfie/__tests__/ExportBar.test.ts` (expand)

**Interfaces:**
- Consumes: `shareOrDownload`, `downloadBlob`, `canShareImage`, `copyImage` (Task 2), `openSocialShare` (Task 3) from `./share`.
- Produces: no exported symbols; component contract unchanged (`props: { image: Blob }`, `emits: { restart }`). New `data-testid`s: `copy`, `share-x`, `share-linkedin`.

- [ ] **Step 1: Write the failing tests**

Replace the body of `hugo-apps/src/selfie/__tests__/ExportBar.test.ts` with:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const h = vi.hoisted(() => ({ canShare: false }))
vi.mock('../share', () => ({
  downloadBlob: vi.fn(),
  shareOrDownload: vi.fn(),
  copyImage: vi.fn().mockResolvedValue('copied'),
  openSocialShare: vi.fn(),
  canShareImage: () => h.canShare
}))

import ExportBar from '../ExportBar.vue'
import { downloadBlob, copyImage, openSocialShare } from '../share'

const img = () => new Blob(['x'], { type: 'image/png' })

describe('ExportBar.vue — desktop branch', () => {
  it('shows the desktop row (no native share) when canShareImage is false', () => {
    h.canShare = false
    const w = mount(ExportBar, { props: { image: img() } })
    expect(w.find('[data-testid="share"]').exists()).toBe(false)
    expect(w.find('[data-testid="download"]').exists()).toBe(true)
    expect(w.find('[data-testid="copy"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-x"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-linkedin"]').exists()).toBe(true)
  })

  it('downloads on click', async () => {
    h.canShare = false
    const w = mount(ExportBar, { props: { image: img() } })
    await w.find('[data-testid="download"]').trigger('click')
    expect(downloadBlob).toHaveBeenCalled()
  })

  it('Copy click flips the label to "Copied!"', async () => {
    h.canShare = false
    const w = mount(ExportBar, { props: { image: img() } })
    await w.find('[data-testid="copy"]').trigger('click')
    await flushPromises()
    expect(copyImage).toHaveBeenCalled()
    expect(w.find('[data-testid="copy"]').text()).toBe('Copied!')
  })

  it('X and LinkedIn buttons call openSocialShare with the right network', async () => {
    h.canShare = false
    const w = mount(ExportBar, { props: { image: img() } })
    await w.find('[data-testid="share-x"]').trigger('click')
    await w.find('[data-testid="share-linkedin"]').trigger('click')
    expect(openSocialShare).toHaveBeenCalledWith(expect.any(Blob), 'x')
    expect(openSocialShare).toHaveBeenCalledWith(expect.any(Blob), 'linkedin')
  })
})

describe('ExportBar.vue — mobile branch', () => {
  it('shows only the native Share button and hides the desktop row', () => {
    h.canShare = true
    const w = mount(ExportBar, { props: { image: img() } })
    expect(w.find('[data-testid="share"]').exists()).toBe(true)
    expect(w.find('[data-testid="download"]').exists()).toBe(false)
    expect(w.find('[data-testid="copy"]').exists()).toBe(false)
    expect(w.find('[data-testid="share-x"]').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/ExportBar.test.ts`
Expected: FAIL — `[data-testid="copy"]`/`share-x`/`share-linkedin` don't exist yet; the mobile branch still renders Download.

- [ ] **Step 3: Rewrite `ExportBar.vue`**

Replace the entire contents of `hugo-apps/src/selfie/ExportBar.vue` with:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { shareOrDownload, downloadBlob, canShareImage, copyImage, openSocialShare } from './share'

const props = defineProps<{ image: Blob }>()
const emit = defineEmits<{ restart: [] }>()
const nativeShare = canShareImage()
const copyState = ref<'idle' | 'copied' | 'unavailable'>('idle')

async function onCopy() {
  copyState.value = (await copyImage(props.image)) === 'copied' ? 'copied' : 'unavailable'
  setTimeout(() => { copyState.value = 'idle' }, 2000)
}
</script>
<template>
  <div class="selfie-editor-toolbar">
    <!-- Mobile: native share sheet (unchanged) -->
    <button
      v-if="nativeShare" type="button" class="selfie-btn" data-testid="share"
      @click="shareOrDownload(props.image)"
    >Share</button>

    <!-- Desktop: explicit row -->
    <template v-else>
      <button type="button" class="selfie-btn" data-testid="download" @click="downloadBlob(props.image)">Download</button>
      <button type="button" class="selfie-btn" data-testid="copy" @click="onCopy">
        {{ copyState === 'copied' ? 'Copied!' : copyState === 'unavailable' ? 'Copy failed' : 'Copy image' }}
      </button>
      <button type="button" class="selfie-btn" data-testid="share-x" @click="openSocialShare(props.image, 'x')">Share on X</button>
      <button type="button" class="selfie-btn" data-testid="share-linkedin" @click="openSocialShare(props.image, 'linkedin')">Share on LinkedIn</button>
    </template>

    <button type="button" class="selfie-btn" data-testid="restart" @click="emit('restart')">Start over</button>
  </div>
</template>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/ExportBar.test.ts`
Expected: PASS — both describe blocks green.

- [ ] **Step 5: Run the full selfie suite for regressions**

Run: `npm test -- --project unit hugo-apps/src/selfie/__tests__/`
Expected: PASS for every file EXCEPT the pre-existing `segment.test.ts` `@imgly/background-removal` resolution failure (out of scope — do NOT fix). All other selfie tests green.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/selfie/ExportBar.vue hugo-apps/src/selfie/__tests__/ExportBar.test.ts
git commit -m "feat(#1519): ExportBar desktop share row (download/copy/X/LinkedIn) + mobile branch"
```

---

## Self-Review

**1. Spec coverage:**
- AC #1 mobile native sheet — pre-existing, preserved by Task 4's mobile branch. ✓
- AC #2 desktop social links + copy/download — Tasks 1–4. ✓
- AC #3 share text hashtag + advocate reference — `SHARE_TEXT` (Task 1), generic per decision. ✓
- AC #4 feature-detect `canShare({files})`, degrade cleanly — existing `canShareImage()` as sole discriminator (Task 4), fail-soft helpers (Tasks 2–3). ✓
- AC #5 test coverage for share/fallback branch — Tasks 1–4 all TDD; both component branches covered. ✓
- Spec's "no new files/props, don't touch Selfie.vue/MountConfig/types.ts" — honored; only 2 source + 2 test files. ✓
- LinkedIn URL-only limitation — encoded in `linkedInIntentUrl` (no text param) + asserted in Task 1 test. ✓

**2. Placeholder scan:** No TBD/TODO/vague steps; every code step has complete code. ✓

**3. Type consistency:** `copyImage → Promise<'copied'|'unavailable'>` used identically in Task 2 and Task 4's `onCopy`. `openSocialShare(blob, 'x'|'linkedin', filename?)` signature matches Task 3 definition and Task 4 call sites. `SHARE_TEXT`/`SHARE_URL`/`xIntentUrl`/`linkedInIntentUrl` names consistent across Tasks 1, 3. ✓

No gaps found.

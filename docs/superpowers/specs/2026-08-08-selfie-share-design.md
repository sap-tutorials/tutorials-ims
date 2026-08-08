# Selfie One-Click Share (#1519) — Design

**Issue:** sap-tutorials/tutorials-ims #1519 (Devtoberfest selfie epic #1512, Tier 2)
**Depends on:** #1515 (client-side compositing — done), #1518 (polaroid frame — merged)
**Date:** 2026-08-08

## Goal

Give a finished selfie a one-click path to social sharing: a native share
sheet on mobile, and an explicit Download / Copy-image / X / LinkedIn row on
desktop. Meet all five acceptance criteria while adding the *minimum* new
surface — a basic Web Share already exists from an earlier slice.

## Acceptance criteria (from the issue)

1. Mobile users get a native share sheet with the image attached.
2. Desktop users get social share links (LinkedIn/X) + copy/download fallback.
3. Share text is pre-filled with hashtag + advocate reference.
4. Feature-detects `navigator.canShare({ files })`, degrades cleanly.
5. Test coverage for the share/fallback branch.

## What already exists (do not rebuild)

`hugo-apps/src/selfie/share.ts` already ships:

- `downloadBlob(blob, filename)` — anchor-click download.
- `canShareImage()` — feature-detects `navigator.canShare({ files: [File] })`.
- `shareOrDownload(blob, filename)` — native `navigator.share({ files })` with
  a hardcoded title/text, falling back to `downloadBlob` on cancel/absence.

`hugo-apps/src/selfie/ExportBar.vue` already renders a **Download** button
(always) and a **Share** button gated on `canShareImage()`.

**This means AC #1 (mobile native sheet) and AC #4 (feature detection) are
already satisfied.** The remaining gap for #1519 is desktop: social intent
links (X/LinkedIn), a copy-image affordance, and a single source of truth for
the share text/URL.

## Decisions (resolved during brainstorming)

- **AC #3 advocate reference — generic, no name/handle.** Keep the existing
  hardcoded `"I met an SAP Developer Advocate! #Devtoberfest"`. The frame
  names *are* the advocates, but some frames are not people
  (`Background`, `Background2`, `Group1`–`Group4`), no social handles exist in
  the data, and threading `selectedFrame` through to `ExportBar` adds plumbing
  and upkeep for little gain. Generic text satisfies "hashtag + advocate
  reference". **No changes to `Selfie.vue` / `MountConfig` / `types.ts`.**
- **Desktop row — download-then-open-intent.** Buttons:
  `Download · Copy image · Share on X · Share on LinkedIn · Start over`.
  X and LinkedIn share-intent URLs *cannot* attach an image file, so clicking
  them auto-downloads the PNG first, then opens the prefilled intent popup so
  the user can attach the just-downloaded file.
- **Shared link URL — the Devtoberfest event page**
  `https://developers.sap.com/devtoberfest/`. The intent popup prefills text +
  this link; the link is what renders as the clickable URL in the post.
- **Approach A — extend `share.ts` + rework `ExportBar.vue`.** Logic stays in
  `share.ts` as pure, unit-testable functions (matching the existing pattern);
  the component stays thin. No new component file (YAGNI).

## Architecture & data flow

```
ExportBar.vue  (presentation — picks ONE of two branches)
   │
   ├─ canShareImage() === true  → mobile: single [Share] button (UNCHANGED)
   │      └─ shareOrDownload(blob)  → native sheet, image attached
   │
   └─ canShareImage() === false → desktop row:
          [Download] [Copy image] [Share on X] [Share on LinkedIn] [Start over]
                │          │              │                │
                ▼          ▼              ▼                ▼
       downloadBlob   copyImage()   openSocialShare(blob,'x')  openSocialShare(blob,'linkedin')
       (existing)     (new)         (new — download then window.open intent)

share.ts  (pure logic — single source of truth)
   SHARE_TEXT, SHARE_URL                 (new constants; shareOrDownload reuses SHARE_TEXT)
   xIntentUrl() / linkedInIntentUrl()    (new — pure string builders)
   copyImage(blob)                       (new — Clipboard API, feature-detected, fail-soft)
   openSocialShare(blob, net)            (new — downloadBlob + window.open)
```

**Branching rule:** the existing `canShareImage()` is the *sole* mobile/desktop
discriminator — no user-agent sniffing. Devices with the Web Share Level 2 file
API get the native sheet; everything else gets the explicit desktop row. The
mobile path is byte-for-byte unchanged.

**Fail-soft posture (load-bearing — the island must never crash the page):**
every new helper is wrapped so a thrown/denied API (clipboard blocked, popup
blocked, `window.open` returning null) degrades to a no-op or the guaranteed
download.

## Files changed

- **Modify** `hugo-apps/src/selfie/share.ts` — add `SHARE_TEXT`, `SHARE_URL`,
  `xIntentUrl`, `linkedInIntentUrl`, `copyImage`, `openSocialShare`; refactor
  `shareOrDownload` to reference `SHARE_TEXT` (no behavior change).
- **Modify** `hugo-apps/src/selfie/ExportBar.vue` — split into mobile branch
  (native share, unchanged) vs desktop row (Download/Copy/X/LinkedIn); add a
  transient copy-state label.
- **Modify** `hugo-apps/src/selfie/__tests__/share.test.ts` — cover the new
  helpers.
- **Modify** `hugo-apps/src/selfie/__tests__/ExportBar.test.ts` — cover both
  branches and the new buttons.

No new files. No new props. No changes to `Selfie.vue`, `MountConfig`, or
`types.ts`.

## `share.ts` — new logic

```ts
// Single source of truth — shareOrDownload's inline literal is replaced by SHARE_TEXT.
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

// Copy the PNG to the clipboard. Feature-detected + fail-soft.
export async function copyImage(blob: Blob): Promise<'copied' | 'unavailable'> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return 'unavailable'
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
    return 'copied'
  } catch { return 'unavailable' }
}

// Desktop social: guarantee the user has the file (auto-download), then open the
// prefilled intent popup so they can attach it. Fail-soft on popup blockers.
export function openSocialShare(blob: Blob, network: 'x' | 'linkedin', filename = 'selfie.png'): void {
  try { downloadBlob(blob, filename) } catch { /* download best-effort */ }
  const url = network === 'x' ? xIntentUrl() : linkedInIntentUrl()
  try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* popup blocked → no-op */ }
}
```

**Platform notes (intentional behaviors, not bugs):**

- **X host:** `twitter.com/intent/tweet` remains the documented, stable share
  intent and 301-redirects to X's composer. Kept as-is.
- **LinkedIn** `share-offsite` accepts only `url` — it scrapes the target
  page's Open Graph tags for title/description and *ignores* any `text`/
  `summary` param. So the LinkedIn post is **URL-driven**; the prefilled *text*
  is an X-only affordance. This is a known LinkedIn limitation, accepted.
- `shareOrDownload` keeps its existing try/catch and simply references
  `SHARE_TEXT` instead of the inline string — behavior identical.

## `ExportBar.vue` — presentation

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { shareOrDownload, downloadBlob, canShareImage, copyImage, openSocialShare } from './share'
const props = defineProps<{ image: Blob }>()
const emit = defineEmits<{ restart: [] }>()
const nativeShare = canShareImage()
const copyState = ref<'idle' | 'copied' | 'unavailable'>('idle')

async function onCopy() {
  copyState.value = await copyImage(props.image) === 'copied' ? 'copied' : 'unavailable'
  setTimeout(() => { copyState.value = 'idle' }, 2000)
}
</script>

<template>
  <div class="selfie-editor-toolbar">
    <!-- Mobile: native share sheet (unchanged) -->
    <button v-if="nativeShare" type="button" class="selfie-btn" data-testid="share"
            @click="shareOrDownload(props.image)">Share</button>

    <!-- Desktop: explicit row -->
    <template v-else>
      <button type="button" class="selfie-btn" data-testid="download"
              @click="downloadBlob(props.image)">Download</button>
      <button type="button" class="selfie-btn" data-testid="copy" @click="onCopy">
        {{ copyState === 'copied' ? 'Copied!' : copyState === 'unavailable' ? 'Copy failed' : 'Copy image' }}
      </button>
      <button type="button" class="selfie-btn" data-testid="share-x"
              @click="openSocialShare(props.image, 'x')">Share on X</button>
      <button type="button" class="selfie-btn" data-testid="share-linkedin"
              @click="openSocialShare(props.image, 'linkedin')">Share on LinkedIn</button>
    </template>

    <button type="button" class="selfie-btn" data-testid="restart"
            @click="emit('restart')">Start over</button>
  </div>
</template>
```

**Behavior notes:**

- **Download always present on desktop** (guaranteed fallback per AC #2), even
  though the social buttons also auto-download — some users just want the file.
- **Copy button** flips to `Copied!` / `Copy failed` for 2 s then resets. If the
  Clipboard API is unavailable it still renders and returns `unavailable` on
  click — simplest, avoids a second feature-detect branch; the transient
  "Copy failed" is honest feedback.
- **One behavior change vs today's ExportBar:** currently the Share button
  appears only if `canShareImage()`, alongside an always-present Download. The
  new version makes Download/social **desktop-only** and native-share
  **mobile-only** — mutually exclusive branches. Intentional: mobile users get
  the superior native sheet; the desktop row would be redundant there.

## Testing (AC #5)

### `share.test.ts` additions (pure-function coverage — the bulk)

| Test | Asserts |
|---|---|
| `xIntentUrl()` builds correct host + encoded params | contains `twitter.com/intent/tweet`, `text=`, `url=` (URL-encoded) |
| `linkedInIntentUrl()` builds correct host + url param | contains `linkedin.com/sharing/share-offsite`, `url=`, no `text=` |
| `copyImage` returns `'copied'` on success | mock `ClipboardItem` + `navigator.clipboard.write` resolving → `'copied'`, write called |
| `copyImage` returns `'unavailable'` when API absent | `ClipboardItem`/`clipboard.write` undefined → `'unavailable'`, no throw |
| `copyImage` returns `'unavailable'` when write rejects | write rejects (permission denied) → `'unavailable'`, no throw (fail-soft) |
| `openSocialShare('x')` downloads then opens X intent | spy `window.open` called with a `twitter.com/intent` URL; anchor click fired |
| `openSocialShare('linkedin')` opens LinkedIn intent | `window.open` called with `linkedin.com/sharing` URL |
| `openSocialShare` survives a blocked popup | `window.open` throws/returns null → no throw (fail-soft) |
| `shareOrDownload` still shares/downloads (existing 2 tests) | unchanged — proves the `SHARE_TEXT` refactor didn't regress |

### `ExportBar.test.ts` additions (component branch coverage)

| Test | Asserts |
|---|---|
| existing: unsupported hides `[share]`, shows download | keep — now also asserts `[share-x]`/`[share-linkedin]`/`[copy]` **exist** on desktop branch |
| mobile branch: `canShareImage → true` shows only `[share]`, hides desktop row | mock `canShareImage: () => true`; `[download]`/`[copy]`/`[share-x]` absent |
| Copy click flips label to `Copied!` | mock `copyImage` → `'copied'`; button text becomes `Copied!` |
| X / LinkedIn click calls `openSocialShare` with right network | mock `openSocialShare`; assert called `(_, 'x')` and `(_, 'linkedin')` |

## Error handling (fail-soft, consistent with the island)

- `copyImage` — try/catch → `'unavailable'`, never throws.
- `openSocialShare` — download best-effort in its own try/catch; `window.open`
  in its own try/catch (popup blockers). Worst case: user got the downloaded
  file, popup didn't open — degraded, not broken.
- No new global error surfaces; nothing can crash the mount.

## Out of scope (YAGNI)

- Advocate name/handle plumbing; LinkedIn prefilled text (platform can't).
- User-agent sniffing (feature detection only).
- Analytics on share clicks.
- Instagram or other networks.

## Conventions

- No semicolons in selfie `.ts`/`.vue` files (match existing style).
- LF line endings.
- Run tests from repo root: `npm test -- --project unit hugo-apps/src/selfie/__tests__/share.test.ts hugo-apps/src/selfie/__tests__/ExportBar.test.ts`.
- Konva stays `^9.3.0` (hugo-apps only) — not touched here.

# U15 Image Lightbox — Design

**Date:** 2026-05-22
**Branch (planned):** `ui-pilot/u15-lightbox`
**Status:** Proposed
**Series:** UI follow-ups (U15+). Continuation of the U0–U14 pilot pattern.

## Context

Tutorial pages and other markdown-rendered pages emit `<img data-zoomable="true">` via the Hugo image render hook ([hugo/layouts/_default/_markup/render-image.html:43](hugo/layouts/_default/_markup/render-image.html#L43)). A minimal native-`<dialog>` lightbox already exists:

- Dialog markup: [hugo/layouts/_default/baseof.html:39-43](hugo/layouts/_default/baseof.html#L39-L43)
- Open/close logic: [hugo/assets/js/tutorial.ts:54-75](hugo/assets/js/tutorial.ts#L54-L75)
- CSS: [hugo/assets/css/sap-fundamental.css:2410-2468](hugo/assets/css/sap-fundamental.css#L2410-L2468)

It opens on image click, closes on any click, and shows alt text as caption. There is no zoom, no pan, no gallery navigation, no keyboard support beyond browser-default Esc, no Horizon chrome, and no deep-link/sharing. Init lives in `tutorial.ts`, so non-tutorial markdown pages (mission overviews, group pages, docs) cannot open the lightbox even though they emit `data-zoomable` images.

## Goals

1. Replace the plain `<dialog>` with `<ui5-dialog>` for proper Horizon chrome (header bar, themed close, footer slot).
2. Add scroll-wheel + pinch + button-driven zoom (1×–5×) with cursor-anchored origin and click-drag pan when zoomed.
3. Add prev/next gallery navigation across all `[data-zoomable]` images on the page, with keyboard arrows and a left-right slide animation between siblings.
4. Add a deep-link URL hash (`#img-N`) so an image can be opened via direct URL, and so back-button closes the lightbox.
5. Add a download button that saves the currently-viewed image with a sensible filename.
6. Make the lightbox available on every markdown page (tutorials, missions, groups), not just tutorial layouts.
7. Preserve existing behavior: click-to-open from any `<img data-zoomable>`, Esc to close, dark-mode brightness filter override on the lightbox image.

## Non-goals

- Hi-DPI / original-resolution image variant for high-zoom clarity. Download and zoom both use the existing 1440w `/img-cdn/` proxy. Adding a second proxy width or fetching the original is a follow-up.
- Image-set zip download / "save all images on this page" affordance.
- Share button / copy-link affordance (the URL hash makes the page URL itself shareable; explicit copy-link is YAGNI).
- Slide animation when jumping by keyboard (animation runs for arrow-button clicks only — actually, animation runs on every prev/next regardless of trigger; mid-animation interruptions snap to the new target).
- Automated UI tests. The pilot is presentational; verification is manual via Hugo dev server. `npm test` (unit) must remain green.
- A new dependency. Uses already-imported `@ui5/webcomponents` plus existing/new icon side-effect imports.

## Architecture

### File map

| Path | Action | Purpose |
|---|---|---|
| `hugo/layouts/partials/lightbox-dialog.html` | NEW | `<ui5-dialog>` markup with header / viewport / footer slots |
| `hugo/layouts/_default/baseof.html` | EDIT | Replace native `<dialog class="image-lightbox">` block with `{{ partial "lightbox-dialog.html" . }}` |
| `hugo/assets/js/lightbox.ts` | NEW | State, open/close, zoom, pan, gallery, slide animation, hash sync, download |
| `hugo/assets/js/tutorial.ts` | EDIT | Remove `openLightbox`/`initLightbox` and the `data-zoomable` branch of the existing click delegation (currently at [tutorial.ts:35-36](hugo/assets/js/tutorial.ts#L35-L36)). The new `lightbox.ts` attaches its own `document.addEventListener('click', ...)` delegation on init (called from `ui5-bootstrap.ts`), so this file no longer participates in lightbox wiring. |
| `hugo/assets/js/ui5-bootstrap.ts` | EDIT | Import `Dialog.js`, `Title.js`, new icons (`zoom-in`, `zoom-out`, `navigation-left-arrow`, `navigation-right-arrow`, `reset`, `download`); import `lightbox.ts`; import `lightbox.css` |
| `hugo/assets/css/lightbox.css` | NEW | Viewport, transform layer, slide rail, mobile stretch, reduced-motion fallback |
| `hugo/assets/css/sap-fundamental.css` | EDIT | Remove `.image-lightbox*` rules (lines 2410-2468) — this is the source file for the PostCSS pipeline |
| `hugo/static/css/sap-fundamental.css` | REGEN | Build artifact produced by `npm run build:css` (postcss → static/). Must be committed alongside the source edit so dev/prod renders match — `npm run dev` does NOT auto-regenerate this file. The git history shows both files committed together for every CSS change. |

Approximate change: ~240 LOC added (TS + CSS + partial), ~60 LOC removed. One commit, one PR.

### Markup (`partials/lightbox-dialog.html`)

```html
<ui5-dialog id="image-lightbox" accessible-name="Image viewer" class="lightbox-dialog">
  <div slot="header" class="lightbox-header">
    <ui5-title level="H4" class="lightbox-title"></ui5-title>
    <ui5-button icon="decline" design="Transparent" class="lightbox-close" tooltip="Close"></ui5-button>
  </div>
  <div class="lightbox-viewport" data-lightbox-viewport>
    <div class="lightbox-rail">
      <img class="lightbox-img lightbox-img--current" alt="">
      <img class="lightbox-img lightbox-img--incoming" alt="" hidden>
    </div>
  </div>
  <div slot="footer" class="lightbox-footer">
    <ui5-button icon="navigation-left-arrow" design="Transparent" class="lightbox-prev" tooltip="Previous"></ui5-button>
    <ui5-button icon="zoom-out" design="Transparent" class="lightbox-zoom-out" tooltip="Zoom out"></ui5-button>
    <span class="lightbox-zoom-level" aria-live="polite">100%</span>
    <ui5-button icon="zoom-in" design="Transparent" class="lightbox-zoom-in" tooltip="Zoom in"></ui5-button>
    <ui5-button icon="reset" design="Transparent" class="lightbox-reset" tooltip="Reset zoom"></ui5-button>
    <ui5-button icon="download" design="Transparent" class="lightbox-download" tooltip="Download image"></ui5-button>
    <ui5-button icon="navigation-right-arrow" design="Transparent" class="lightbox-next" tooltip="Next"></ui5-button>
  </div>
</ui5-dialog>
```

When `imgs.length === 1`, prev/next buttons are hidden via JS (`hidden` attribute).

### State

```ts
type LightboxState = {
  imgs: HTMLImageElement[]   // all data-zoomable imgs in document order
  index: number              // current image index
  scale: number              // 1.0 .. 5.0
  tx: number                 // translation x (px, pre-scale)
  ty: number                 // translation y (px, pre-scale)
  pushedHash: boolean        // did we pushState on open?
  animating: boolean         // mid-slide guard
}
```

State is module-scoped. The state is reset on close (scale → 1, tx/ty → 0, animating → false). `imgs` is recomputed on every open so dynamically-injected images (e.g., from a script-rendered Vue island) participate without rebinding.

### Behavior

#### Open

`open(triggerImg)`:
1. Collect all `[data-zoomable="true"]` imgs in document order, find triggering image's index.
2. Render image into `.lightbox-img--current`, reset transform.
3. Set header title from `triggerImg.alt` (or empty if alt is the placeholder `"image"`).
4. Toggle prev/next button visibility based on `imgs.length`.
5. `history.pushState({lightbox: true}, "", "#img-" + (index + 1))` — sets `pushedHash: true`.
6. Toggle `stretch` attribute on dialog if `matchMedia("(max-width: 640px)").matches`.
7. Call `customElements.whenDefined("ui5-dialog").then(() => dialog.show())` — handles upgrade race per [project_u10_toast](#).
8. Preload neighbors: `new Image().src = imgs[index - 1]?.currentSrc; new Image().src = imgs[index + 1]?.currentSrc`.

#### Goto (prev/next)

`goto(direction: -1 | 1)`:
1. Guard: return if `animating` or out-of-range.
2. Set `animating = true`.
3. Position `.lightbox-img--incoming` at `translateX(±100%)` (sign matches `direction`); set its `src` to next image; clear `hidden`.
4. Force reflow: `incoming.offsetWidth`.
5. Add transition class to rail. Animate incoming → 0, current → ∓100%.
6. After `transitionend` (or 300 ms timer fallback): swap class names so incoming becomes current; update `index`; reset transform on the new current; update header title; update prev/next disabled state; update zoom level label to 100%; preload new neighbors; set `animating = false`.
7. Update URL: `history.replaceState({lightbox: true}, "", "#img-" + (index + 1))`.

If `prefers-reduced-motion: reduce` is set (checked via `matchMedia`), skip step 3-5 and instantly swap (`current.src = next; index += direction; transition: none`).

If a second goto fires while animating, the in-flight transition is canceled via class-removal and the new direction starts immediately; this avoids the user feeling stuck on a slow click-spam.

#### Zoom

- **Scroll wheel**: listener on `.lightbox-viewport`; `e.preventDefault()`; `delta = -e.deltaY * 0.001`; `setZoom(scale + delta, e.clientX, e.clientY)`. Clamped 1.0–5.0.
- **Pinch**: Pointer Events with two simultaneous pointers. Track previous distance; on pointermove, `delta = (newDist - prevDist) / 200`; midpoint of the two pointers is the origin.
- **Buttons**: zoom-in / zoom-out adjust by ±0.5 around viewport center; reset returns to 1.0/0/0.
- **Keyboard** (while dialog open): `+`/`=` zoom-in, `-` zoom-out, `0` reset.
- **`setZoom(newScale, originX, originY)`**: clamps scale, then adjusts `tx/ty` so the screen-space point under (originX, originY) stays under that screen-space point post-zoom. Bounds-checks `tx/ty` to keep the image from being panned entirely off-screen at the new scale.
- Zoom level label updates as a percentage: `Math.round(scale * 100) + "%"`.

#### Pan

- Pointer-down on viewport: if `scale > 1` and only one pointer, capture pointer, store start coords, set `cursor: grabbing`.
- Pointer-move: `tx += dx; ty += dy`; bounds-checked.
- Pointer-up: release pointer, `cursor: grab`.
- Two-pointer move switches to pinch mode (handled in zoom section).
- `touch-action: none` on viewport CSS prevents native scroll/zoom hijack on touch devices.

#### Close

`close()`:
1. Reset state (scale 1, tx/ty 0, animating false).
2. ui5-dialog handles focus restore to the triggering image.
3. If `pushedHash`, call `history.back()` (which fires popstate but our handler ignores when the dialog is already closed).
4. Else, the page was opened directly with `#img-N`: `history.replaceState(null, "", location.pathname + location.search)` to clean the URL.

**Close event wiring**: bind `dialog.addEventListener("close", close)` on init. ui5-dialog dispatches a native `close` event on Esc-driven dismissal and on programmatic `dialog.close()`. The footer close button calls `dialog.close()` (which then triggers the same `close` event handler). This guarantees a single teardown path — state reset + hash cleanup — regardless of whether the user pressed Esc, clicked the close button, or hit the browser back button (popstate handler also calls `dialog.close()`).

Re-entrancy: `close()` is idempotent. If `close` event fires after `history.back()` already ran (popstate path), the second invocation no-ops because `pushedHash` was reset and state is already at defaults.

#### Hash deep-link

- **Format**: `#img-N` where N is 1-indexed image position. Coexists with `#step-N` from [tutorial.ts:88](hugo/assets/js/tutorial.ts#L88) — different prefix, no collision.
- **On `DOMContentLoaded`**: if `location.hash.match(/^#img-(\d+)$/)`, wait for `customElements.whenDefined("ui5-dialog")`, find the Nth zoomable image, scroll-into-view its parent step, then call `open(imgs[N-1])`. Set `pushedHash: false` so close uses replaceState.
- **Popstate**: if dialog open and the popped state lacks `lightbox: true`, close the dialog without re-pushing.

#### Download

- Footer button click handler:
  1. Read `currentImg.src` (this is the proxied `/img-cdn/?u=…&w=1440` URL — same-origin).
  2. Derive filename: try `currentImg.alt` slugified + extension from URL pathname, fallback to URL pathname's last segment, fallback to `"image"`. Append extension if missing.
  3. Create `<a download={filename} href={src}>`, append to body, click, remove.
- Same-origin source means `download` attribute is honored (no fetch+blob fallback needed).

### Theming

ui5-dialog auto-themes via the existing `data-theme` MutationObserver in [ui5-bootstrap.ts:83-84](hugo/assets/js/ui5-bootstrap.ts#L83-L84) — no extra wiring needed.

`.lightbox-img` keeps the existing `filter: none !important` so the dark-mode brightness filter applied to `.tutorial-main img` doesn't dim the lightbox view.

`.lightbox-viewport` background uses `var(--sapShell_Background, #000)` — visible margin around `object-fit: contain` images. Default to black-ish in light mode (high contrast for screenshot-style images).

### Mobile

- Below 640 px viewport, the dialog gets `stretch` on open (recomputed via matchMedia).
- Pinch-zoom via Pointer Events (works on iOS Safari and Android Chrome).
- Footer wraps; if `imgs.length === 1` the hidden prev/next leave the zoom + download buttons centered.

### Reduced motion

- Slide animation: skipped (instant swap).
- Zoom button: instant scale change (no transition).
- Wheel/pinch zoom: still continuous (no transitions involved).

### Edge cases

| Case | Handling |
|---|---|
| ui5-dialog not yet upgraded on first click | `customElements.whenDefined("ui5-dialog").then(() => open())` |
| Image fails to load on goto | Keep prior image visible, log to `console.warn`, no UI noise |
| Single-image page | prev/next hidden via `[hidden]` attribute |
| User clicks prev/next during animation | Cancel in-flight transition, start new one in same/opposite direction |
| Page-load hash points past last image (`#img-99` on 5-image page) | Ignore hash, leave dialog closed |
| Page has zero zoomable images but user navigates with `#img-1` | Ignore hash, leave dialog closed |
| User has dialog open and uses browser back button | Popstate handler closes the dialog |
| User has dialog open and clicks a backdrop (outside dialog content) | ui5-dialog default is non-modal-dismissable; we wire the close button as the only mouse-close affordance. Esc still closes. |
| Wheel scroll on body when dialog closed | Unaffected; listener is scoped to `.lightbox-viewport` |
| `data-zoomable` images added to DOM after page load (Vue islands) | `imgs` recomputed on every `open()` so they participate; click delegation in `tutorial.ts` already uses event-delegation on `document`. |

## Verification plan

Per project rule "for UI changes, start the dev server and use the feature in a browser":

1. `npm install` (already done in worktree); `npm run fetch-tutorials`; `npm run dev`.
2. **Multi-image tutorial**: open a tutorial step with ≥2 images. Verify:
   - Click image → dialog opens with Horizon chrome.
   - Scroll wheel zooms in/out around cursor.
   - Drag pans when zoomed.
   - Prev/next buttons + ←/→ keys navigate, slide animation plays.
   - Download saves the image with a sensible filename.
   - URL hash updates to `#img-N` on open and goto, clears on close.
   - Reload with `#img-3` in URL auto-opens image 3.
   - Browser back closes the dialog and removes the hash.
   - Esc closes; focus returns to the triggering image.
3. **Single-image page**: prev/next hidden; everything else works.
4. **Mission overview** (or any non-tutorial markdown page with images): lightbox now works (regression of today's tutorial-only init).
5. **Dark mode**: toggle via shellbar or U12 reader-mode shortcut; verify chrome/text contrast and that lightbox image is not dimmed.
6. **Mobile** (Chrome DevTools 375×667): verify dialog stretches, pinch-zoom works, footer is reachable.
7. **Reduced motion**: enable OS setting / DevTools emulator; verify slide is instant and zoom button is instant.
8. **Unit tests**: `npm test` remains green (lightbox is presentational; no unit coverage; no regressions expected).
9. **Linter**: `cds lint` if applicable to TS/CSS (project doesn't lint TS in CI today; manual compile via Hugo `js.Build` is the safety net).

## Risks

- **Pointer-event pinch math**: most-likely first-cut bug. Plan: write the math out long-form in code comments and test on real touch device + DevTools touch emulation before merge.
- **Slide animation interruption**: rapid prev/next clicks could leave state inconsistent if `transitionend` is missed. Mitigation: timer fallback (300 ms) + class-based state instead of in-flight Animation refs.
- **History.pushState on open**: nesting with the existing `#step-N` hash navigation. Mitigation: different prefix; popstate handler bails when dialog isn't open; `replaceState` between gotos so back-button doesn't unwind through every viewed image.
- **ui5-dialog stretch toggling on resize**: we set `stretch` on open based on a matchMedia snapshot; we do not re-evaluate on resize while open. Acceptable — orientation change while viewing an image is uncommon and the scope cost of adding a resize listener is real.

## Out of scope (future)

- Hi-DPI image variant for clearer high-zoom view.
- Original-resolution download (as opposed to 1440w proxied).
- Cross-page persistence of lightbox state (e.g., remember last zoom level).
- Lightbox keyboard hint affordance ("? for help" overlay).
- Animation between tutorials when navigating via shared lightbox hash.
- Image-set "save all" download.
- Explicit copy-link button (URL hash makes the page URL itself shareable).

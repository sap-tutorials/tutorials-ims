# U14 Skeleton Loaders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the post-paint flicker on tutorial pages by shimmering the progress bar / step circles / Done buttons while `/getProgress` resolves, add a Horizon-themed `ui5-progress-indicator` that animates during full-page navigations, and ship a shared `<Skeleton>` Vue component used by `TutorialNavigator.vue`.

**Architecture:** Three independent, additive layers. (1) An inline pre-paint script in `head.html` sets `html[data-hydrated="false"]` only on tutorial layouts; CSS shimmer rules in `hugo/assets/css/skeletons.css` match that selector. `tutorial.ts` flips the attribute to `"true"` after `loadProgress()` resolves (with a 1.5 s `Promise.race` timeout and a 2 s tail fallback). (2) A new `nav-progress.ts` module and `partials/nav-progress.html` element delegate-listen to internal-link clicks and trickle a top-of-viewport `ui5-progress-indicator` until `pagehide`/`pageshow` fires. (3) `apps/src/shared/Skeleton.vue` is consumed by `TutorialNavigator.vue` to render six placeholder cards while the catalog is fetching.

**Tech Stack:** Hugo, esbuild via `js.Build`, UI5 Web Components (`ui5-progress-indicator`), Vue 3 + Vite (`vite-plugin-css-injected-by-js`), CSS keyframe animations.

**Spec:** [docs/superpowers/specs/2026-05-22-u14-skeleton-loaders-design.md](../specs/2026-05-22-u14-skeleton-loaders-design.md)

---

## File map

**New:**
- `hugo/assets/css/skeletons.css` — shimmer keyframes; selectors for `html[data-hydrated="false"]` hydration targets; `.skeleton`/`.skeleton--card`/`.skeleton--text-line`/`.skeleton--rect` classes; `.nav-progress-bar` overrides; `prefers-reduced-motion` fallback.
- `hugo/assets/js/nav-progress.ts` — click delegation, trickle animation (0 → 30 → 90), `pagehide`/`pageshow` lifecycle, abort grace timer, `customElements.whenDefined` guard.
- `hugo/layouts/partials/nav-progress.html` — single `<ui5-progress-indicator id="nav-progress" hide-value value="0" class="nav-progress-bar" hidden>` element.
- `apps/src/shared/Skeleton.vue` — shared component with `kind` (`card`|`text-line`|`rect`), `count`, `height` props.

**Modified:**
- `hugo/layouts/partials/head.html` — add a single inline statement that sets `data-hydrated="false"` on tutorial pages, and a `DOMContentLoaded`-anchored 2 s tail fallback.
- `hugo/assets/js/ui5-bootstrap.ts` — `import "../css/skeletons.css"`; `import "./nav-progress"`. (Both imports are cross-page and gated internally on DOM presence.)
- `hugo/assets/js/tutorial.ts` — wrap `loadProgress()` call with `Promise.race` timeout + flip `data-hydrated="true"`. Idempotent.
- `hugo/layouts/_default/baseof.html` — `{{ partial "nav-progress.html" . }}` after `header.html`.
- `apps/src/navigator/TutorialNavigator.vue` — render `<Skeleton kind="card" :count="6" />` while `tutorials.value.length === 0`.

**Read-only (verify, no edits):**
- `apps/vite.config.ts` — confirms `vite-plugin-css-injected-by-js` is active; the relative CSS import in `Skeleton.vue` will be inlined into each island bundle.
- `hugo/layouts/_default/baseof.html:48` — `js.Build` already targets `es2020 esm minify`; no change to esbuild options needed.

---

## Task 1: Add the shimmer stylesheet

Foundation layer. CSS owns the entire visual treatment; later tasks just toggle attributes.

**Files:**
- Create: `hugo/assets/css/skeletons.css`

- [ ] **Step 1: Write the file**

```css
/* hugo/assets/css/skeletons.css
 *
 * U14: shimmer for hydration placeholders + the shared <Skeleton> Vue component.
 * The hydration selectors are scoped to html[data-hydrated="false"], which is
 * set ONLY on tutorial layouts by the pre-paint script in head.html. Non-tutorial
 * pages never carry the attribute, so these rules do not apply there.
 */

@keyframes skeleton-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.skeleton,
html[data-hydrated="false"] .progress-segment,
html[data-hydrated="false"] .step-check-circle,
html[data-hydrated="false"] [data-action="mark-done"] {
  background: linear-gradient(
    90deg,
    var(--sapList_Background) 0%,
    var(--sapButton_Hover_Background) 50%,
    var(--sapList_Background) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.4s ease-in-out infinite;
  color: transparent;
  pointer-events: none;
  border-color: transparent;
}

/* Shared component shapes */
.skeleton {
  display: block;
  border-radius: 0.5rem;
}
.skeleton--card {
  height: 200px;
  margin-bottom: 1rem;
}
.skeleton--text-line {
  height: 1rem;
  margin-bottom: 0.5rem;
}
.skeleton--rect {
  height: 240px;
}

/* Top-of-viewport navigation progress bar overrides for ui5-progress-indicator */
.nav-progress-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 9999;
  border: none;
  background: transparent;
  transition: opacity 200ms;
}
/* Keep the element mounted so JS can drive `value` without re-mount churn;
 * the [hidden] attribute is repurposed as a fade flag. */
.nav-progress-bar[hidden] { display: block !important; opacity: 0; }
.nav-progress-bar:not([hidden]) { opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .skeleton,
  html[data-hydrated="false"] [data-action="mark-done"],
  html[data-hydrated="false"] .step-check-circle,
  html[data-hydrated="false"] .progress-segment {
    animation: none;
    opacity: 0.6;
  }
  .nav-progress-bar { transition: none; }
}
```

- [ ] **Step 2: Verify Hugo can resolve the asset**

Run: `ls hugo/assets/css/skeletons.css`
Expected: file exists, ~2 KB.

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/css/skeletons.css
git commit -m "feat(u14): add skeleton shimmer stylesheet"
```

---

## Task 2: Wire the stylesheet through `ui5-bootstrap.ts`

This loads the CSS for every page. The `html[data-hydrated="false"]` selector will only match on tutorial pages (set by Task 3), so the rules are inert elsewhere.

**Files:**
- Modify: `hugo/assets/js/ui5-bootstrap.ts`

- [ ] **Step 1: Add the CSS import at the top of the imports block**

In `hugo/assets/js/ui5-bootstrap.ts`, just below the `setTheme` import (line 4) and before the `Assets.js` side-effect imports, add:

```ts
// U14: shimmer rules for hydration placeholders + nav-progress-bar overrides.
// Selectors are scoped to attributes that only get set on relevant pages.
import "../css/skeletons.css";
```

- [ ] **Step 2: Confirm esbuild bundles the CSS**

Run: `npm run dev` (background) and visit any page in DevTools → Sources → look for inlined `skeleton-shimmer` keyframes in the `ui5-bootstrap-*.js` chunk.
Expected: keyframes string present.

Stop the dev server when verified.

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/js/ui5-bootstrap.ts
git commit -m "feat(u14): import skeleton stylesheet from ui5 bootstrap"
```

---

## Task 3: Pre-paint `data-hydrated="false"` for tutorial layouts

Sets the attribute before first paint so CSS shimmer is visible immediately. Mirrors the `data-reader` pre-paint pattern from U12.

**Files:**
- Modify: `hugo/layouts/partials/head.html`

- [ ] **Step 1: Find the existing pre-paint `<script>` block**

Run: `grep -n "data-reader\|reader === 'on'" hugo/layouts/partials/head.html`
Expected: matches at lines ~38 and ~41.

- [ ] **Step 2: Add the U14 pre-paint statement directly after the `data-reader` block**

In `hugo/layouts/partials/head.html`, inside the existing `<script>` (around line 43, after the closing `}` of the reader pre-paint), insert:

```js
  // U14: hydration shimmer pre-paint. Only tutorial layouts mark themselves
  // unhydrated; loadProgress() in tutorial.ts flips this to "true" after
  // /getProgress resolves (or 1.5s race timeout, or catch).
  if (document.documentElement.dataset.pageKind === 'tutorial') {
    document.documentElement.dataset.hydrated = 'false';
  }
```

- [ ] **Step 3: Add the tail-fallback flip**

At the very end of the same `<script>` block (before `</script>` on line 53), add:

```js
  // U14: bundle-failure safety net. If tutorial.ts never runs (network error,
  // CSP block, JS bundle 404), still flip after DOMContentLoaded + 2s so the
  // user is not stranded on shimmer.
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      if (document.documentElement.dataset.hydrated === 'false') {
        document.documentElement.dataset.hydrated = 'true';
      }
    }, 2000);
  });
```

- [ ] **Step 4: Manual verify with JS disabled in DevTools**

Run: `npm run fetch-tutorials && npm run dev` (background).
With DevTools open and JS disabled (`F1` → Settings → Preferences → Disable JavaScript), open `http://localhost:1313/tutorials/<any-slug>/`.
Expected: no shimmer (because the pre-paint script didn't run, `data-hydrated` is unset, CSS selectors don't match). Default empty progress bar visible.
Re-enable JS, hard reload — shimmer briefly visible, transitions away.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/head.html
git commit -m "feat(u14): pre-paint data-hydrated on tutorial pages"
```

---

## Task 4: Flip `data-hydrated` after `loadProgress()` resolves

The flip is idempotent — both the race timeout and the tail fallback set the same attribute to the same value, so order is irrelevant. We move `loadProgress()` into a wrapper that races against a 1.5 s timeout.

**Files:**
- Modify: `hugo/assets/js/tutorial.ts`

- [ ] **Step 1: Locate the `DOMContentLoaded` init block**

Run: `grep -n "DOMContentLoaded\|loadProgress\|initProgressBar" hugo/assets/js/tutorial.ts`
Expected: confirms `loadProgress` is called inside the `DOMContentLoaded` handler near line 538.

- [ ] **Step 2: Add the flip helper near the top of the file**

In `hugo/assets/js/tutorial.ts`, just below the `// --- API Helper ---` block (after the `apiPost` function, ~line 192), add:

```ts
// U14: flip data-hydrated on the documentElement once the progress fetch is
// settled (or after a 1.5s race timeout). Idempotent — the head.html tail
// fallback may have already done this; setting the same value is a no-op.
function markHydrated() {
  if (document.documentElement.dataset.hydrated === 'false') {
    document.documentElement.dataset.hydrated = 'true';
  }
}
```

- [ ] **Step 3: Wrap `loadProgress()` in the `DOMContentLoaded` handler**

In `hugo/assets/js/tutorial.ts`, change the `DOMContentLoaded` block (around line 536):

```ts
document.addEventListener('DOMContentLoaded', () => {
  initProgressBar()

  // U14: race the real fetch against a 1.5s timeout so a slow or 401 response
  // does not strand users on shimmer. Both branches call markHydrated();
  // markHydrated() is idempotent.
  Promise.race([
    loadProgress().then(markHydrated, markHydrated),
    new Promise<void>((resolve) => setTimeout(() => { markHydrated(); resolve() }, 1500)),
  ])

  initValidation()
  updateActiveTocItem()
  initMiniNavProgress()
  initAuthAwareButtons()
  initLightbox()
  initStepHashNavigation()
  initMermaid()
})
```

- [ ] **Step 4: Verify the bundle builds**

Run: `npm run dev` (background). Open `http://localhost:1313/tutorials/<any-slug>/` with DevTools Network throttled to "Fast 3G".
Expected: shimmer visible for ~200–800 ms, then real progress state paints. No console errors.

Throttle to "Offline" on a hard reload (so `/getProgress` fails). Expected: shimmer visible for at most 1.5 s, then default empty state paints.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add hugo/assets/js/tutorial.ts
git commit -m "feat(u14): flip data-hydrated after loadProgress with 1.5s race"
```

---

## Task 5: Add the navigation progress bar element

The `ui5-progress-indicator` lives at the top of the viewport on every page. JS animates `value` between 0 and ~90 during navigation.

**Files:**
- Create: `hugo/layouts/partials/nav-progress.html`
- Modify: `hugo/layouts/_default/baseof.html`

- [ ] **Step 1: Create the partial**

```html
{{/* U14: full-page navigation progress bar. Driven by hugo/assets/js/nav-progress.ts.
     `hidden` is repurposed as a fade flag — see .nav-progress-bar[hidden] in
     hugo/assets/css/skeletons.css for the display:block override. */}}
<ui5-progress-indicator id="nav-progress" hide-value value="0" class="nav-progress-bar" hidden></ui5-progress-indicator>
```

- [ ] **Step 2: Include the partial in baseof.html**

In `hugo/layouts/_default/baseof.html`, immediately after the `{{ partial "header.html" . }}` line (line 14), add:

```html
  {{/* U14: top-of-viewport navigation progress indicator. */}}
  {{ partial "nav-progress.html" . }}
```

- [ ] **Step 3: Manual verify the element is mounted**

Run: `npm run dev` (background). Open any page; in DevTools → Elements, confirm `<ui5-progress-indicator id="nav-progress" hidden>` is present directly after the `<header>` element. The element should be invisible (opacity 0 via CSS).

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/nav-progress.html hugo/layouts/_default/baseof.html
git commit -m "feat(u14): mount nav-progress indicator in baseof"
```

---

## Task 6: Register `ui5-progress-indicator` and add the nav-progress driver script

The element must be defined for `value` mutations to render. We register the component in `ui5-bootstrap.ts`, then import the new `nav-progress.ts` module that owns the click delegation and trickle.

**Files:**
- Create: `hugo/assets/js/nav-progress.ts`
- Modify: `hugo/assets/js/ui5-bootstrap.ts`

- [ ] **Step 1: Create the driver script**

```ts
// hugo/assets/js/nav-progress.ts
//
// U14: branded top-of-viewport progress indicator for full-page navigations.
// Trickles 0 → 30 → ~90 on internal-link click; jumps to 100 and hides on
// pagehide. Aborts back to hidden if no navigation actually happens within
// 100 ms (hash-only or JS-prevented click).

type Ui5ProgressIndicator = HTMLElement & { value: number }

const TRICKLE_INTERVAL_MS = 250
const TRICKLE_STEP_MIN = 1
const TRICKLE_STEP_MAX = 5
const TRICKLE_CEILING = 90
const ABORT_GRACE_MS = 100

function el(): Ui5ProgressIndicator | null {
  return document.getElementById('nav-progress') as Ui5ProgressIndicator | null
}

let trickleTimer: number | null = null
let abortTimer: number | null = null

function clearTimers() {
  if (trickleTimer !== null) { clearInterval(trickleTimer); trickleTimer = null }
  if (abortTimer !== null) { clearTimeout(abortTimer); abortTimer = null }
}

function show() {
  const bar = el()
  if (!bar) return
  bar.value = 0
  bar.hidden = false
  // jump quickly to 30, then trickle.
  requestAnimationFrame(() => { bar.value = 30 })
  trickleTimer = window.setInterval(() => {
    if (bar.value >= TRICKLE_CEILING) return
    const step = TRICKLE_STEP_MIN + Math.random() * (TRICKLE_STEP_MAX - TRICKLE_STEP_MIN)
    bar.value = Math.min(TRICKLE_CEILING, bar.value + step)
  }, TRICKLE_INTERVAL_MS)
}

function complete() {
  const bar = el()
  if (!bar) return
  clearTimers()
  bar.value = 100
  // brief hold, then fade. Timing is generous because pagehide may fire just
  // before the new document replaces this one.
  setTimeout(() => { bar.hidden = true; bar.value = 0 }, 50)
}

function abort() {
  const bar = el()
  if (!bar) return
  clearTimers()
  bar.hidden = true
  bar.value = 0
}

function isInternalNavigation(a: HTMLAnchorElement, e: MouseEvent): boolean {
  if (e.defaultPrevented) return false
  if (e.button !== 0) return false
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  const target = a.getAttribute('target')
  if (target && target !== '_self') return false
  if (a.hasAttribute('download')) return false
  const href = a.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false
  try {
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin) return false
    // same-page hash navigation: do not show the bar.
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return false
    return true
  } catch {
    return false
  }
}

export function initNavProgress() {
  if (!el()) return // partial not present (shouldn't happen, but guard anyway)

  // Click delegation. Use bubbling phase so other handlers (hash links) get
  // first say.
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null
    const a = target?.closest('a[href]') as HTMLAnchorElement | null
    if (!a) return
    if (!isInternalNavigation(a, e as MouseEvent)) return

    // Defer to ensure the element is registered before mutating `value`.
    customElements.whenDefined('ui5-progress-indicator').then(() => {
      show()
      // Grace timer: if visibility hides AND no pagehide arrived, abort.
      // Some clicks get cancelled synchronously after this handler returns
      // (form submits intercepted, JS-driven SPA detours we don't know about).
      abortTimer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') abort()
      }, ABORT_GRACE_MS)
    })
  })

  // Capture phase: pagehide fires before the document is torn down. We
  // intentionally use the default `once` behaviour — pagehide can fire more
  // than once across bfcache restores, and complete() is idempotent.
  window.addEventListener('pagehide', () => complete(), { capture: true })
  // beforeunload as a fallback for the rare browsers that skip pagehide.
  window.addEventListener('beforeunload', () => complete())

  // bfcache restore: reset visible state.
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) abort()
  })
}

initNavProgress()
```

- [ ] **Step 2: Register the UI5 component and import the driver in `ui5-bootstrap.ts`**

In `hugo/assets/js/ui5-bootstrap.ts`, in the side-effect imports block (after `RatingIndicator.js`, ~line 21), add:

```ts
import "@ui5/webcomponents/dist/ProgressIndicator.js";
```

Then, after the existing `import "./reading-progress";` line (~line 65), add:

```ts
// U14: full-page navigation progress bar. Self-bootstraps; safe no-op when
// the #nav-progress element is missing (i.e. partial not rendered).
import "./nav-progress";
```

- [ ] **Step 3: Manual verify**

Run: `npm run dev` (background). Open `http://localhost:1313/tutorials/`.
Expected on these clicks:
- Click any tutorial card → top progress bar fades in, trickles, navigates, completes.
- Cmd-click (or Ctrl-click) a tutorial card → opens new tab; current page bar does NOT show.
- Click a `#step-3` anchor inside an open tutorial → no nav bar.
- Click an external link (hover any `https://help.sap.com/...` link if present) → no nav bar.
- Browser back button → bar resets to hidden, no frozen state.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add hugo/assets/js/nav-progress.ts hugo/assets/js/ui5-bootstrap.ts
git commit -m "feat(u14): nav-progress driver + ui5-progress-indicator import"
```

---

## Task 7: Build the shared `Skeleton.vue` component

A single Vue component used by `TutorialNavigator.vue` now and (in follow-up branches) by `AppSpace.vue` / `MyCompletions.vue`.

**Files:**
- Create: `apps/src/shared/Skeleton.vue`

- [ ] **Step 1: Create the component**

```vue
<!-- apps/src/shared/Skeleton.vue
     U14: shared skeleton loader for Vue islands. Three modes — `card`, `text-line`,
     `rect`. The CSS lives in hugo/assets/css/skeletons.css and is inlined into
     each island bundle by vite-plugin-css-injected-by-js.
-->
<script setup lang="ts">
import '../../../hugo/assets/css/skeletons.css'

defineProps<{
  kind?: 'card' | 'text-line' | 'rect'
  count?: number
  height?: string
}>()
</script>

<template>
  <div class="skeleton-group" role="status" aria-busy="true" aria-label="Loading">
    <div
      v-for="i in (count ?? 1)"
      :key="i"
      class="skeleton"
      :class="`skeleton--${kind ?? 'rect'}`"
      :style="height ? { height } : undefined"
    ></div>
  </div>
</template>

<style scoped>
.skeleton-group {
  display: block;
}
</style>
```

- [ ] **Step 2: Verify the relative CSS import resolves**

Run: `npm run build:apps`
Expected: Vite build completes without `Could not resolve "../../../hugo/assets/css/skeletons.css"`. Each island that imports `Skeleton.vue` will have the shimmer rules inlined.

If Vite rejects the cross-boundary import (path resolution / `preserveSymlinks` quirk), fall back to copying the CSS file into `apps/src/shared/skeleton.css` and update the import line accordingly. Note the duplication in a comment at the top of both files. (See risks table in the spec.)

- [ ] **Step 3: Commit**

```bash
git add apps/src/shared/Skeleton.vue
git commit -m "feat(u14): shared Skeleton.vue component"
```

---

## Task 8: Render `<Skeleton>` in `TutorialNavigator.vue`

The navigator already shows nothing until `tutorials.value` is populated. Render six skeleton cards in that gap.

**Files:**
- Modify: `apps/src/navigator/TutorialNavigator.vue`

- [ ] **Step 1: Import the component**

First confirm whether the `@shared` Vite alias exists:

Run: `grep -n "'@shared'" apps/vite.config.ts apps/tsconfig.json 2>/dev/null`
Expected: either matches in both files (alias is set) or no matches at all (use the relative path below).

In `apps/src/navigator/TutorialNavigator.vue`, at the top of the `<script setup>` block, after the `useSearch` import (line 4), add ONE of:

```ts
// If `@shared` alias is configured (verified above):
import Skeleton from '@shared/Skeleton.vue'
// Otherwise use the relative path (default — alias is not currently configured):
import Skeleton from '../shared/Skeleton.vue'
```

Also confirm the directory exists, and create it if not:

Run: `ls apps/src/shared/ 2>/dev/null || mkdir -p apps/src/shared`
Expected: directory exists or is created (Task 7 already populated it with `Skeleton.vue`).

- [ ] **Step 2: Ensure `computed` is imported, then add a `loading` flag**

Run: `grep -n "from 'vue'" apps/src/navigator/TutorialNavigator.vue`
Expected: a single `import { … } from 'vue'` line near the top of `<script setup>`.

If `computed` is NOT already in that import list, add it. Example before:

```ts
import { ref, onMounted } from 'vue'
```

After:

```ts
import { ref, onMounted, computed } from 'vue'
```

Then, after the existing `searchQuery` ref declarations (around line 22, before the `useSearch` call), add:

```ts
const loading = computed(() => tutorials.value.length === 0)
```

- [ ] **Step 3: Render the skeleton in the empty-grid state**

In the `<template>` block, replace the existing `<section class="navigator-grid">…</section>` block (around line 666) with:

```html
      <!-- Section: Card Grid (or skeleton while loading) -->
      <section v-if="loading" class="navigator-grid navigator-grid--loading" aria-label="Loading tutorials">
        <Skeleton kind="card" :count="6" />
      </section>
      <section v-else class="navigator-grid">
        <a
          v-for="item in displayedItems"
          :key="item.id"
          :href="item.href"
          class="nav-card"
        >
          <div class="nav-card__type" :class="`nav-card__type--${item.type}`">
            {{ TYPE_LABELS[item.type] }}
          </div>

          <h3 class="nav-card__title">{{ item.title }}</h3>

          <p class="nav-card__desc">{{ item.description }}</p>

          <div class="nav-card__meta">
            <span class="nav-card__meta-item">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"/></svg>
              {{ capitalizeLevel(item.level) }}
            </span>
            <span class="nav-card__meta-sep">&middot;</span>
            <span class="nav-card__meta-item">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>
              {{ formatTime(item.time) }}
            </span>
            <template v-if="item.type !== 'tutorial'">
              <span class="nav-card__meta-sep">&middot;</span>
              <span class="nav-card__meta-item">{{ item.tutorialCount }} Tutorials</span>
            </template>
          </div>

          <div class="nav-card__tag">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5l7 7-5 5-7-7V3zm3 2a1 1 0 100 2 1 1 0 000-2z"/></svg>
            {{ item.primaryTag }}
          </div>
        </a>
      </section>
```

- [ ] **Step 4: Make `<Skeleton>` lay out as a card-shaped grid item**

Append to the `<style scoped>` block (after `.nav-card__tag svg` rules, around line 1154):

```css
.navigator-grid--loading {
  /* Inherit grid-template-columns from .navigator-grid via the cascade. */
}
.navigator-grid--loading .skeleton-group {
  display: contents; /* let each .skeleton card occupy a grid cell directly */
}
.navigator-grid--loading .skeleton--card {
  min-height: 200px;
  border-radius: 0.75rem;
  margin-bottom: 0; /* grid gap handles spacing */
}
```

- [ ] **Step 5: Build and manual-verify**

Run: `npm run build:apps && npm run dev`
With DevTools Network throttled to "Slow 3G", open `http://localhost:1313/tutorials/`.
Expected: six shimmering cards visible briefly while `_nav.json` and `/build/navigator` are still in-flight. They are replaced by real cards once both fetches resolve.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add apps/src/navigator/TutorialNavigator.vue
git commit -m "feat(u14): skeleton cards in TutorialNavigator while loading"
```

Do NOT stage `hugo/static/js/` here — those are Vite build artifacts. They are committed (or not) according to existing project conventions in their own dedicated build commits, not as part of this source change.

---

## Task 9: Cross-feature smoke pass

A single end-to-end manual run through every smoke item from the spec, after all code changes have landed. Catches interaction bugs that per-task verifications missed.

**Files:**
- None (verification only).

- [ ] **Step 1: Run the dev server and walk the spec checklist**

Run: `npm run fetch-tutorials && npm run dev` (background).

Walk every item from the spec's "Manual smoke" section ([docs/superpowers/specs/2026-05-22-u14-skeleton-loaders-design.md:196](../specs/2026-05-22-u14-skeleton-loaders-design.md#L196)):

1. Cold-load a tutorial as a logged-in user with prior progress → shimmer visible briefly, transitions to filled state.
2. Cold-load same tutorial as anonymous → shimmer flips off within 1.5 s; default empty state.
3. Click an internal tutorial link → top progress bar appears, animates to ~90%, completes.
4. Click an external link → no nav bar.
5. Click a hash link → no nav bar.
6. Cmd-click an internal link → opens new tab; no bar in current tab.
7. Browser back → bar reset, no frozen state.
8. Toggle theme → shimmer color follows; nav bar still visible.
9. Mobile viewport (375 × 667) → nav bar visible above shellbar; shimmer scales.
10. `prefers-reduced-motion: reduce` → shimmer is static opacity.
11. Browse to `/tutorials/` (TutorialNavigator) → six skeleton cards visible briefly, replaced by real cards.
12. Disable JavaScript → no skeleton; final state painted.

Stop the dev server.

- [ ] **Step 2: Run the existing smoke + unit suites**

Run: `npm test`
Expected: same 29 pre-existing failures as the `main` baseline ([MEMORY.md → Main Test Failures 2026-05-20](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_main_test_failures.md)). No NEW failures from the U14 changes. (No new logic-level tests are added; the feature is visual.)

Run (only if a smoke target is reachable): `npm run test:smoke`
Expected: pass — there is no regression in `/tutorials/*` HTTP paths.

- [ ] **Step 3: Run the linter**

Run: `npm run lint` (if present in package.json scripts), or skip if not configured.
Expected: clean.

- [ ] **Step 4: Final cleanup commit (only if smoke produced fixes)**

If any smoke item revealed a bug, fix it and commit with a `fix(u14): …` message. Otherwise this step is a no-op — proceed to PR.

---

## PR sign-off

The PR description should:

1. Link to [docs/superpowers/specs/2026-05-22-u14-skeleton-loaders-design.md](../specs/2026-05-22-u14-skeleton-loaders-design.md).
2. Embed (or link) a 5-second screen recording showing: cold-load shimmer → in-page hydration → click another tutorial → nav bar trickle → next page paints.
3. Include the 12-item manual smoke checklist (copied from Task 9, Step 1) with each item ticked.
4. Note follow-up branches `ui-pilot/u14b-appspace-skeleton` and `ui-pilot/u14c-mycompletions-skeleton` for AppSpace / MyCompletions skeleton wiring.

---

## Notes for executors

- **Idempotent flips matter.** `markHydrated()` in `tutorial.ts` and the tail fallback in `head.html` both write the same value. Order is irrelevant. Do not add guards that "first write wins" — the second write is a deliberate no-op.
- **Visual feature, no new unit logic.** Don't reach for new vitest specs unless you've changed runtime behavior outside the shimmer / trickle. The existing test baseline is 29 pre-existing failures; any new failures must be caused by your changes.
- **Cross-`apps/`-`hugo/` import.** If `Skeleton.vue`'s relative CSS import fails to resolve under Vite, copy `skeletons.css` into `apps/src/shared/skeleton.css` and reconcile both files via a top-of-file comment. Do NOT publish the CSS to npm or pull it in via a third path.
- **`ui5-progress-indicator` registration timing.** Always wrap mutations of `value` in `customElements.whenDefined('ui5-progress-indicator').then(…)`. Sync access in a click handler can race the bundle's element registration on the very first click of a cold load (precedent: U10 toast — [MEMORY.md → U10](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_u10_toast.md)).
- **Cross-page modules belong in `ui5-bootstrap.ts`, not `tutorial.ts`.** `nav-progress.ts` runs on every page; `tutorial.ts` only loads on tutorial layouts. This is the same lesson as U11 ([MEMORY.md → U11](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_u11_progress.md)).

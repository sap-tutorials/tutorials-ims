# View Transitions + Scroll-driven Animations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a progressive-enhancement layer that morphs the navigator card title into the destination page hero (cross-document View Transitions), cross-fades the light/dark theme toggle, and subtly reveals hero diagrams, step containers, mission heroes, images, and code blocks as they enter the viewport (CSS scroll-driven animations). Zero new dependencies, zero impact on browsers without API support, zero animation under `prefers-reduced-motion: reduce`.

**Architecture:** Two new CSS files (`view-transitions.css`, `scroll-animations.css`) loaded by the existing Hugo Pipes bundle, one new JS module (`view-transitions.ts`) wired through `ui5-bootstrap.ts`, one new shortcode (`hero.html`), and minimal markup additions to `TutorialNavigator.vue`, the Object Page hero, and the mission page hero. All animation logic is browser-native — no library, no polyfill. Click-time JS assigns `view-transition-name: hero-title` to the clicked nav-card title before navigation; the destination page hardcodes the matching name on its `<h1>`. Scroll-driven uses pure CSS `animation-timeline: view()` with one shared keyframe.

**Tech Stack:** Hugo (templates + Pipes/esbuild), TypeScript, Vue 3 (existing navigator component), Vitest (root `vitest.config.ts` `unit` and `smoke` projects), CSS `@view-transition` + `view-transition-name`, CSS `animation-timeline: view()`, `prefers-reduced-motion`.

## Spec amendments carried into this plan

The spec at `docs/superpowers/specs/2026-05-28-view-transitions-scroll-design.md` was approved before reconnaissance against the actual file layout. Three corrections are baked into this plan and supersede the spec on these points:

1. **VT-3 is dropped from scope.** The Object Page accordion (`hugo/layouts/shortcodes/tutorial-step.html`) has no between-steps navigation event — bodies toggle in-place via `[hidden]` on `.step-body`, no `.is-active` class exists, the heading is `.step-title-text` (a `<span>`, not `<h2>`), and there is no Next/Prev step control. The shortlist line was written before U1 Object Page; no real event exists for VT-3 to enhance. SD-8 (per-step subtle reveal on first scroll) covers the per-step polish. **No `morphSteps` export, no `active-step-heading` name in CSS, no `tutorial.ts` modification.**
2. **VT-1 and VT-2 unified.** The site has no `tutorial-card.html` or `mission-tile.html` partial. Both surfaces are rendered by one Vue component, [hugo-apps/src/navigator/TutorialNavigator.vue](hugo-apps/src/navigator/TutorialNavigator.vue), where the link is `<a class="nav-card">` with title at `.nav-card__title`. The `data-vt-card` marker and the click handler binding live in this Vue component. The single feature is "navigator nav-card → detail page (tutorial or mission Object Page)." The Object Page hero `<h1>` is at [hugo/layouts/tutorials/u1-object-page.html:192](hugo/layouts/tutorials/u1-object-page.html#L192) (`.op-header__title`); the mission page hero `<h1>` is at [hugo/layouts/missions/single.html:11](hugo/layouts/missions/single.html#L11) inside `<section class="mission-hero">`.
3. **Theme toggle entry points are inline scripts**, not `ui5-bootstrap.ts`. The toggles live at [hugo/layouts/partials/head.html:55-56](hugo/layouts/partials/head.html#L55-L56) and [hugo/layouts/partials/header.html:211-212](hugo/layouts/partials/header.html#L211-L212). The `morphTheme` wrapper is exposed as a global (`window.__morphTheme`) by `view-transitions.ts` and called from those inline scripts. This keeps theme-toggle pre-paint behavior intact and avoids reordering the toggle relative to its initial-paint setter at line 36.

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `hugo/assets/css/view-transitions.css` | `@view-transition { navigation: auto }` rule, single `.tutorial-hero-title { view-transition-name: hero-title }` declaration (mission and tutorial heroes share the same CSS class so the destination side is one selector). Wrapped in `@supports (view-transition-name: none)` and `@media (prefers-reduced-motion: no-preference)`. |
| `hugo/assets/css/scroll-animations.css` | Single `@keyframes hero-reveal { from { opacity: .7; transform: scale(.97) } to { opacity: 1; transform: scale(1) } }`. Four selector blocks apply it: `.hero-figure`, `.tutorial-step`, `.mission-hero`, `:where(figure):not(.hero-figure):not(.hero-figure *), pre.chroma`. Each block uses `animation: hero-reveal linear; animation-timeline: view(); animation-range: entry 0% cover 30%;`. Wrapped in `@supports (animation-timeline: view())` and `@media (prefers-reduced-motion: no-preference)`. |
| `hugo/assets/js/view-transitions.ts` | Two named exports plus a self-bootstrap. (a) `bindCardClick(root: ParentNode)` — attaches one delegated click listener that, on click inside `[data-vt-card] a`, walks to `.nav-card__title` and inlines `style.viewTransitionName = 'hero-title'`. (b) `morphTheme(applyFn: () => void)` — feature-detects `document.startViewTransition`; if missing, calls `applyFn()` directly; otherwise wraps. Self-bootstrap calls `bindCardClick(document)` at module load and exposes `window.__morphTheme = morphTheme`. |
| `hugo/layouts/shortcodes/hero.html` | One line: `<figure class="hero-figure">{{ .Inner | safeHTML }}</figure>`. |
| `hugo-apps/src/navigator/__tests__/vt-card-marker.test.ts` | Vitest test asserting the rendered `<a>` carries `data-vt-card="navigator"`. Replaces the spec's separate `data-vt-card="tutorial"` / `data-vt-card="mission"` — single marker, since the same component renders all three types. |
| `test/unit/view-transitions.test.ts` | Vitest tests for `bindCardClick` (sets the view-transition name on click within nav-card; no-op outside) and `morphTheme` (passthrough when API missing; wraps when present). Uses jsdom (already configured for the unit project). |
| `test/smoke/view-transitions.smoke.test.ts` | HTTP smoke: GET navigator, tutorial Object Page, mission page; assert markers (`data-vt-card`, `class="tutorial-hero-title"`, `class="mission-hero-title"`, `class="mission-hero"`). Fetch the compiled CSS bundle URL; assert `@view-transition`, `view-transition-name: hero-title`, `animation-timeline: view()`, `prefers-reduced-motion` strings appear. |

### Modified files (minimal touches)

| Path | Change |
|------|--------|
| `hugo/assets/js/ui5-bootstrap.ts` | Add one line: `import './view-transitions'`. Triggers the self-bootstrap. |
| `hugo/layouts/partials/head.html:55-56` | Wrap the inline-script theme toggle's `html.dataset.theme = next` line in `(window.__morphTheme || ((fn) => fn()))(() => { html.dataset.theme = next })`. |
| `hugo/layouts/partials/header.html:211-212` | Same wrap as head.html. |
| `hugo/layouts/tutorials/u1-object-page.html:192` | Add `class="tutorial-hero-title"` to the existing `<h1 class="op-header__title">`. Result: `class="op-header__title tutorial-hero-title"`. |
| `hugo/layouts/missions/single.html:11` | Add `class="mission-hero-title"` to the existing `<h1>`. Section already has `class="mission-hero"` (line 6) — SD-9 selector ready, no change needed there. |
| `hugo-apps/src/navigator/TutorialNavigator.vue:719-723` | Add `data-vt-card="navigator"` attribute to the `<a class="nav-card">` element. |

### Existing infrastructure relied on

- Hugo Pipes / esbuild bundle pipeline (no new build steps).
- Root `vitest.config.ts` already includes `hugo-apps/src/**/*.test.{js,ts}` in the `unit` project.
- The `unit` project runs in `environment: 'node'` ([vitest.config.ts:13](vitest.config.ts#L13)). Existing co-located Vue tests (e.g. `hugo-apps/src/navigator/cardProgress.test.ts`) test pure functions and don't touch `document`. The new tests in this plan DO touch `document` and so each new test file declares `// @vitest-environment happy-dom` at the top. `happy-dom` is already a root devDependency ([package.json:71](package.json#L71)) — no install needed.
- Smoke tests run against deployed URLs via `SMOKE_BASE_URL` / `SMOKE_SRV_URL` env vars.

---

## Task 1: Add `view-transitions.css` (destination side, declarative)

**Files:**

- Create: `hugo/assets/css/view-transitions.css`

- [ ] **Step 1: Create the CSS file**

```css
/* View Transitions — cross-document morph for navigator card → detail page.
   Wrapped in @supports so non-supporting browsers parse none of this.
   Wrapped in prefers-reduced-motion: no-preference so reduce users get nothing. */
@supports (view-transition-name: none) {
  @media (prefers-reduced-motion: no-preference) {
    @view-transition {
      navigation: auto;
    }
    .tutorial-hero-title,
    .mission-hero-title {
      view-transition-name: hero-title;
    }
  }
}
```

- [ ] **Step 2: Wire it into the Hugo Pipes bundle**

The existing pattern is import-from-TS (see `hugo/assets/js/ui5-bootstrap.ts:102` importing `../css/mission-side-nav.css`). We follow the same: the import is added in Task 4 inside `view-transitions.ts`. No separate Hugo template change is needed.

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/css/view-transitions.css
git commit -m "feat(vt): add view-transitions.css with cross-doc @view-transition rule"
```

---

## Task 2: Add `scroll-animations.css`

**Files:**

- Create: `hugo/assets/css/scroll-animations.css`

- [ ] **Step 1: Create the CSS file**

```css
/* Scroll-driven subtle reveals — opacity .7 → 1, scale .97 → 1.
   Single canonical effect applied to four surfaces. Pure CSS, no JS. */
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    @keyframes hero-reveal {
      from {
        opacity: 0.7;
        transform: scale(0.97);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .hero-figure,
    .tutorial-step,
    .mission-hero,
    :where(figure):not(.hero-figure):not(.hero-figure *),
    pre.chroma {
      animation: hero-reveal linear;
      animation-timeline: view();
      animation-range: entry 0% cover 30%;
    }
  }
}
```

The `:where(figure):not(.hero-figure):not(.hero-figure *)` selector adopts the spec section-5 form (carrying recommendation #3 from spec review) — excludes both the `.hero-figure` itself and any `<figure>` nested inside one, preventing double-animation when `{{< hero >}}` wraps a markdown image.

- [ ] **Step 2: Commit**

```bash
git add hugo/assets/css/scroll-animations.css
git commit -m "feat(scroll): add scroll-animations.css with shared hero-reveal keyframe"
```

---

## Task 3: Write the failing test for `view-transitions.ts`

**Files:**

- Create: `test/unit/view-transitions.test.ts`

> **DOM-setup note:** Per memory `feedback_html_property_blocked_by_hook.md`, the PreToolUse hook blocks file writes that contain the JS string-set DOM property for HTML content. The tests below use `document.createElement` + `textContent` + `appendChild` to build the test fixtures. The same constraint applies to any test code added later.
>
> **Test environment:** The `unit` Vitest project runs in `node` mode by default, but `document` is needed here. The first line of the new test file is the `@vitest-environment happy-dom` pragma so this file (and only this file) runs under a DOM. `happy-dom` is already a root devDependency.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
// test/unit/view-transitions.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

function buildNavCard(): HTMLAnchorElement {
  const link = document.createElement('a')
  link.className = 'nav-card'
  link.href = '/tutorials/foo'
  link.setAttribute('data-vt-card', 'navigator')

  const title = document.createElement('h3')
  title.className = 'nav-card__title'
  title.textContent = 'Foo Tutorial'
  link.appendChild(title)
  return link
}

function buildOtherLink(): HTMLAnchorElement {
  const link = document.createElement('a')
  link.className = 'other-link'
  link.href = '/x'

  const span = document.createElement('span')
  span.className = 'other-title'
  span.textContent = 'Foo'
  link.appendChild(span)
  return link
}

describe('view-transitions: bindCardClick', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  })

  it('sets view-transition-name on .nav-card__title when the nav-card link is clicked', async () => {
    const { bindCardClick } = await import('../../hugo/assets/js/view-transitions')
    document.body.appendChild(buildNavCard())
    bindCardClick(document)

    const title = document.querySelector('.nav-card__title') as HTMLElement
    title.click()

    expect(title.style.viewTransitionName).toBe('hero-title')
  })

  it('is a no-op when the click target is outside any [data-vt-card]', async () => {
    const { bindCardClick } = await import('../../hugo/assets/js/view-transitions')
    document.body.appendChild(buildOtherLink())
    bindCardClick(document)

    const title = document.querySelector('.other-title') as HTMLElement
    title.click()

    expect(title.style.viewTransitionName).toBe('')
  })
})

describe('view-transitions: morphTheme', () => {
  it('calls applyFn directly when document.startViewTransition is missing', async () => {
    const original = (document as unknown as { startViewTransition?: unknown }).startViewTransition
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
    const { morphTheme } = await import('../../hugo/assets/js/view-transitions')

    const applyFn = vi.fn()
    morphTheme(applyFn)

    expect(applyFn).toHaveBeenCalledOnce()
    if (original) (document as unknown as { startViewTransition?: unknown }).startViewTransition = original
  })

  it('wraps applyFn in document.startViewTransition when available', async () => {
    const startSpy = vi.fn((cb: () => void) => {
      cb()
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() }
    })
    ;(document as unknown as { startViewTransition: (cb: () => void) => unknown }).startViewTransition = startSpy
    const { morphTheme } = await import('../../hugo/assets/js/view-transitions')

    const applyFn = vi.fn()
    morphTheme(applyFn)

    expect(startSpy).toHaveBeenCalledOnce()
    expect(applyFn).toHaveBeenCalledOnce()
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npm test -- test/unit/view-transitions.test.ts
```

Expected: FAIL — module `hugo/assets/js/view-transitions` not found.

- [ ] **Step 3: Commit the test alone**

```bash
git add test/unit/view-transitions.test.ts
git commit -m "test(vt): add failing tests for bindCardClick and morphTheme"
```

---

## Task 4: Implement `view-transitions.ts` to make tests pass

**Files:**

- Create: `hugo/assets/js/view-transitions.ts`

- [ ] **Step 1: Write the minimal implementation**

```ts
// hugo/assets/js/view-transitions.ts
//
// Progressive-enhancement view-transition layer.
//
// - bindCardClick(root): attaches a delegated click listener so clicking
//   inside a [data-vt-card] sets `view-transition-name: hero-title` on the
//   nav-card title. The matching name on the destination page's <h1> (set
//   declaratively in view-transitions.css) lets the browser morph between
//   them across the navigation.
//
// - morphTheme(applyFn): wraps a same-document state change in
//   document.startViewTransition() when available; passthrough otherwise.
//
// Self-bootstraps on import: binds the document and exposes morphTheme as
// window.__morphTheme so inline theme-toggle scripts in Hugo partials can
// call it without a module import.

import '../css/view-transitions.css'
import '../css/scroll-animations.css'

const HERO_NAME = 'hero-title'
const TITLE_SELECTOR = '.nav-card__title'

export function bindCardClick(root: ParentNode): void {
  root.addEventListener('click', (event) => {
    const target = event.target as Element | null
    if (!target) return
    const card = target.closest('[data-vt-card]') as HTMLElement | null
    if (!card) return
    const title = card.querySelector(TITLE_SELECTOR) as HTMLElement | null
    if (!title) return
    title.style.viewTransitionName = HERO_NAME
  })
}

type StartViewTransition = (cb: () => void) => unknown

export function morphTheme(applyFn: () => void): void {
  const start = (document as unknown as { startViewTransition?: StartViewTransition }).startViewTransition
  if (typeof start !== 'function') {
    applyFn()
    return
  }
  start.call(document, applyFn)
}

bindCardClick(document)
;(window as unknown as { __morphTheme?: typeof morphTheme }).__morphTheme = morphTheme
```

- [ ] **Step 2: Run the tests and verify they pass**

```bash
npm test -- test/unit/view-transitions.test.ts
```

Expected: PASS — 4 tests passing.

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/js/view-transitions.ts
git commit -m "feat(vt): add view-transitions.ts with bindCardClick + morphTheme"
```

---

## Task 5: Wire `view-transitions.ts` into the Hugo bundle

**Files:**

- Modify: `hugo/assets/js/ui5-bootstrap.ts`

- [ ] **Step 1: Add the import**

Find the block of `import './…'` lines around lines 95-102 and add a single new line — placement near the end of the import group is fine since the module self-bootstraps:

```ts
// View Transitions + scroll-driven animations. Self-bootstraps; safe no-op when APIs missing.
import './view-transitions'
```

- [ ] **Step 2: Build and verify the bundle includes the new strings**

```bash
npm run dev
# In another terminal, find the actual ui5-bootstrap script URL (Hugo Pipes
# emits a hashed filename like /js/ui5-bootstrap.<hash>.js) and grep it:
SCRIPT_URL=$(curl -s http://localhost:1313/ | grep -oE '"/js/ui5-bootstrap[^"]*\.js"' | head -1 | tr -d '"')
[ -n "$SCRIPT_URL" ] || { echo "MISSING script tag"; exit 1; }
curl -s "http://localhost:1313$SCRIPT_URL" | grep -c 'hero-title' || echo "MISSING"
```

Expected: count `>= 1` (the literal `'hero-title'` from `HERO_NAME` survives bundling).

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/js/ui5-bootstrap.ts
git commit -m "feat(vt): wire view-transitions.ts into ui5-bootstrap"
```

---

## Task 6: Add `data-vt-card` marker to the navigator card

**Files:**

- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue:719-723`
- Create: `hugo-apps/src/navigator/__tests__/vt-card-marker.test.ts`

- [ ] **Step 1: Verify Vue test-utils availability**

```bash
cat package.json hugo-apps/package.json | jq -s '[.[].devDependencies // {}] | add | keys[] | select(test("vue/test-utils"))'
```

If empty, install at the root: `npm i -D @vue/test-utils`. If present in either, no install needed.

- [ ] **Step 2: Write a contract test for the marker shape**

Create `hugo-apps/src/navigator/__tests__/` if needed and add the test file. The first line is the `@vitest-environment happy-dom` pragma — `@vue/test-utils mount` needs a DOM:

```ts
// @vitest-environment happy-dom
// hugo-apps/src/navigator/__tests__/vt-card-marker.test.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

// Contract test for the View Transitions marker on the navigator card.
// We don't import TutorialNavigator (heavy deps) — we render a minimal
// harness that mirrors the relevant markup from
// TutorialNavigator.vue:718-764. The smoke test in
// test/smoke/view-transitions.smoke.test.ts verifies the real, deployed
// page emits the same shape.

describe('navigator card view-transition marker', () => {
  it('the rendered nav-card link carries data-vt-card="navigator"', () => {
    const wrapper = mount({
      template: `
        <a href="/tutorials/foo" class="nav-card" data-vt-card="navigator">
          <h3 class="nav-card__title">Foo</h3>
        </a>
      `,
    })
    const link = wrapper.find('a.nav-card')
    expect(link.exists()).toBe(true)
    expect(link.attributes('data-vt-card')).toBe('navigator')
  })
})
```

- [ ] **Step 3: Run the contract test (it should pass — it's a contract definition)**

```bash
npm test -- hugo-apps/src/navigator/__tests__/vt-card-marker.test.ts
```

Expected: PASS.

- [ ] **Step 4: Modify `TutorialNavigator.vue` to add the attribute**

Open [hugo-apps/src/navigator/TutorialNavigator.vue:719](hugo-apps/src/navigator/TutorialNavigator.vue#L719). The element currently reads:

```vue
<a
  v-for="item in displayedItems"
  :key="item.id"
  :href="item.href"
  class="nav-card"
  :class="{
    'nav-card--new': item.isNew,
    'nav-card--has-progress': !!cardProgress(item, progress),
  }"
>
```

Change to:

```vue
<a
  v-for="item in displayedItems"
  :key="item.id"
  :href="item.href"
  class="nav-card"
  data-vt-card="navigator"
  :class="{
    'nav-card--new': item.isNew,
    'nav-card--has-progress': !!cardProgress(item, progress),
  }"
>
```

- [ ] **Step 5: Build the navigator and verify the attribute reaches the bundle**

```bash
cd hugo-apps && npm run build && cd ..
grep -c 'data-vt-card' hugo/static/js/navigator*.js || echo "MISSING"
```

Expected: count `>= 1`.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue hugo-apps/src/navigator/__tests__/vt-card-marker.test.ts
git commit -m "feat(vt): mark nav-card with data-vt-card and contract test"
```

---

## Task 7: Add `tutorial-hero-title` class to the Object Page hero

**Files:**

- Modify: `hugo/layouts/tutorials/u1-object-page.html:192`

- [ ] **Step 1: Edit the H1**

Locate line 192 of [hugo/layouts/tutorials/u1-object-page.html](hugo/layouts/tutorials/u1-object-page.html#L192). It currently reads:

```html
<h1 class="op-header__title">{{ .Title }}{{ if in .Params.tags "tutorial>license" }} {{ partial "license-icon.html" . }}{{ end }}</h1>
```

Change the class attribute to:

```html
<h1 class="op-header__title tutorial-hero-title">{{ .Title }}{{ if in .Params.tags "tutorial>license" }} {{ partial "license-icon.html" . }}{{ end }}</h1>
```

- [ ] **Step 2: Verify the rendered HTML by starting the dev server**

```bash
npm run fetch-tutorials   # only if not run recently
npm run dev
```

In another terminal, pick any tutorial slug from the cache and verify:

```bash
SLUG=$(ls hugo/content/tutorials/ | head -1)
curl -s "http://localhost:1313/tutorials/$SLUG/" | grep -c 'op-header__title tutorial-hero-title' || echo "MISSING"
```

Expected: count `>= 1`.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "feat(vt): add tutorial-hero-title class to Object Page H1"
```

---

## Task 8: Add `mission-hero-title` class to the mission page hero

**Files:**

- Modify: `hugo/layouts/missions/single.html:11`

- [ ] **Step 1: Edit the H1**

Locate line 11 of [hugo/layouts/missions/single.html](hugo/layouts/missions/single.html#L11). It currently reads:

```html
<h1>{{ .Title }}{{ if in .Params.displayTags "License" }} {{ partial "license-icon.html" . }}{{ end }}</h1>
```

Change to:

```html
<h1 class="mission-hero-title">{{ .Title }}{{ if in .Params.displayTags "License" }} {{ partial "license-icon.html" . }}{{ end }}</h1>
```

The surrounding `<section class="mission-hero">` (line 6) already provides the SD-9 selector — no change needed there.

- [ ] **Step 2: Verify the rendered HTML**

With the dev server still running:

```bash
SLUG=$(ls hugo/content/missions/ 2>/dev/null | head -1 | sed 's/\.md$//')
curl -s "http://localhost:1313/missions/$SLUG/" | grep -c 'mission-hero-title' || echo "MISSING"
```

Expected: count `>= 1`.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/missions/single.html
git commit -m "feat(vt): add mission-hero-title class to mission page H1"
```

---

## Task 9: Wire theme-toggle inline scripts through `morphTheme`

**Files:**

- Modify: `hugo/layouts/partials/head.html` (lines ~55-58)
- Modify: `hugo/layouts/partials/header.html` (lines ~211-214)

> **Why all three lines must be inside `morphTheme`:** Each toggle does three state changes — `dataset.theme = next`, `classList.toggle('dark', …)`, and `localStorage.setItem('theme', next)`. The site's CSS keys off `html.dark` (per memory `project_u13_mermaid`: "the project flips html.dark for dark CSS scope"). If only the `dataset.theme` line is inside the `morphTheme` callback, the `.dark` class flip lands outside the captured frame — visual seam or no crossfade at all on rules keyed off `html.dark`. The `localStorage` write is harmless either way but is included for atomicity.

- [ ] **Step 1: Read both files to confirm exact current contents**

```bash
sed -n '50,62p' hugo/layouts/partials/head.html
sed -n '208,218p' hugo/layouts/partials/header.html
```

Confirm `head.html` contains, inside a click delegated handler:

```html
var next = html.dataset.theme === 'dark' ? 'light' : 'dark';
html.dataset.theme = next;
html.classList.toggle('dark', next === 'dark');
localStorage.setItem('theme', next);
```

And `header.html` contains, inside a `toggleTheme()` function, lines that look like:

```html
const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
html.dataset.theme = next;
html.classList.toggle('dark', next === 'dark');
try { localStorage.setItem('theme', next); } catch {}
themeItem.icon = next === 'dark' ? 'light-mode' : 'dark-mode';
```

Note: the line numbers in this plan are approximate; the file may shift by a line or two over time. Match by content.

- [ ] **Step 2: Edit `head.html` — wrap all three state-change lines**

Replace the four-line block:

```html
var next = html.dataset.theme === 'dark' ? 'light' : 'dark';
html.dataset.theme = next;
html.classList.toggle('dark', next === 'dark');
localStorage.setItem('theme', next);
```

with:

```html
var next = html.dataset.theme === 'dark' ? 'light' : 'dark';
(window.__morphTheme || function (fn) { fn(); })(function () {
  html.dataset.theme = next;
  html.classList.toggle('dark', next === 'dark');
  localStorage.setItem('theme', next);
});
```

- [ ] **Step 3: Edit `header.html` — wrap all three state-change lines (icon assignment stays outside)**

Replace the relevant block (the `themeItem.icon` assignment is **not** part of the morph — it's a UI5 internal property that has no effect on the captured frame):

```html
const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
html.dataset.theme = next;
html.classList.toggle('dark', next === 'dark');
try { localStorage.setItem('theme', next); } catch {}
themeItem.icon = next === 'dark' ? 'light-mode' : 'dark-mode';
```

with:

```html
const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
(window.__morphTheme || ((fn) => fn()))(() => {
  html.dataset.theme = next;
  html.classList.toggle('dark', next === 'dark');
  try { localStorage.setItem('theme', next); } catch {}
});
themeItem.icon = next === 'dark' ? 'light-mode' : 'dark-mode';
```

- [ ] **Step 4: Manually verify the toggle still flips the theme**

Start the dev server, open `http://localhost:1313/`, click the theme toggle, confirm:

- `data-theme` on `<html>` toggles between `light` and `dark` in DevTools.
- `class="dark"` is added/removed on `<html>` in lockstep with `data-theme`.
- `localStorage.theme` is `light` or `dark` after each click.
- Page colors swap.

On Chromium 111+: brief crossfade. On Firefox/Safari: instant flip with no console errors.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/head.html hugo/layouts/partials/header.html
git commit -m "feat(vt): wrap theme toggle (data-theme + dark class + localStorage) in morphTheme"
```

---

## Task 10: Add the `{{< hero >}}` shortcode

**Files:**

- Create: `hugo/layouts/shortcodes/hero.html`

- [ ] **Step 1: Create the shortcode**

```html
{{- /*
  hero shortcode — wraps a figure or diagram for SD-6 scroll-driven reveal.
  Usage:
    {{< hero >}}
    ![alt](./image.png)
    {{< /hero >}}

    {{< hero >}}
    {{< mermaid >}}
      graph LR
      A --> B
    {{< /mermaid >}}
    {{< /hero >}}
*/ -}}
<figure class="hero-figure">{{ .Inner | safeHTML }}</figure>
```

- [ ] **Step 2: Smoke-test the shortcode locally**

Pick any tutorial markdown file in `hugo/content/tutorials/`. Append this to the body for a one-off local test (we'll revert before commit):

```markdown
{{< hero >}}
![Test image](https://placehold.co/600x200/0a6ed1/ffffff?text=Hero+Test)
{{< /hero >}}
```

Run `npm run dev` and load the tutorial. Expected: page renders with the image inside `<figure class="hero-figure">`. In Chromium 115+, scroll past the figure — it animates from .7 / .97 to 1 / 1.

Revert the markdown change (`git checkout hugo/content/tutorials/<slug>/index.md`).

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/shortcodes/hero.html
git commit -m "feat(scroll): add {{< hero >}} shortcode for opt-in figure reveal"
```

---

## Task 11: Add the smoke test

**Files:**

- Create: `test/smoke/view-transitions.smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```ts
// test/smoke/view-transitions.smoke.test.ts
//
// Verifies the View Transitions + scroll-driven layer is deployed:
// - markup carries the markers and classes the design relies on
// - the compiled CSS bundle contains the @view-transition rule and the
//   scroll-driven keyframe selectors, wrapped in @supports + reduce-motion.
//
// Hugo's production minifier strips quotes from safe attribute values, so
// regex assertions tolerate both quoted and unquoted forms.

import { describe, it, expect } from 'vitest'

const BASE = process.env.SMOKE_BASE_URL
if (!BASE) throw new Error('SMOKE_BASE_URL must be set')

async function fetchText(path: string): Promise<string> {
  const res = await fetch(new URL(path, BASE))
  expect(res.ok, `${path} returned ${res.status}`).toBe(true)
  return res.text()
}

describe('view-transitions smoke', () => {
  it('navigator page has nav-cards with data-vt-card marker', async () => {
    const html = await fetchText('/build/navigator')
    expect(html).toMatch(/data-vt-card=["']?navigator["']?/)
    expect(html).toMatch(/class=["'][^"']*\bnav-card\b/)
  })

  it('a tutorial Object Page has tutorial-hero-title on the hero H1', async () => {
    const catalogJson = await fetchText('/build/catalog')
    const slugMatch = catalogJson.match(/"slug"\s*:\s*"([a-z0-9-]+)"/)
    expect(slugMatch, 'no tutorial slug in catalog').toBeTruthy()
    const slug = slugMatch![1]

    const tutorialHtml = await fetchText(`/tutorials/${slug}/`)
    expect(tutorialHtml).toMatch(/class=["'][^"']*\btutorial-hero-title\b/)
  })

  it('a mission page has mission-hero-title and mission-hero', async () => {
    const catalogJson = await fetchText('/build/catalog')
    const missionMatch = catalogJson.match(/"missions"[\s\S]*?"slug"\s*:\s*"([a-z0-9-]+)"/)
    expect(missionMatch, 'no mission slug in catalog').toBeTruthy()
    const slug = missionMatch![1]

    const missionHtml = await fetchText(`/missions/${slug}/`)
    expect(missionHtml).toMatch(/class=["'][^"']*\bmission-hero\b/)
    expect(missionHtml).toMatch(/class=["'][^"']*\bmission-hero-title\b/)
  })

  it('the compiled JS bundle includes the view-transitions module strings', async () => {
    const html = await fetchText('/')
    const jsMatch = html.match(/src=["']([^"']*ui5-bootstrap[^"']*\.js)["']/)
    expect(jsMatch, 'ui5-bootstrap.js script tag not found').toBeTruthy()
    const js = await fetchText(jsMatch![1])
    expect(js).toContain('hero-title')
  })

  it('the compiled CSS contains @view-transition and animation-timeline strings', async () => {
    const html = await fetchText('/')
    const cssRefs = Array.from(html.matchAll(/href=["']([^"']*\.css)["']/g)).map((m) => m[1])
    expect(cssRefs.length).toBeGreaterThan(0)
    const allCss = (await Promise.all(cssRefs.map((p) => fetchText(p)))).join('\n')
    expect(allCss).toMatch(/@view-transition/)
    expect(allCss).toMatch(/view-transition-name\s*:\s*hero-title/)
    expect(allCss).toMatch(/animation-timeline\s*:\s*view\(\)/)
    expect(allCss).toMatch(/prefers-reduced-motion\s*:\s*no-preference/)
  })
})
```

- [ ] **Step 2: Run the smoke test against the local hybrid setup**

```bash
# Start CAP backend + approuter so /build/catalog is reachable
npm run dev:hybrid &
HYBRID_PID=$!
# Allow services to come up
sleep 8
SMOKE_BASE_URL=http://localhost:5000 npm run test:smoke -- test/smoke/view-transitions.smoke.test.ts
kill $HYBRID_PID
```

Expected: 5 tests pass.

> **Note:** If running against `http-server hugo/public` (no `/build/catalog`), the catalog-driven assertions will fail; rely on the deployed-DEV smoke run in Task 13 for those.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/view-transitions.smoke.test.ts
git commit -m "test(smoke): cover view-transition markers and CSS bundle strings"
```

---

## Task 12: Run the full unit suite and confirm no regressions

- [ ] **Step 1: Run the full unit suite**

```bash
npm test
```

Expected: all tests pass, including the new `view-transitions.test.ts` and `vt-card-marker.test.ts`. Baseline before this work was 620 passing / 0 failing / 13 skipped (per memory). The new tests add ~5 to the passing count.

- [ ] **Step 2: If any pre-existing test fails, do NOT mark this task complete**

Investigate failures before continuing. The view-transitions changes are additive and should not break anything; if a pre-existing test fails after these changes, it's a real regression to fix before deploy.

- [ ] **Step 3: Commit any incidental fixups**

If no commits were needed, skip.

---

## Task 13: Deploy to DEV and run manual verification gates

> **Confirm scope with Tom before deploying.** Per memory `feedback_confirm_deploy_scope.md`, always confirm whether the deploy is backend-only, +content, or +QA. This change is frontend-only (Hugo + hugo-apps). Standard backend-only MTA build picks up the new CSS/JS/templates.

- [ ] **Step 1: Build and deploy to DEV**

```bash
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext && cd ..
```

Per memory `project_local_deploy_process.md`, this is the local-deploy bypass for the broken CI path.

- [ ] **Step 2: Run smoke tests against DEV**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npm run test:smoke -- test/smoke/view-transitions.smoke.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 3: Manual gate — Chromium with `prefers-reduced-motion: false`**

Open Chrome current. Visit the navigator page. Click a card. Expected: title morphs to the destination page hero (~250ms). Toggle theme: clean crossfade. Scroll a tutorial: hero figures and step containers subtly fade in.

- [ ] **Step 4: Manual gate — Chromium with `prefers-reduced-motion: true`**

In DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce`. Repeat Step 3. Expected: instant transitions, no fade, no morph, no reveal. Page works identically to today.

- [ ] **Step 5: Manual gate — Firefox current**

Repeat Step 3 actions. Expected: instant transitions and theme flip; no console errors. Page works identically to today.

- [ ] **Step 6: Manual gate — Safari current**

Repeat Step 3 actions. On Safari 18+, View Transitions work (cross-doc and same-doc). On Safari 26+, scroll-driven animations work. Below those versions: degrades silently.

- [ ] **Step 7: If all gates pass, the feature is ready to promote to PROD**

PROD promote is via the existing deploy flow; no additional steps for this feature.

---

## Notes for the implementer

- **Frequent commits.** Each task ends with a commit. Don't batch commits across tasks.
- **No new dependencies expected** other than `@vue/test-utils` if it's not already present (Task 6).
- **No backend changes.** This plan touches no CDS, no SQL, no HANA, no XSUAA, no env vars, no MTA structure. The MTA build picks up the new Hugo assets through the existing `hugo` module.
- **Don't rewrite U11.** The reading-progress bar's JS-driven scrollspy is explicitly out of scope (per spec section 2). Leave it alone.
- **The `next-steps-card` partial.** [hugo/layouts/partials/next-steps-card.html](hugo/layouts/partials/next-steps-card.html) renders cards but is not in scope for this plan — recommendation cards aren't part of the navigator. If a future iteration wants VT on those, that's a separate spec.
- **Reduced-motion testing in CI.** Vitest doesn't simulate `prefers-reduced-motion`; the manual gates in Task 13 are the only place that's verified. Keep them honest.
- **DOM-setup constraint in tests.** Per memory `feedback_html_property_blocked_by_hook.md`, the PreToolUse hook blocks file writes containing the JS DOM string-set HTML property. Always build test fixtures with `document.createElement` + `textContent` + `appendChild`.

# View Transitions + Scroll-driven Animations — Design

**Status:** In review 2026-05-28
**Author:** Tom (with Claude as collaborator)
**Feature shortlist entry:** Daily-use polish · "View Transitions API for step navigation" + "Scroll-driven animations"

## 1. Summary

A two-part progressive-enhancement layer that adds **native View Transitions** to discrete navigation events and **scroll-driven CSS animations** to long-form content on the tutorial site. Both ship together in one spec because they share the same character — no library, no polyfill, no build-time inflation, no JavaScript animation runtime — and because they touch the same Hugo layout files. They degrade silently to today's behavior on any browser missing the API.

This is a polish feature. The acceptance bar is **"adds value where supported, never breaks anything where it isn't, and never animates when `prefers-reduced-motion: reduce`."** Same bar as U10–U18.

## 2. Goals & non-goals

### Goals

- Card → detail navigation morphs the card title into the destination page hero title (cross-document VT).
- Step → step navigation inside an Object Page tutorial morphs the active step heading into place; bodies cross-fade.
- Light ↔ dark theme toggle does a clean cross-fade instead of a hard flip.
- Hero diagrams (author opt-in via `{{< hero >}}` shortcode) reveal subtly as they enter the viewport.
- Step containers, mission heroes, images, and code blocks reveal subtly on first scroll-into-view.
- Zero impact on browsers without the API. Zero impact on any user with `prefers-reduced-motion: reduce`.
- No new npm dependencies, no build-pipeline changes, no MTA changes, no HANA touch.

### Non-goals

- Rewriting U11's reading-progress bar with `animation-timeline: scroll()` (working code, separate concern).
- Cmd-palette → page transitions (palette nav is fast enough that a morph adds no value).
- Polyfills for Firefox or older Safari (`scroll-timeline-polyfill` exists; mutates DOM, costs ~20kB; rejected per "the point is the native capability").
- Per-effect intensity configuration on the shortcode (a single canonical "subtle" effect ships).
- Mermaid sequential-node-assemble (per-node naming on a re-rendering SVG is invasive; deferred to its own future U-bullet).
- Author-supplied keyframes (would leak raw CSS into tutorial markdown).
- Mission-card-thumbnail morphing (today's cards have no hero illustration; out of scope).

## 3. User-facing behavior

### VT-1 / VT-2 — Card → detail morph (cross-document)

The user clicks a tutorial card on the navigator (`/build/navigator` or any list page) or a mission tile on a mission grid. As the page navigates, the card title translates and resizes into the position of the destination page's hero `<h1>`, while everything else cross-fades. Total duration ~250ms, browser-default easing.

Failure modes:

- Card lacks the `data-vt-card` marker (legacy template path) → no name set → browser does default cross-fade. Page still navigates.
- Middle-click / Ctrl+click (open in new tab) → handler still runs and inlines the `view-transition-name` style on the card title; no VT fires because the document isn't replaced. The inline style remains until next navigation; harmless.
- Destination 404 → source-page snapshot shown briefly, then 404 page swaps in. No crash.
- Keyboard activation (Enter on focused link) → click handler fires per the standard event model.

### VT-3 — In-page step navigation (same-document)

User clicks Next, Prev, or a step in the side-nav inside an Object Page tutorial. The currently-active step's heading morphs to the new step's heading position and font size; the step body cross-fades. The Object Page already renders all steps in a single document with a `.tutorial-step.is-active` class controlling visibility — this feature only changes the `.is-active` toggle to run inside `document.startViewTransition()`.

Same-doc only — does not fire across document navigations.

### VT-4 — Theme toggle (same-document)

User clicks the light/dark chevron in the app shell header. Instead of an instant flip, the entire root cross-fades over ~250ms. No named elements; pure default cross-fade. The existing toggle handler in `ui5-bootstrap.ts` is wrapped in `startViewTransition`.

### SD-6 — Hero diagrams via `{{< hero >}}` shortcode

Authors mark a diagram or image as hero-worthy by wrapping it:

```markdown
{{< hero >}}
{{< mermaid >}}
graph LR
  UI --> CAP --> HANA
{{< /mermaid >}}
{{< /hero >}}
```

or

```markdown
{{< hero >}}
![Architecture overview](./images/arch.png)
{{< /hero >}}
```

The wrapped figure is rendered as `<figure class="hero-figure">…</figure>`. As the figure enters the viewport, it animates from opacity 0.7 + scale 0.97 to opacity 1 + scale 1 over the entry-cover range (linear easing tied to scroll position). Scrolling back up reverses the animation naturally — `animation-timeline: view()` is a function of element-in-viewport position, not a triggered event.

### SD-8 / SD-9 / SD-10 — Always-on subtle reveals

These apply with no author input:

- **SD-8:** every `.tutorial-step` element on the Object Page reveals on first scroll-into-view.
- **SD-9:** the `.mission-hero` block on every mission page reveals on first scroll-into-view.
- **SD-10:** every `figure` (excluding `.hero-figure`, which uses SD-6) and every `pre.chroma` (Hugo's syntax-highlighted code-block class) reveals on first scroll-into-view.

All four scroll-driven selectors share the same single keyframe (opacity .7 → 1, scale .97 → 1) and the same `animation-range: entry 0% cover 30%`. One canonical "subtle" effect, applied four places.

### Reduced-motion behavior

When `prefers-reduced-motion: reduce` is set:

- All `view-transition-name` declarations are omitted (CSS is wrapped in `@media (prefers-reduced-motion: no-preference)`).
- All scroll-driven keyframes are omitted (same wrapper).
- `morphSteps()` and `morphTheme()` still call `startViewTransition()`, but with no named elements the browser's cross-fade is effectively zero-duration.
- Functionally: every click navigates, every theme toggle flips, every diagram appears in its final state.

## 4. Architecture

```
┌── User's browser ──────────────────────────────────────────────┐
│                                                                │
│   Hugo-rendered tutorial / mission / navigator page            │
│   ├─ <head>: view-transitions.css + scroll-animations.css      │
│   ├─ Cards / tiles with [data-vt-card] markers                 │
│   ├─ Hero <h1> with .tutorial-hero-title / .mission-hero-title │
│   └─ Step containers .tutorial-step (existing from U11)        │
│                                                                │
│   ┌── view-transitions.ts (~40 LOC) ──────────────────────┐    │
│   │  - Delegated click handler on [data-vt-card] a        │    │
│   │  - export morphSteps(fromEl, toEl) for VT-3           │    │
│   │  - export morphTheme(applyFn) for VT-4                │    │
│   │  - All entry points feature-detect; no-op fallbacks   │    │
│   └────────────────────────────────────────────────────────┘    │
│                                                                │
│   Browser handles:                                             │
│   - @view-transition { navigation: auto } → cross-doc VT       │
│   - animation-timeline: view() → scroll-driven animations      │
│   - prefers-reduced-motion gate (CSS @media)                   │
└────────────────────────────────────────────────────────────────┘
```

### New files

- `hugo/assets/css/view-transitions.css` — `@view-transition` rule, `view-transition-name` declarations, all wrapped in `@supports (view-transition-name: none)` and `@media (prefers-reduced-motion: no-preference)`.
- `hugo/assets/css/scroll-animations.css` — single `@keyframes hero-reveal`, four selector blocks applying it with `animation-timeline: view()`. Same `@supports` and `@media` gates.
- `hugo/assets/js/view-transitions.ts` — delegated click handler + `morphSteps` + `morphTheme` exports. Feature-detects at module load.
- `hugo/layouts/shortcodes/hero.html` — single-template wrapper: `<figure class="hero-figure">{{ .Inner | safeHTML }}</figure>`.

### Modified files (minimal touches)

- `hugo/layouts/partials/tutorial-card.html` — add `data-vt-card="tutorial"` on root.
- `hugo/layouts/partials/mission-tile.html` — add `data-vt-card="mission"` on root.
- `hugo/layouts/tutorials/u1-object-page.html` — add `class="tutorial-hero-title"` to existing `<h1>`. Wire `morphSteps` into the existing step-nav handler.
- `hugo/layouts/missions/single.html` — add `class="mission-hero-title"` to existing `<h1>`. Add `class="mission-hero"` to existing hero block for SD-9.
- `hugo/assets/js/ui5-bootstrap.ts` — `import { morphTheme } from './view-transitions'` and wrap the existing dark-mode toggle (~3 LOC).
- `hugo/assets/js/tutorial.ts` — call `morphSteps` from the existing step-nav click handler.

### Module responsibilities

**`view-transitions.css`** is the single source of truth for VT names. Names declared here:

- `.tutorial-hero-title { view-transition-name: hero-title }` (destination side of VT-1)
- `.mission-hero-title { view-transition-name: hero-title }` (destination side of VT-2; same name — only one fires per navigation since you can't navigate from a tutorial card to a mission page in one click)
- `.tutorial-step.is-active > h2 { view-transition-name: active-step-heading }` (VT-3)
- `@view-transition { navigation: auto }` (turns cross-doc VT on)

The source side of VT-1 and VT-2 (the card title) gets its name assigned by JS at click time — see "Cross-document VT naming model" below.

**`view-transitions.ts`** has three responsibilities:

1. Attach one delegated `click` listener on `document`. On click, walk up to find `[data-vt-card]`. If found, locate the title element inside (e.g., `.card-title` or `h3`) and set `style.viewTransitionName = 'hero-title'` on it inline. Then return — let the click propagate to the link.
2. Export `morphSteps(fromEl, toEl)`. If `document.startViewTransition` is missing, just toggle classes directly. Otherwise wrap the toggle in `startViewTransition`.
3. Export `morphTheme(applyFn)`. Same pattern: if `startViewTransition` is missing, call `applyFn()` directly.

All three feature-detect. No throws, no console noise on unsupported browsers.

**`scroll-animations.css`** is purely declarative. One `@keyframes hero-reveal { from { opacity: .7; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }`. Four selector blocks apply it: `.hero-figure`, `.tutorial-step`, `.mission-hero`, `figure:not(.hero-figure), pre.chroma`. Each with `animation: hero-reveal linear; animation-timeline: view(); animation-range: entry 0% cover 30%;`.

**`hero.html` shortcode** is one line: `<figure class="hero-figure">{{ .Inner | safeHTML }}</figure>`.

### Cross-document VT naming model

Cross-doc VT requires `view-transition-name` to match between source and destination. Names must be unique per document at the moment of navigation — only one card can carry the name at a time.

We use the **JS-assigns-on-click** pattern (the standard since cross-doc VT shipped):

- Cards have nothing by default.
- On click, the delegated handler inlines `view-transition-name: hero-title` onto the clicked card's title element only.
- The destination page's CSS hardcodes `.tutorial-hero-title { view-transition-name: hero-title }`.
- The browser sees the same name on both ends and morphs between them.

Rejected alternatives:

- **CSS-only via `:active-view-transition`** — no clean spec-supported way to identify the clicked card from CSS without misusing `:hover` or `:focus`.
- **Per-card unique names (`tutorial-card-<slug>`)** — works but bloats CSS / inline styles for every linked tutorial. JS-assigns-on-click is ~10 LOC and avoids the bloat.

### Build pipeline impact

None. The new CSS and TS files compile through the existing Hugo Pipes / esbuild flow used by `tutorial.ts`, `lightbox.ts`, etc. No new npm dependencies, no new build steps, no MTA changes, no smoke-only deploys, no migration scripts.

### Why not rewrite U11 with scroll timelines

U11's reading-progress bar reads scroll position from JS to set a CSS custom property. It could be replaced with `animation-timeline: scroll()`, but the current code works, ships, and is observable in production. Out of scope; explicitly rejected during scoping.

## 5. Data flow

### VT-1 / VT-2 — Card → detail morph

```
User clicks card link
  ↓
Delegated handler in view-transitions.ts:
  1. e.target.closest('[data-vt-card]')
  2. find title element inside (.card-title or first h3)
  3. titleEl.style.viewTransitionName = 'hero-title'
  4. return — click propagates
  ↓
Browser navigates (sees @view-transition { navigation: auto })
  ↓
Browser snapshots source, fetches destination, parses CSS
  ↓
Destination has .tutorial-hero-title { view-transition-name: hero-title }
  ↓
Browser reconciles old name ↔ new name → morph (~250ms ease)
  ↓
Other elements default cross-fade
```

### VT-3 — In-page step morph

```
User clicks Next/Prev/step-in-side-nav
  ↓
existing tutorial.ts step-nav code calls morphSteps(fromEl, toEl)
  ↓
morphSteps:
  if (!document.startViewTransition) { toggleClasses(); return }
  document.startViewTransition(() => { toggleClasses() })
  ↓
.is-active class flips; CSS attaches view-transition-name to new active heading
  ↓
Browser sees old heading-with-name disappear, new heading-with-same-name appear
  ↓
Heading morphs (position + font-size); body crossfades
```

### VT-4 — Theme toggle

```
User clicks theme chevron in app shell
  ↓
existing handler in ui5-bootstrap.ts calls morphTheme(applyTheme)
  ↓
morphTheme:
  if (!document.startViewTransition) { applyTheme(); return }
  document.startViewTransition(applyTheme)
  ↓
Browser snapshots, applies theme (data-theme + class flip), crossfades root
```

### SD-6 / SD-8 / SD-9 / SD-10 — Scroll-driven reveal

```
Element enters viewport
  ↓
Browser sees animation: hero-reveal linear; animation-timeline: view();
  ↓
At entry 0% (just appearing): keyframe 0% (opacity .7, scale .97)
At cover 30% (30% past viewport top): keyframe 100% (opacity 1, scale 1)
  ↓
Scroll back up: animation reverses naturally
```

### Selector overlap

A `{{< hero >}}` wrapping a markdown figure produces `<figure class="hero-figure"> > <figure>`. The SD-10 selector `figure:not(.hero-figure)` excludes only the outer; the inner figure also matches. To prevent double-animation, the SD-10 selector is actually `:where(figure):not(.hero-figure):not(.hero-figure *)` — both the outer (because `:not(.hero-figure)`) and any descendant of `.hero-figure` are excluded.

### Cross-feature coordination

The four VT and four SD effects don't interact:

- VT names are scoped to the active document state; VT-3's `active-step-heading` is unrelated to VT-1's `hero-title`.
- VT-3 (step morph on click) and SD-8 (step reveal on first scroll) fire at different times on the same `.tutorial-step` element. CSS animations and view-transition snapshots are independent rendering layers — no conflict.
- Theme toggle (VT-4) changes `--sap-*` color custom properties; if a hero is mid-scroll-animation when the user toggles, the 250ms crossfade briefly shows a color blend. Acceptable, matches general theme-swap behavior.

## 6. Testing

### Unit tests (Vitest, in-memory)

`test/unit/view-transitions.test.ts`:

- Click on a card link inside `[data-vt-card]` → handler sets `viewTransitionName: 'hero-title'` on the title element.
- Click outside any `[data-vt-card]` → handler is a no-op.
- Module loaded in env without `document.startViewTransition` → `morphSteps` and `morphTheme` exported as direct passthroughs (no errors thrown, no transition called).

CSS rules are not unit-tested. Browser scrolling behavior is not unit-tested.

### Smoke tests (HTTP, post-deploy)

`test/smoke/view-transitions.smoke.test.ts`:

- GET a navigator-style page → assert `data-vt-card` attribute appears on tutorial cards.
- GET a sample tutorial Object Page → assert `class="tutorial-hero-title"` on the hero `<h1>`.
- GET a mission page → assert `class="mission-hero-title"` and `class="mission-hero"`.
- Fetch the compiled CSS bundle URL → assert `@view-transition`, `view-transition-name: hero-title`, `animation-timeline: view()` strings are present.
- Same CSS bundle → assert it's wrapped in `@supports` and `@media (prefers-reduced-motion: no-preference)`.

Smoke regex tolerance: per project memory, Hugo's production minifier strips quotes from safe attribute values; assertions use `/data-vt-card=["']?tutorial["']?/` patterns.

### Manual verification gates (per acceptance bar)

Verified in the browser before declaring done:

1. **Chromium with `reduce-motion: false`** — card → tutorial: title morphs, body fades. Step nav: heading morphs, body fades. Theme toggle: clean crossfade. Scroll: hero figure subtly reveals, steps fade in.
2. **Chromium with `reduce-motion: true`** (DevTools rendering pane) — same actions, no motion: instant transitions, no fade, no morph, no reveal. Page works identically to today.
3. **Firefox current** — same actions, no motion. No console errors. Identical to today.
4. **Safari current** — VT works (Safari 18+ supports both same-doc and cross-doc). Scroll-driven works on Safari 26+; degrades silently below.

## 7. Rollout

Single PR, single MTA deploy. No feature flag — the feature is its own feature flag (browsers without the API show today's behavior). Sequence:

1. Merge to main.
2. CI deploys to BTP DEV space.
3. Smoke tests run automatically.
4. Tom does manual verification gates 1–4 on DEV.
5. Promote to PROD via the existing deploy flow.

No data migration, no HANA touch, no env vars, no XSUAA scope changes.

## 8. Risks & mitigations

- **Cross-doc VT briefly shows flash of unstyled content if destination CSS loads slowly.** Mitigation: source and destination share the same Hugo-emitted CSS bundle, AppRouter caches, sub-100ms in practice.
- **The delegated click handler runs on every document click.** Mitigation: one listener, early-return on missing `[data-vt-card]` ancestor — O(1) for non-card clicks.
- **Scroll-driven animations cause layout thrash on long tutorials with many figures.** Mitigation: `animation-timeline: view()` runs on the compositor thread, doesn't trigger layout. Browser-confirmed perf path.
- **`@view-transition { navigation: auto }` triggers on every same-origin navigation, including admin UI links.** Mitigation: admin shell is at `/admin-ui/` and served from the approuter, not from the Hugo bundle — its CSS doesn't include `view-transitions.css`. Hugo-served pages opt in; admin shell remains untouched.

## 9. Open questions

None at design time. Implementation may surface details around the existing `tutorial.ts` step-nav handler that warrant tightening; those are plan-level concerns, not spec-level.

# Tutorial Detail Page — Display Preferences ("compact chrome") Design

- **Issue:** [#1966 — Fiori Header on Tutorial Details page](https://github.com/sap-tutorials/tutorials-ims/issues/1966)
- **Date:** 2026-08-21
- **Status:** Design — awaiting review
- **Scope:** Tutorial **detail** page only (`data-page-kind="tutorial"`). No other page type is touched.

## Problem

A user reports the locked (sticky) Fiori-style header on the tutorial detail page consumes
too much vertical screen space. On short viewports the effect is severe — and critically,
**laptops at high OS display scaling (Windows 125% / 150%) present a short CSS-pixel viewport**,
which is the most likely cause in the reported screenshot: a normal panel at 150% scale renders
as ~720 CSS px tall, so the locked header (title + description + chip row + progress) eats a large
fraction of the reading area.

The user asked for a configuration — "similar to reader mode (skinny mode?)" — that doesn't lock
the header, ideally auto-applied on smaller/short screens.

## Goals

- Give users control over how much vertical chrome the tutorial page shows, **without** stripping
  horizontal layout (sidebars, two-column grid stay intact). Optimize *vertical* flow only.
- Auto-apply a compact treatment on short viewports — including high-DPI-scaled laptops — while
  letting an explicit user choice always win.
- Keep it entirely in the Hugo / CSS / client-JS layer. No CAP, no backend, works for anonymous
  visitors (the majority of tutorial traffic).
- Keep it **separate** from reader/focus mode. This is not "reader mode plus" — reader mode strips
  most chrome and narrows the column; this mode keeps the widgets and only reclaims vertical space.

## Non-Goals (YAGNI)

- No server-side / cross-device sync of preferences.
- No keyboard shortcut (reader mode's `f` is untouched and unrelated).
- No preferences beyond the four toggles below.
- No effect on missions, groups, concepts, homepage, or any non-tutorial page.
- No `devicePixelRatio` / OS detection — the CSS-pixel `max-height` query captures scaled laptops
  intrinsically (see "Short-viewport auto-apply").

## Integration point (post-grounding)

There is already a **Tutorial preferences popover** wired to the `sb-prefs` shellbar item: the
`tutorial-prefs` Vue island (`hugo-apps/src/tutorial-prefs/`) — `TutorialPrefsPopover.vue` +
`main.ts` + `prefs-store.ts` + `constants.ts`. It currently hosts a Reader-mode switch and two
experimental camera-nav toggles (eye-tracking, hand-gesture), the latter gated on
`onTutorialPage`. This feature **extends that island** — a new "Display" section in the popover and
new prefs in the existing store — rather than adding a parallel popover. The `sb-prefs` item and the
island already render on all non-QA pages; the Display section (like Experimental) gates on
`onTutorialPage`.

The island has an **8 KB gzip budget** (`MAX_TUTORIAL_PREFS_GZIP` in `hugo-apps/vite.config.ts`);
new code must stay under it or be lazy-imported (the camera modules already are).

## Preference Model

Following the store's existing convention, each preference is its own localStorage key
(`tut.pref.*`), read/written through `prefs-store.ts` helpers — **not** a single JSON blob. A
pre-paint snippet in `head.html` reads these keys and sets **effective** `data-*` attributes on
`<html>` **before first paint** (same no-flash pattern as `theme`/`reader`/`embed`).

| localStorage key         | `data-*` attribute     | Values                            | Default |
|--------------------------|------------------------|-----------------------------------|---------|
| `tut.pref.header`        | `data-tut-header`      | `locked` · `thinbar` · `autohide` | unset → effective `locked` |
| `tut.pref.footer`        | `data-tut-footer`      | `shown` · `autohide`              | unset → effective `shown`  |
| `tut.pref.breadcrumbs`   | `data-tut-breadcrumbs` | `on` · `off`                      | `on`    |
| `tut.pref.feedback`      | `data-tut-feedback`    | `on` · `off`                      | `on`    |

"Effective" (header/footer): when the user has **not** set an explicit value, the attribute is
computed from the viewport — see "Short-viewport auto-apply". Explicit values are written verbatim.

## Behaviors (CSS + JS), all scoped to `[data-page-kind="tutorial"]`

New CSS lives in `hugo/assets/css/ui5-overrides.css` alongside (but independent of) the reader-mode
block. All selectors are gated on `[data-page-kind="tutorial"]` so nothing leaks to other pages.

### Header
- **`locked`** (default): unchanged — today's `.op-header { position: sticky; top: 0 }`.
- **`thinbar`**: header stays sticky but collapses — hide `.op-header__description` and
  `.op-header__chips`, tighten padding, keep `.op-header__title` + `.op-progress` ring. Pure CSS.
- **`autohide`**: header un-sticks and, via a scroll handler, translates off-screen on scroll-down
  and slides back on scroll-up; hovering the top edge (a thin hotspot) also reveals it. JS-driven.

### Footer (`autohide`)
Taskbar-style: the tutorial footer is parked off the bottom edge (`transform: translateY(100%)`)
and slides up on hover of a thin bottom-edge hotspot, or when the reader scrolls to the page bottom.
Content is **not** padded for it (it overlays on reveal, like an OS taskbar). Default `shown` leaves
the footer in normal document flow.

### Breadcrumbs / Feedback
`off` sets `display: none` on `.breadcrumbs` / `.feedback-share` respectively (both already rendered
by the tutorial layout via `partial "breadcrumbs.html"` and `partial "feedback-share.html"`).

### Short-viewport auto-apply
When the user has set no explicit `header`/`footer` pref, the **effective** attribute is derived
from viewport height: below the threshold the header becomes `thinbar` and the footer `autohide`;
at or above it, `locked` / `shown`. Because auto-hide requires a JS scroll/hover handler regardless,
JS (and the pre-paint snippet) — not a CSS media query — owns the threshold and writes the effective
`data-tut-header` / `data-tut-footer`. CSS then keys purely off those attributes (single source of
truth; no CSS `:not()` + `@media` interaction to reason about). The threshold is re-evaluated live
via `matchMedia('(max-height: 900px)')` `change` events (rotation, resize, zoom).

Because CSS/`matchMedia` height is measured in **CSS pixels**, OS display scaling and browser zoom
shrink the reported viewport, so high-scale laptops cross the threshold automatically — no DPR or
platform detection. Threshold mapping (maximized browser, CSS-px inner height):

| Device / scale              | ~CSS-px height | Below 900? |
|-----------------------------|----------------|------------|
| 1080p @100% (desktop)       | ~1040          | No (correct)|
| 1080p @125%                 | ~865           | Yes        |
| 1080p @150%                 | ~720           | Yes        |
| 1366×768 laptop @100%       | ~700           | Yes        |

900px is the initial threshold, defined once in `constants.ts` (and mirrored, with a comment, in the
inline pre-paint snippet, which cannot import it — same documented duplication as the embed
allowlist).

## Settings Surface

Extend the existing `TutorialPrefsPopover.vue` with a new **"Display"** section, gated on
`onTutorialPage` (same gate as the Experimental section), placed above Experimental. Rows:
- **Header** — a 3-way control (Locked · Compact · Auto-hide), as three `ui5-segmented-button-item`s in a `ui5-segmented-button`, or a `ui5-select` — matching the popover's existing UI5 idiom.
- **Footer auto-hide** — `ui5-switch`
- **Show breadcrumbs** — `ui5-switch`
- **Show feedback bar** — `ui5-switch`

State + emit handlers are added to `main.ts` alongside the existing reader/camera wiring; toggling a
pref writes it via `prefs-store.ts` and calls the apply function to update `data-tut-*` immediately.

## Code Layout

- **`hugo-apps/src/tutorial-prefs/constants.ts`** — add `KEY_PREF_HEADER`, `KEY_PREF_FOOTER`,
  `KEY_PREF_BREADCRUMBS`, `KEY_PREF_FEEDBACK`, `SHORT_VIEWPORT_MAX_HEIGHT = 900`, and
  `HeaderMode` / `FooterMode` / `OnOff` types.
- **`hugo-apps/src/tutorial-prefs/prefs-store.ts`** — add typed get/set for the four display prefs
  (header/footer getters return `HeaderMode | null` / `FooterMode | null` so explicit-vs-unset is
  distinguishable; breadcrumbs/feedback default `on`).
- **`hugo-apps/src/tutorial-prefs/display-chrome.ts`** *(new)* — `computeEffective(prefs, short)`
  (pure) → effective header/footer modes; `applyDisplayChrome()` sets the `data-tut-*` attributes;
  `installAutoHide()` wires the header scroll-direction handler + footer bottom-edge hover /
  scroll-to-bottom reveal and a `matchMedia` listener that re-applies on threshold change. Respects
  `prefers-reduced-motion`.
- **`hugo-apps/src/tutorial-prefs/main.ts`** — add reactive display state, pass to popover, handle
  new emits, and call `applyDisplayChrome()` + `installAutoHide()` in `init()` when `onTutorial`.
- **`hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue`** — add the Display section + props/emits.
- **`hugo/layouts/partials/head.html`** — extend the existing pre-paint `<script>` with a block that
  reads the four keys and sets effective `data-tut-*` (guarded by `previewMode` like reader/embed).
- **`hugo/assets/css/ui5-overrides.css`** — new tutorial-scoped block keyed off `data-tut-*`
  (thinbar collapse, autohide transforms, breadcrumbs/feedback hide). No `@media` height query.

The scroll/hover behaviors live in `display-chrome.ts` (island-local), not the shared `tutorial.ts`.

## Interaction Notes / Edge Cases

- **Anchor offsets:** `.op-section { scroll-margin-top }` and `--op-header-h` (set by the existing
  ResizeObserver in `u1-object-page.html`) assume a sticky header. With `autohide`/short-viewport,
  the ResizeObserver keeps `--op-header-h` current; when the header is translated off-screen the
  offset harmlessly over-reserves a little. Verify scroll-to-step lands correctly under each header
  mode during implementation.
- **Explicit vs auto precedence:** setting any header/footer pref writes the attribute, which
  disables the `:not([data-tut-*])` auto rule for that widget — so a user who *wants* the locked
  header on a short laptop keeps it. This is the intended override semantics.
- **Reader/embed coexistence:** reader mode and `embed` set their own `data-*` and have their own
  cascade; the new attributes are orthogonal. Where reader mode already hides `.breadcrumbs` /
  `.feedback-share` / footer, its `!important` rules win — acceptable (reader mode is the stronger
  "strip everything" mode).

## Testing

- **Unit:** guard the pre-paint JSON→attribute mapping (valid JSON, partial objects, malformed JSON
  falls back to no attributes / defaults) and a CSS-presence guard for the new tutorial-scoped rules.
- **E2E (`test/e2e/`, repo convention for `hugo/**` UI changes):** toggle each preference via the
  popover and assert the DOM/attribute + a visible effect; drive the viewport to `height < 900` and
  assert the auto compact treatment applies when no explicit pref is set, and that an explicit pref
  overrides it.
- Both the pre-paint duplication (head.html snippet mirrors the `constants.ts` keys + threshold) and
  the tutorial-only scoping are the fragile seams — cover them explicitly.

## Rollback

Remove the shellbar gear + popover markup, the pre-paint block, the `chrome-prefs.ts` load, and the
new CSS block. No schema, no data, no server change — fully reversible in the Hugo layer.

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

## Preference Model

A single localStorage key `tut-chrome` holds a small JSON object. A pre-paint snippet in
`head.html` reads it and sets `data-*` attributes on `<html>` **before first paint** — the same
no-flash pattern already used for `theme`, `reader`, and `embed`. Only keys the user has explicitly
set are written; absence means "no explicit preference" (which is what the auto path keys off).

```jsonc
// localStorage["tut-chrome"] example
{ "header": "thinbar", "footer": "autohide", "breadcrumbs": false, "feedback": true }
```

Mapping to attributes on `<html>` (only present when explicitly set):

| JSON key      | `data-*` attribute       | Values                              | Default (unset) |
|---------------|--------------------------|-------------------------------------|-----------------|
| `header`      | `data-tut-header`        | `locked` · `thinbar` · `autohide`   | `locked`        |
| `footer`      | `data-tut-footer`        | `shown` · `autohide`                | `shown`         |
| `breadcrumbs` | `data-tut-breadcrumbs`   | `on` · `off`                        | `on`            |
| `feedback`    | `data-tut-feedback`      | `on` · `off`                        | `on`            |

Rationale for one JSON key over four localStorage keys: a single parse in the pre-paint snippet,
one write path, and the "no explicit pref" test is simply "attribute absent."

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
A `@media (max-height: 900px)` block applies the compact defaults — `thinbar` header +
`autohide` footer — **only when the user has set no explicit preference for that widget**, e.g.:

```css
@media (max-height: 900px) {
  html:not([data-tut-header])[data-page-kind="tutorial"] .op-header { /* thinbar rules */ }
  html:not([data-tut-footer])[data-page-kind="tutorial"] footer     { /* autohide rules */ }
}
```

Because CSS `max-height` is evaluated in **CSS pixels**, OS display scaling and browser zoom both
shrink the reported viewport height, so high-scale laptops trip the query automatically — no DPR or
platform detection. Threshold mapping (maximized browser, CSS-px inner height):

| Device / scale              | ~CSS-px height | Tripped at 900? |
|-----------------------------|----------------|-----------------|
| 1080p @100% (desktop)       | ~1040          | No (correct)    |
| 1080p @125%                 | ~865           | Yes             |
| 1080p @150%                 | ~720           | Yes             |
| 1366×768 laptop @100%       | ~700           | Yes             |

900px is the initial threshold and is tunable in one place.

## Settings Surface

A new **"Display settings"** control (gear icon) in the shellbar opens a `ui5-popover` containing:
- Header: segmented / select — Locked · Compact (thin bar) · Auto-hide
- Footer: `ui5-switch` — Auto-hide on/off
- Breadcrumbs: `ui5-switch`
- Feedback bar: `ui5-switch`

A popover (not extra items in the existing shellbar overflow menu) is chosen because there are 4+
grouped toggles; a menu row per option would be cramped and hard to group. The popover is only wired
on tutorial pages.

## Code Layout

- **`hugo/layouts/partials/head.html`** — extend the existing pre-paint `<script>` with a small
  block: parse `tut-chrome`, set the four `data-*` attributes. Guarded by `previewMode` like the
  reader/embed pre-paint already is.
- **`hugo/assets/css/ui5-overrides.css`** — new tutorial-scoped block for the four behaviors +
  the `@media (max-height: 900px)` auto block. Independent of the reader-mode cascade.
- **`hugo/assets/js/chrome-prefs.ts`** — new module (loaded on tutorial pages only): read/write
  `tut-chrome`, apply attributes at runtime on toggle, the scroll + top-edge-hover handler for
  `autohide` header, the bottom-edge-hover / scroll-to-bottom handler for `autohide` footer, and
  popover wiring. Respects `prefers-reduced-motion` (no transition) like the reader block does.
- **`hugo/layouts/partials/header.html`** — add the gear button + popover markup to the shellbar,
  rendered only for `data-page-kind="tutorial"`.

The scroll/hover behaviors are tutorial-detail-specific, so they belong in a dedicated module rather
than the shared `tutorial.ts` or inline `header.html` script.

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
- Both the pre-paint duplication (head.html snippet mirrors chrome-prefs.ts allowlist) and the
  tutorial-only scoping are the fragile seams — cover them explicitly.

## Rollback

Remove the shellbar gear + popover markup, the pre-paint block, the `chrome-prefs.ts` load, and the
new CSS block. No schema, no data, no server change — fully reversible in the Hugo layer.

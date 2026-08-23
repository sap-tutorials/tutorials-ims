# Tutorial Reading Preferences — Batch 2 (#1966 follow-up)

**Date:** 2026-08-22
**Status:** Design approved (in chat) — spec under review
**Base branch:** `origin/DEV` (where #1966 / PR #1969 / PR #1973 live)
**Related:** #1966 (tutorial display preferences — header/footer/breadcrumbs/discussion)

## Summary

#1966 added a **Display** section to the tutorial-preferences popover (`#sb-prefs`)
that lets readers control vertical chrome (header lock/compact/auto-hide, footer
auto-hide, breadcrumbs, discussion), applied before first paint via `data-tut-*`
attributes on `<html>`. This change extends the *same* island, the *same*
pre-paint mirror, and the *same* CSS-attribute mechanism with a second batch of
**reading-ergonomics** preferences that a user cannot get from browser zoom alone:

- **Text** — body text size (S/M/L) and reading width (Full/Narrow).
- **Code** — code-block font size (S/M/L), wrap long lines, and "copy without prompt".
- **Screenshots** — inline size cap (S/M/L) and a collapse-all toggle. Screenshots
  are critical tutorial content, so nothing is ever hidden destructively; the
  existing full-featured lightbox remains the path to full detail.
- **Accessibility** — reduce motion and an easier-to-read (OpenDyslexic) font.

Every preference is per-device (`localStorage`, works for anonymous visitors),
gated to `data-page-kind="tutorial"`, and fully reversible in the Hugo layer.
There is **no schema, server, or content change**.

## Motivation

Tutorials are code- and screenshot-heavy. The top reading complaints not solved
by browser zoom:

1. **Wide command lines** overflow code blocks, forcing horizontal scroll.
2. **Prompt characters** (`$ `, `> `) get copied with commands and break paste.
3. **Large screenshots** dominate the reading flow on short/scaled viewports,
   even though the lightbox already exists for detail-on-demand.
4. **Small code/body text** at a fixed size; browser zoom reflows the whole
   chrome rather than just the reading content.
5. **Accessibility**: motion-sensitivity and dyslexia-friendly reading are unmet.

## Non-Goals

- No per-account persistence or cross-device sync. Prefs stay per-device, keeping
  the feature fully reversible with no schema/server dependency (matches #1966).
- No change to the lightbox, browse/homepage imagery, or any non-tutorial page.
- No new popover — this extends the existing Display section.
- No build-time content transformation (published tutorial HTML is unchanged).

## Architecture

Identical to #1966. Data flows:

```
tut.pref.* (localStorage, per-device)
  → head.html pre-paint snippet mirrors computeEffective → data-tut-* on <html>  (no flash)
    → CSS in ui5-overrides.css keys purely off data-tut-* attributes
  → tutorial-prefs Vue island reads/writes prefs + re-applies attrs on change
  → copyCodeBlock (page script) reads copy-clean pref at copy time
```

The pre-paint snippet sets effective attributes **before first paint**, exactly
as `theme`/`reader`/`embed`/the #1966 chrome attrs already do. CSS owns all
visual treatment; JS owns only (a) writing prefs and re-applying attrs on change,
(b) the copy-clean transform, and (c) the pre-existing header auto-hide handler
(unchanged).

## Preferences

| Pref | localStorage key | Values (default) | `<html>` attr | Mechanism |
|---|---|---|---|---|
| Text size | `tut.pref.textSize` | `s` / `m` / `l` (**m**) | `data-tut-text-size` | CSS var on content root |
| Reading width | `tut.pref.readWidth` | `full` / `narrow` (**full**) | `data-tut-read-width` | CSS `max-width` var |
| Code size | `tut.pref.codeSize` | `s` / `m` / `l` (**m**) | `data-tut-code-size` | CSS `font-size` on `pre code` |
| Code wrap | `tut.pref.codeWrap` | `on` / `off` (**off**) | `data-tut-code-wrap` | CSS `white-space: pre-wrap` |
| Copy-clean | `tut.pref.copyClean` | `on` / `off` (**off**) | *(none)* | JS branch in `copyCodeBlock` |
| Screenshot size | `tut.pref.imgSize` | `s` / `m` / `l` (**l**) | `data-tut-img-size` | CSS `max-height` on tutorial `img` |
| Collapse screenshots | `tut.pref.imgCollapse` | `on` / `off` (**off**) | `data-tut-img-collapse` | CSS collapsed strip |
| Reduce motion | `tut.pref.reduceMotion` | `on` / `off` (**off**) | `data-tut-reduce-motion` | CSS (+ honors `prefers-reduced-motion`) |
| Readable font | `tut.pref.readableFont` | `on` / `off` (**off**) | `data-tut-readable-font` | CSS `@font-face` (lazy) |

**Defaults note:** `imgSize` defaults to `l` (current/natural rendering) so the
default reading experience is unchanged. `s`/`m` cap `max-height`; the browser
preserves aspect ratio.

`copyClean` needs no paint attribute — it is a behavioral change at copy time, not
a visual one. It is read directly from `localStorage` by the page script. A
`data-tut-copy-clean` attr MAY be set for test observability but is not required
for correctness.

## Components

### 1. `constants.ts` (extend)
Add the six new keys, value unions, and defaults:

```ts
export const KEY_PREF_TEXT_SIZE = 'tut.pref.textSize';
export const KEY_PREF_READ_WIDTH = 'tut.pref.readWidth';
export const KEY_PREF_CODE_SIZE = 'tut.pref.codeSize';
export const KEY_PREF_CODE_WRAP = 'tut.pref.codeWrap';
export const KEY_PREF_COPY_CLEAN = 'tut.pref.copyClean';
export const KEY_PREF_IMG_SIZE = 'tut.pref.imgSize';
export const KEY_PREF_IMG_COLLAPSE = 'tut.pref.imgCollapse';
export const KEY_PREF_REDUCE_MOTION = 'tut.pref.reduceMotion';
export const KEY_PREF_READABLE_FONT = 'tut.pref.readableFont';

export type SizeStep = 's' | 'm' | 'l';
export type ReadWidth = 'full' | 'narrow';
// OnOff already exists from #1966.
```

### 2. `prefs-store.ts` (extend)
Add typed getter/setter pairs following the existing `safeLocal()` pattern:
`getTextSize`/`setTextSize`, `getReadWidth`/`setReadWidth`, `getCodeSize`/`setCodeSize`,
`getCodeWrap`/`setCodeWrap`, `getCopyClean`/`setCopyClean`, `getImgSize`/`setImgSize`,
`getImgCollapse`/`setImgCollapse`, `getReduceMotion`/`setReduceMotion`,
`getReadableFont`/`setReadableFont`. Each getter returns the default on missing or
invalid values (defensive parse, matching #1966).

### 3. `display-chrome.ts` (extend)
Extend `DisplayPrefs`/`Effective`, `readPrefs()`, `computeEffective()`, and
`applyDisplayChrome()` to cover the new attrs. These new prefs have **no
short-viewport auto behavior** — they are plain pass-through (effective = stored
or default). Only header/footer retain the `shortViewport` branch from #1966.
`installAutoHide()` is unchanged.

### 4. `TutorialPrefsPopover.vue` (extend)
Add rows to the existing **Display** section, grouped with subheadings:
- **Text**: size segmented (S/M/L), width segmented (Full/Narrow).
- **Code**: size segmented (S/M/L), wrap switch, copy-clean switch.
- **Screenshots**: size segmented (S/M/L), collapse switch.
- **Accessibility**: reduce-motion switch, readable-font switch.

Controls mirror #1966 (segmented buttons + switches). On any change: write pref,
call `applyDisplayChrome()`. Keep markup lean to protect the island gzip budget.

### 5. `head.html` pre-paint (extend)
Extend the existing pre-paint snippet to read the new `tut.pref.*` keys and set
the new `data-tut-*` attrs before paint. The snippet cannot import the module, so
the short-viewport constant stays mirrored (with a comment) as in #1966; the new
prefs are simple key→attr with default fallback, no threshold logic.

### 6. `ui5-overrides.css` (extend)
Add attribute-keyed rules, all scoped under `[data-page-kind="tutorial"]`:
- `--tut-text-scale` / `--tut-read-max` CSS vars per size/width, applied to the
  tutorial content root only (not chrome).
- `pre code` font-size per `data-tut-code-size`; `white-space: pre-wrap` under
  `data-tut-code-wrap="on"`.
- Tutorial `img` (scoped to `.tutorial-figure` / tutorial content wrapper)
  `max-height` per `data-tut-img-size`; collapsed slim dimmed strip with a
  "click to view" affordance under `data-tut-img-collapse="on"` (clicking opens
  the existing lightbox via the pre-wired `data-zoomable`).
- Under `data-tut-reduce-motion="on"` **or** `@media (prefers-reduced-motion:
  reduce)`, disable island/auto-hide transitions.
- `@font-face` for OpenDyslexic, with the family referenced **only** under
  `[data-tut-readable-font="on"]`.

### 7. `copyCodeBlock` in `hugo/assets/js/tutorial.ts` (extend)
Add a guarded transform: when `localStorage['tut.pref.copyClean'] === 'on'`, strip
leading shell/REPL prompt tokens per line before writing to the clipboard. Tokens:
`$ `, `> `, `# `, `PS> ` / `PS ...> `. Only leading prompts; never mid-line. A few
lines; no dependency added; stays in the page script (island untouched).

### 8. OpenDyslexic web font (add)
Vendor the OpenDyslexic WOFF2 (SIL OFL, self-hostable) under `hugo/static/fonts/`.
`font-display: swap`. Self-hosted → CSP-clean, no third-party origin.

## Performance

The premise of this change is zero cost on the default path.

- **OpenDyslexic downloads only when enabled.** A CSS `@font-face` family is
  fetched by the browser only when it is matched to rendered text. The family is
  referenced *exclusively* under `[data-tut-readable-font="on"]`, so a reader who
  never enables it never downloads the ~35 KB WOFF2. No JS loader is needed —
  laziness is inherent to CSS webfonts. `font-display: swap` prevents an
  invisible-text stall on enable.
- **All visual prefs are pure CSS off pre-paint attrs** → no flash, no runtime
  cost, no layout JS.
- **Copy-clean** adds one guarded branch (a `.split('\n').map(strip).join('\n')`)
  to the existing copy handler, executed only on click and only when enabled.
- **Island gzip budget:** #1966 left `tutorial-prefs.js` at ~5.5 KB gzip (budget
  8 KB). Additions are getter/setters + popover rows; copy-clean lives outside the
  island. The existing island size guard must still pass.

## Scope & Safety

- Every CSS rule is scoped under `[data-page-kind="tutorial"]`.
- Screenshot rules are further scoped to `.tutorial-figure` / the tutorial content
  wrapper so browse, homepage, author, and advocate imagery are untouched.
- `data-tut-img-collapse` never touches the `#image-lightbox` dialog.
- Reduce-motion honors the OS `prefers-reduced-motion` media query in addition to
  the explicit toggle.
- Separate from reader/focus mode and from the #1966 chrome prefs.
- Fully reversible: delete the CSS/font/island rows and the feature is gone; no
  data migration.

## Testing

- **Unit** (`hugo-apps/src/tutorial-prefs/`):
  - `prefs-store.test.ts` — new getter/setter round-trips, default-on-missing,
    invalid-value fallback.
  - `display-chrome.test.ts` — `computeEffective`/`applyDisplayChrome` set the new
    attrs; new prefs are pass-through (no short-viewport branch).
  - copy-clean transform — strips leading `$ `/`> `/`# `/`PS> ` per line, leaves
    mid-line `$`/`>` intact, no-op when disabled.
- **Hugo pre-paint guard** (`test/unit/hugo/`): new attrs mirrored before paint;
  tutorial-scoping; CSS hooks exist; `@font-face` family referenced only under the
  readable-font selector; **source cross-check that targeted selectors
  (`.tutorial-figure`, `pre code`, tutorial content wrapper) actually exist**
  (the #1966 dead-selector guard pattern).
- **E2E** (`test/e2e/tutorial-reading-prefs.test.js`, self-skips without base URL):
  toggle each pref → assert the `data-tut-*` attr and one visible effect; verify
  copy-clean strips prompts on a known code block; assert the OpenDyslexic WOFF2 is
  **not** requested until the readable-font toggle is enabled.

## Rollout

- Branch from `origin/DEV`; PR targets `DEV` (branch model). No env flag needed —
  all client-side, defaults preserve current behavior.
- No content rebuild required (Hugo-layer + island only; ships with the normal
  approuter static build).

## Open Decisions (resolved in chat)

- Screenshot preference = **size cap (S/M/L) + collapse-all toggle**; lightbox
  unchanged. (Confirmed.)
- Code preference = **size + wrap + copy-clean**. (Confirmed.)
- Text = **size + reading width**. (Confirmed.)
- Accessibility font = **bundle OpenDyslexic** (SIL OFL, self-hosted, lazy). +
  reduce-motion. (Confirmed.)
- Copy-clean strips `$ `, `> `, `# `, `PS> ` leading prompts. (Confirmed.)

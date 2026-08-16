# UI5 code-split — page-type-conditional loading via Vite

**Issue:** [#1777](https://github.com/sap-tutorials/tutorials-ims/issues/1777)
**Date:** 2026-08-14
**Status:** Design approved — pending spec review → implementation plan

## Problem

`ui5-bootstrap.ts` is built by Hugo `js.Build` and loaded on **every** page
(`hugo/layouts/_default/baseof.html:66`). It eagerly registers all ~37 UI5 web
components + ~50 icons + illustrations. Lighthouse (DEV) reports **~362 KiB /
~250–360 ms of unused JavaScript** on the homepage and navigator — most of it
UI5 components that page never renders (Wizard, Timeline, quiz controls,
illustrations, …). The bundle-size trim (#1770) already cut transfer 79%, but the
*execution* cost of registering everything up front remains, and most of it is
dead weight per page.

## Why a Vite migration is the foundation (not optional)

Today there is exactly **one** UI5 copy: the Hugo bootstrap registers all
components globally, and the Vite islands deliberately do **not** import UI5 —
that is the `feedback_ui5_duplicate_bundle_kills_settheme` constraint (two UI5
copies = two `Theme` instances = the dark-on-dark bug PR #575/#627 fought).

Hugo `js.Build` **cannot code-split**: esbuild inlines dynamic `import()` unless
`splitting:true`, which Hugo does not enable/expose. Any design that keeps an
eager UI5 core in Hugo `js.Build` *and* loads more UI5 elsewhere produces a
second `Theme` instance. Therefore, to split UI5 **while preserving the
single-copy invariant**, the whole bootstrap must move into **Vite** (Rollup),
which dedupes shared modules into common chunks. This migration is the
non-optional foundation; everything else builds on it.

## Chosen approach: Hugo page-type-conditional entries (Approach A)

Hugo knows the page type at build time, so it emits only the UI5 entries a page
needs — no runtime gating. (Approach B, runtime DOM-presence dynamic import, and
Approach C, coarse two-bundle, were considered and rejected: B adds runtime
logic + a post-core round-trip + cloak-timing interaction for marginal benefit
given our well-defined mapping; C still ships every component, just deferred.)

### Entries (`hugo-apps/src/ui5/`)

| Entry | Loaded on | Registers |
|---|---|---|
| `ui5-core` | **every page** | ShellBar/ShellBarItem, Avatar, Popover, Button, Input, List/ListItemStandard, Switch, Title, MessageStrip, Toast, ~30 chrome/nav/verb icons, theming-only Assets (#1770 — no CLDR), `setTheme` race handling + MutationObserver, and chrome local modules: nav-progress, view-transitions, recommend |
| `ui5-tutorial` | `.Type == "tutorials"` | Wizard/WizardStep, SegmentedButton/Item (OS-picker), TabContainer/Tab, ProgressIndicator, quiz (RadioButton, CheckBox, RatingIndicator, TextArea), lightbox (Dialog, BusyIndicator) + lightbox icons, SideNavigation/Item/SubItem (mission side-nav); tutorial local modules: codetabs, os-toggle, glossary, reading-progress, lightbox, mission-side-nav |
| `ui5-me` | `.Type == "me"` | Panel, Select/Option, Label, Text, Timeline/TimelineItem |
| `ui5-illustrations` | error templates (403/404/502) + browse | IllustratedMessage + illustration set (PageNotFound, NoData, NoFilterResults, tnt/Lock, UnableToLoad) |

Notes:
- SideNavigation folds into `ui5-tutorial` — the `mission-side-nav.html` partial
  renders only inside `tutorials/u1-object-page.html` and `tutorials/single.html`,
  not a separate missions page.
- `NotificationListItem` + `NoNotifications` illustration belong to the global
  **alerts** island (loaded on every non-preview/non-qa page), so they stay with
  the alerts island / `ui5-core` path, not `ui5-illustrations`.
- The exact component/icon partition between `ui5-core` and the feature entries
  is finalized during implementation and **enforced by the coverage guard below**
  — the table is the intent, the guard is the contract.

### Single UI5 copy

Add `build.rollupOptions.output.manualChunks` to `hugo-apps/vite.config.ts`
forcing `@ui5/webcomponents-base` (the `Theme` singleton) into one shared
`ui5-vendor` chunk that every UI5 entry references. Because there is then one
`Theme` instance, the `feedback_ui5_duplicate_bundle_kills_settheme` rule is
**lifted**: islands (me, validation, code-check) may now import their own UI5
components directly instead of relying on global registration.

A **single-copy build assertion** (CI-gating) verifies exactly one
`@ui5/webcomponents-base` `Theme` module is emitted across all chunks; a future
change that splits it fails the build.

### Hugo loading (feature-flagged)

`baseof.html` gains a block gated on `site.Params.ui5Split`:

- **ON** → emit `<script type="module" src="{{ partial "island-src.html" "ui5-core" }}">`
  on every page, plus the page-type entries by `.Type`/`.IsHome`/`.Layout`.
  Respects `previewMode` (skip all UI5 entries in preview, exactly as today skips
  `ui5-bootstrap`).
- **OFF** → the current `resources.Get "js/ui5-bootstrap.ts" | js.Build …` line,
  unchanged.

Error templates (403/404/502) are special-rendered in Hugo and bypass the normal
baseof block, so they reference `ui5-core` + `ui5-illustrations` explicitly.

Both paths bake into every build. Flip the flag per env (DEV → verify → PROD).
After PROD bakes, delete the OFF path and `ui5-bootstrap.ts`.

## The coverage guard (safety net — load-bearing for Approach A)

The split-boundary components spread across more page types than clean buckets
(illustrations on error **and** browse; SideNavigation via a tutorial partial;
TabContainer via the codetabs shortcode). A mis-mapped component renders as an
un-upgraded raw element in production. To make the mapping safe to maintain:

A new build-time check `scripts/check-ui5-entry-coverage.ts` (sibling to
`scripts/check-icon-imports.ts`, wired into the same `postbuild:apps` /
`build:all` guard set):

1. For each entry, statically collect the `<ui5-*>` custom elements it
   (transitively) registers (parse the `@ui5/.../dist/<Component>.js` imports and
   map to tag names).
2. For each Hugo layout / shortcode / Vue island, collect the `<ui5-*>` elements
   it renders.
3. Map each layout to the entries its page type loads (mirrors the baseof
   conditions — single source of truth shared with the loader).
4. **Assert** every `<ui5-*>` a page type can render is registered by an entry
   that page loads. Any gap **fails the build**.

This directly mirrors how `check-icon-imports` already guards icon registrations,
and it is what lets the page-type mapping evolve safely.

## Invariants preserved

- **Single UI5 copy** — shared `ui5-vendor` chunk + build assertion (above).
- **Theme race** — `setTheme`-on-every-tick + MutationObserver live in `ui5-core`
  (eager, first, every page). One shared `Theme` instance + UI5's retroactive,
  idempotent `setTheme` means feature entries registering components later still
  paint in the correct theme.
- **#1688 FOUCE cloak** — entries load as normal deferred module scripts (not
  runtime dynamic imports), so they load promptly like today's single bootstrap;
  each element un-cloaks (`:not(:defined)` stops matching) when its entry defines
  it, well within the 8s escape-hatch. `data-ui5-cloak` is still set pre-paint
  only when UI5 will load (non-preview).
- **Fingerprint + retention** — new entries emit as Vite hashed chunks →
  `build:island-manifest` indexes them → `island-src.html` resolves them →
  `retain-asset-bundles` already matches hashed `.js`. No regex/retention change.
- **check-icon-imports** — still walks `hugo/assets/js/**` + `hugo-apps/src/**`,
  so icon imports spread across entries are still counted; no change needed.

## Testing

- **Build (CI-gating):** the coverage guard + the single-copy assertion.
- **Runtime (Playwright, per page type — homepage, tutorial *with*
  quiz/wizard/OS-picker/lightbox, /me, error, browse):** every `<ui5-*>` upgrades
  (`:defined`), both light + dark themes apply, `data-ui5-cloak` clears, zero
  UI5/theme/console errors.
- **Bundle deltas:** homepage loads `ui5-core` only (measurably less UI5 than
  today's monolith); tutorial = core + tutorial. Capture before/after transfer.
- **Regression:** existing FOUCE-cloak e2e (`test/e2e/tutorial-fouce-cloak.test.js`)
  + smoke suite pass with the flag ON.

## Rollout

1. Land behind `site.Params.ui5Split=false` (OFF) — both paths baked, no behavior
   change.
2. Flip ON on DEV; run the per-page-type Playwright verification + bundle deltas.
3. Flip ON on PROD after DEV bakes.
4. Follow-up PR: remove the OFF path, `ui5-bootstrap.ts`, and the flag.

## Done criteria (this effort)

- Flag ON on DEV; all page types verified (elements upgrade, both themes, no
  regressions).
- Homepage UI5 transfer measurably reduced (core-only; no tutorial/me/illustration
  components).
- Coverage guard + single-copy assertion green in CI.
- PROD flip + old-path/flag deletion tracked as a follow-up (not in this effort).

## Out of scope

- Removing the `ui5-bootstrap.ts` OFF path (follow-up after PROD bake).
- Subsetting the fundamental-styles icon CSS / unused-CSS purge (issue #1779).
- The TrustArc-LCP ceiling (issue #1778).

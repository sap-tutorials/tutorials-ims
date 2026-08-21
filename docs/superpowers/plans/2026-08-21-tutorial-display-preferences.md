# Tutorial Display Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tutorial-detail readers reclaim vertical space via a "Display" section in the existing Tutorial-preferences popover (header locked/compact/auto-hide, footer auto-hide, hide breadcrumbs/feedback), auto-applying compact defaults on short viewports (incl. high-scale laptops).

**Architecture:** Extend the existing `tutorial-prefs` Vue island. Preferences persist as individual `tut.pref.*` localStorage keys via `prefs-store.ts`. A pre-paint snippet in `head.html` and a new `display-chrome.ts` compute **effective** header/footer modes (explicit pref, else viewport-height-derived) and set `data-tut-*` attributes on `<html>`; a scoped CSS block in `ui5-overrides.css` keys off those attributes. Auto-hide scroll/hover behavior and the `matchMedia('(max-height:900px)')` threshold live in JS (single source of truth — no CSS media query).

**Tech Stack:** Hugo templates, Vue 3 + UI5 Web Components (`@ui5/webcomponents`), TypeScript, Vitest (unit: `happy-dom`; e2e: Playwright via `test/e2e/_browser.js`).

**Spec:** `docs/superpowers/specs/2026-08-21-tutorial-display-preferences-design.md`

## Global Constraints

- **Scope: tutorial detail page only** (`data-page-kind="tutorial"`, i.e. Hugo `.Type == "tutorials"`). No other page type may change behavior. The Display popover section gates on `onTutorialPage`; the auto-hide handlers install only when `onTutorial`.
- **Persistence: localStorage only** (per-device). No CAP/server. Keys use the existing `tut.pref.*` convention.
- **Island gzip budget:** `tutorial-prefs.js` must stay **≤ 8192 bytes gzipped** (`MAX_TUTORIAL_PREFS_GZIP`, `hugo-apps/vite.config.ts`). The Vite build **errors** past it. Keep `display-chrome.ts` lean; if it trips the budget, `await import()` it lazily from `main.ts` like the camera modules.
- **No-flash:** explicit header/footer prefs must be applied by the `head.html` pre-paint snippet (before first paint), mirroring the existing `reader`/`embed` pre-paint. Guard with `{{ if not site.Params.previewMode }}`.
- **Threshold:** `SHORT_VIEWPORT_MAX_HEIGHT = 900` (CSS px) defined in `constants.ts`; the inline pre-paint snippet hardcodes `900` with a comment referencing the constant (it cannot import — documented duplication, same as the embed allowlist).
- **Reduced motion:** auto-hide transitions must be suppressed under `prefers-reduced-motion: reduce` (mirror the reader-mode block in `ui5-overrides.css`).
- **`prefers-reduced-motion` + reader coexistence:** where reader mode already hides `.breadcrumbs`/`.feedback-share`/`footer` with `!important`, that wins — do not fight it.
- **Test commands** (run from repo root):
  - Island unit tests: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/<file>.test.ts`
  - Hugo template unit tests: `npx vitest run --project unit test/unit/hugo/<file>.test.ts`
  - E2E (self-skips without base URL): `npx vitest run test/e2e/<file>.test.js`
- **Commit cadence:** commit after each task's tests pass. Branch: `worktree-tutorial-display-prefs-1966`.

---

## File Structure

- `hugo-apps/src/tutorial-prefs/constants.ts` *(modify)* — keys, threshold, types.
- `hugo-apps/src/tutorial-prefs/prefs-store.ts` *(modify)* — typed get/set for display prefs.
- `hugo-apps/src/tutorial-prefs/display-chrome.ts` *(create)* — effective-mode computation, attribute apply, auto-hide install.
- `hugo-apps/src/tutorial-prefs/display-chrome.test.ts` *(create)* — unit tests for the pure + apply logic.
- `hugo-apps/src/tutorial-prefs/prefs-store.test.ts` *(modify)* — add display-pref round-trip tests.
- `hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue` *(modify)* — Display section + props/emits.
- `hugo-apps/src/tutorial-prefs/main.ts` *(modify)* — reactive state, wiring, init call.
- `hugo/layouts/partials/head.html` *(modify)* — pre-paint block.
- `hugo/assets/css/ui5-overrides.css` *(modify)* — tutorial-scoped display cascade.
- `test/unit/hugo/tutorial-display-prefs-prepaint.test.ts` *(create)* — asserts pre-paint + CSS presence.
- `test/e2e/tutorial-display-prefs.test.js` *(create)* — real-browser toggle + short-viewport auto path.

---

### Task 1: Constants + types

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/constants.ts`

**Interfaces:**
- Produces: `KEY_PREF_HEADER`, `KEY_PREF_FOOTER`, `KEY_PREF_BREADCRUMBS`, `KEY_PREF_FEEDBACK` (string consts); `SHORT_VIEWPORT_MAX_HEIGHT = 900`; types `HeaderMode = 'locked' | 'thinbar' | 'autohide'`, `FooterMode = 'shown' | 'autohide'`, `OnOff = 'on' | 'off'`.

- [ ] **Step 1: Add constants and types**

Append to `hugo-apps/src/tutorial-prefs/constants.ts`:

```ts
// Display-chrome preferences (#1966). Individual keys mirror the tut.pref.* convention.
export const KEY_PREF_HEADER = 'tut.pref.header';
export const KEY_PREF_FOOTER = 'tut.pref.footer';
export const KEY_PREF_BREADCRUMBS = 'tut.pref.breadcrumbs';
export const KEY_PREF_FEEDBACK = 'tut.pref.feedback';

// Below this CSS-px viewport height, header→thinbar + footer→autohide by default
// (unless the user set an explicit pref). CSS px shrink under OS scaling / browser
// zoom, so high-DPI laptops cross this automatically. Mirrored (with a comment) in
// the head.html pre-paint snippet, which cannot import this module.
export const SHORT_VIEWPORT_MAX_HEIGHT = 900;

export type HeaderMode = 'locked' | 'thinbar' | 'autohide';
export type FooterMode = 'shown' | 'autohide';
export type OnOff = 'on' | 'off';
```

- [ ] **Step 2: Typecheck**

Run: `cd hugo-apps && npx tsc --noEmit -p tsconfig.json` (or `npm run -s typecheck` if present)
Expected: no new errors referencing `constants.ts`.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/constants.ts
git commit -m "feat(display-prefs): add constants + types for tutorial display prefs (#1966)"
```

---

### Task 2: prefs-store display getters/setters

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/prefs-store.ts`
- Test: `hugo-apps/src/tutorial-prefs/prefs-store.test.ts`

**Interfaces:**
- Consumes: keys + types from Task 1.
- Produces:
  - `getHeaderPref(): HeaderMode | null` (null = unset/explicit-absent; invalid stored value → null)
  - `setHeaderPref(v: HeaderMode): void`
  - `getFooterPref(): FooterMode | null`
  - `setFooterPref(v: FooterMode): void`
  - `getBreadcrumbsPref(): OnOff` (default `'on'`)
  - `setBreadcrumbsPref(v: OnOff): void`
  - `getFeedbackPref(): OnOff` (default `'on'`)
  - `setFeedbackPref(v: OnOff): void`

- [ ] **Step 1: Write the failing tests**

Append to `hugo-apps/src/tutorial-prefs/prefs-store.test.ts` (inside the existing top-level `describe`, or a new `describe`):

```ts
import {
  getHeaderPref, setHeaderPref, getFooterPref, setFooterPref,
  getBreadcrumbsPref, setBreadcrumbsPref, getFeedbackPref, setFeedbackPref
} from './prefs-store';

describe('prefs-store — display prefs (#1966)', () => {
  beforeEach(() => { localStorage.clear(); });

  it('header/footer default to null (unset) and round-trip', () => {
    expect(getHeaderPref()).toBeNull();
    expect(getFooterPref()).toBeNull();
    setHeaderPref('thinbar');
    setFooterPref('autohide');
    expect(getHeaderPref()).toBe('thinbar');
    expect(getFooterPref()).toBe('autohide');
  });

  it('header ignores invalid stored values', () => {
    localStorage.setItem('tut.pref.header', 'bogus');
    expect(getHeaderPref()).toBeNull();
  });

  it('breadcrumbs/feedback default to "on" and round-trip', () => {
    expect(getBreadcrumbsPref()).toBe('on');
    expect(getFeedbackPref()).toBe('on');
    setBreadcrumbsPref('off');
    setFeedbackPref('off');
    expect(getBreadcrumbsPref()).toBe('off');
    expect(getFeedbackPref()).toBe('off');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/prefs-store.test.ts`
Expected: FAIL — `getHeaderPref` etc. not exported.

- [ ] **Step 3: Implement**

Append to `hugo-apps/src/tutorial-prefs/prefs-store.ts` (import the new consts/types at top):

```ts
import {
  KEY_PREF_HEADER, KEY_PREF_FOOTER, KEY_PREF_BREADCRUMBS, KEY_PREF_FEEDBACK,
  type HeaderMode, type FooterMode, type OnOff
} from './constants';

const HEADER_MODES: HeaderMode[] = ['locked', 'thinbar', 'autohide'];
const FOOTER_MODES: FooterMode[] = ['shown', 'autohide'];

export function getHeaderPref(): HeaderMode | null {
  const v = safeLocal()?.getItem(KEY_PREF_HEADER);
  return (v && (HEADER_MODES as string[]).includes(v)) ? (v as HeaderMode) : null;
}
export function setHeaderPref(v: HeaderMode): void { safeSet(safeLocal(), KEY_PREF_HEADER, v); }

export function getFooterPref(): FooterMode | null {
  const v = safeLocal()?.getItem(KEY_PREF_FOOTER);
  return (v && (FOOTER_MODES as string[]).includes(v)) ? (v as FooterMode) : null;
}
export function setFooterPref(v: FooterMode): void { safeSet(safeLocal(), KEY_PREF_FOOTER, v); }

export function getBreadcrumbsPref(): OnOff { return safeLocal()?.getItem(KEY_PREF_BREADCRUMBS) === 'off' ? 'off' : 'on'; }
export function setBreadcrumbsPref(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_BREADCRUMBS, v); }

export function getFeedbackPref(): OnOff { return safeLocal()?.getItem(KEY_PREF_FEEDBACK) === 'off' ? 'off' : 'on'; }
export function setFeedbackPref(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_FEEDBACK, v); }
```

> Note: `safeLocal` / `safeSet` are existing module-private helpers — reuse them (do not redeclare).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/prefs-store.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/prefs-store.ts hugo-apps/src/tutorial-prefs/prefs-store.test.ts
git commit -m "feat(display-prefs): store getters/setters for display prefs (#1966)"
```

---

### Task 3: display-chrome — effective modes + attribute apply

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/display-chrome.ts`
- Test: `hugo-apps/src/tutorial-prefs/display-chrome.test.ts`

**Interfaces:**
- Consumes: prefs-store getters (Task 2), `HeaderMode`/`FooterMode`/`OnOff` + `SHORT_VIEWPORT_MAX_HEIGHT` (Task 1).
- Produces:
  - `interface DisplayPrefs { header: HeaderMode | null; footer: FooterMode | null; breadcrumbs: OnOff; feedback: OnOff; }`
  - `interface Effective { header: HeaderMode; footer: FooterMode; breadcrumbs: OnOff; feedback: OnOff; }`
  - `computeEffective(prefs: DisplayPrefs, shortViewport: boolean): Effective` — pure. header: pref ?? (short ? 'thinbar' : 'locked'); footer: pref ?? (short ? 'autohide' : 'shown'); breadcrumbs/feedback pass through.
  - `readPrefs(): DisplayPrefs` — reads all four via prefs-store.
  - `isShortViewport(): boolean` — `matchMedia('(max-height: 900px)').matches` (guarded).
  - `applyDisplayChrome(doc?: Document): void` — computes effective from `readPrefs()` + `isShortViewport()` and sets `data-tut-header`, `data-tut-footer`, `data-tut-breadcrumbs`, `data-tut-feedback` on `<html>`.

- [ ] **Step 1: Write the failing tests**

Create `hugo-apps/src/tutorial-prefs/display-chrome.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { computeEffective, applyDisplayChrome, type DisplayPrefs } from './display-chrome';

const NONE: DisplayPrefs = { header: null, footer: null, breadcrumbs: 'on', feedback: 'on' };

describe('computeEffective (#1966)', () => {
  it('tall viewport, no prefs → locked/shown', () => {
    expect(computeEffective(NONE, false)).toEqual({ header: 'locked', footer: 'shown', breadcrumbs: 'on', feedback: 'on' });
  });
  it('short viewport, no prefs → thinbar/autohide', () => {
    expect(computeEffective(NONE, true)).toEqual({ header: 'thinbar', footer: 'autohide', breadcrumbs: 'on', feedback: 'on' });
  });
  it('explicit prefs override the short-viewport default', () => {
    const e = computeEffective({ header: 'locked', footer: 'shown', breadcrumbs: 'off', feedback: 'off' }, true);
    expect(e).toEqual({ header: 'locked', footer: 'shown', breadcrumbs: 'off', feedback: 'off' });
  });
});

describe('applyDisplayChrome (#1966)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-tut-header');
    document.documentElement.removeAttribute('data-tut-footer');
  });
  it('writes effective attributes from stored prefs', () => {
    localStorage.setItem('tut.pref.header', 'autohide');
    localStorage.setItem('tut.pref.breadcrumbs', 'off');
    applyDisplayChrome(document);
    const html = document.documentElement;
    expect(html.getAttribute('data-tut-header')).toBe('autohide');
    expect(html.getAttribute('data-tut-breadcrumbs')).toBe('off');
    // footer unset + happy-dom viewport not short → 'shown'
    expect(html.getAttribute('data-tut-footer')).toBe('shown');
    expect(html.getAttribute('data-tut-feedback')).toBe('on');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/display-chrome.test.ts`
Expected: FAIL — module `./display-chrome` not found.

- [ ] **Step 3: Implement `display-chrome.ts` (compute + apply only; auto-hide added in Task 4)**

Create `hugo-apps/src/tutorial-prefs/display-chrome.ts`:

```ts
import {
  getHeaderPref, getFooterPref, getBreadcrumbsPref, getFeedbackPref
} from './prefs-store';
import {
  SHORT_VIEWPORT_MAX_HEIGHT, type HeaderMode, type FooterMode, type OnOff
} from './constants';

export interface DisplayPrefs {
  header: HeaderMode | null;
  footer: FooterMode | null;
  breadcrumbs: OnOff;
  feedback: OnOff;
}
export interface Effective {
  header: HeaderMode;
  footer: FooterMode;
  breadcrumbs: OnOff;
  feedback: OnOff;
}

export function computeEffective(prefs: DisplayPrefs, shortViewport: boolean): Effective {
  return {
    header: prefs.header ?? (shortViewport ? 'thinbar' : 'locked'),
    footer: prefs.footer ?? (shortViewport ? 'autohide' : 'shown'),
    breadcrumbs: prefs.breadcrumbs,
    feedback: prefs.feedback
  };
}

export function readPrefs(): DisplayPrefs {
  return {
    header: getHeaderPref(),
    footer: getFooterPref(),
    breadcrumbs: getBreadcrumbsPref(),
    feedback: getFeedbackPref()
  };
}

export function isShortViewport(): boolean {
  try {
    return typeof matchMedia === 'function'
      && matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`).matches;
  } catch { return false; }
}

export function applyDisplayChrome(doc: Document = document): void {
  const eff = computeEffective(readPrefs(), isShortViewport());
  const html = doc.documentElement;
  html.setAttribute('data-tut-header', eff.header);
  html.setAttribute('data-tut-footer', eff.footer);
  html.setAttribute('data-tut-breadcrumbs', eff.breadcrumbs);
  html.setAttribute('data-tut-feedback', eff.feedback);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/display-chrome.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/display-chrome.ts hugo-apps/src/tutorial-prefs/display-chrome.test.ts
git commit -m "feat(display-prefs): compute + apply effective display-chrome attributes (#1966)"
```

---

### Task 4: display-chrome — auto-hide handlers + live re-apply

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/display-chrome.ts`
- Test: `hugo-apps/src/tutorial-prefs/display-chrome.test.ts`

**Interfaces:**
- Consumes: `applyDisplayChrome`, `readPrefs`, `isShortViewport`, `computeEffective` (Task 3).
- Produces:
  - `installAutoHide(doc?: Document): () => void` — attaches: (a) a `scroll` listener that toggles `data-tut-header-hidden` on `<html>` when the effective header is `autohide` (hidden on scroll-down past a small threshold, shown on scroll-up or near top); (b) a `matchMedia('(max-height:900px)')` `change` listener that calls `applyDisplayChrome()`. Returns a teardown fn that removes all listeners. Idempotent-safe to call once from `init()`.
  - Footer reveal is CSS `:hover` on a bottom hotspot (Task 6 CSS) — no JS needed beyond the attribute already set by `applyDisplayChrome`. `installAutoHide` does not manage footer hover.

- [ ] **Step 1: Write the failing test**

Append to `hugo-apps/src/tutorial-prefs/display-chrome.test.ts`:

```ts
import { installAutoHide } from './display-chrome';

describe('installAutoHide (#1966)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-tut-header-hidden');
  });

  it('returns a teardown function and does not throw', () => {
    localStorage.setItem('tut.pref.header', 'autohide');
    applyDisplayChrome(document);
    const teardown = installAutoHide(document);
    expect(typeof teardown).toBe('function');
    // Simulate a downward scroll; header-hidden should be set for autohide mode.
    Object.defineProperty(window, 'scrollY', { value: 400, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.getAttribute('data-tut-header-hidden')).toBe('');
    // Scroll back to top → shown.
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.hasAttribute('data-tut-header-hidden')).toBe(false);
    teardown();
  });

  it('does not hide the header when effective header is not autohide', () => {
    // no pref, tall viewport → locked
    applyDisplayChrome(document);
    const teardown = installAutoHide(document);
    Object.defineProperty(window, 'scrollY', { value: 400, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.hasAttribute('data-tut-header-hidden')).toBe(false);
    teardown();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/display-chrome.test.ts`
Expected: FAIL — `installAutoHide` not exported.

- [ ] **Step 3: Implement**

Append to `hugo-apps/src/tutorial-prefs/display-chrome.ts`:

```ts
export function installAutoHide(doc: Document = document): () => void {
  const html = doc.documentElement;
  let lastY = typeof window !== 'undefined' ? window.scrollY : 0;
  const HIDE_AFTER = 80; // px scrolled before hiding

  const onScroll = () => {
    if (html.getAttribute('data-tut-header') !== 'autohide') {
      html.removeAttribute('data-tut-header-hidden');
      return;
    }
    const y = window.scrollY;
    if (y <= HIDE_AFTER) {
      html.removeAttribute('data-tut-header-hidden');       // near top → always show
    } else if (y > lastY) {
      html.setAttribute('data-tut-header-hidden', '');      // scrolling down → hide
    } else if (y < lastY) {
      html.removeAttribute('data-tut-header-hidden');       // scrolling up → show
    }
    lastY = y;
  };

  const mql = (typeof matchMedia === 'function')
    ? matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`) : null;
  const onMedia = () => applyDisplayChrome(doc);

  window.addEventListener('scroll', onScroll, { passive: true });
  mql?.addEventListener?.('change', onMedia);

  return () => {
    window.removeEventListener('scroll', onScroll);
    mql?.removeEventListener?.('change', onMedia);
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/display-chrome.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/display-chrome.ts hugo-apps/src/tutorial-prefs/display-chrome.test.ts
git commit -m "feat(display-prefs): auto-hide header scroll handler + live threshold re-apply (#1966)"
```

---

### Task 5: Popover "Display" section + main.ts wiring

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue`
- Modify: `hugo-apps/src/tutorial-prefs/main.ts`

**Interfaces:**
- Consumes: `readPrefs`, `applyDisplayChrome`, `installAutoHide` (Tasks 3-4); `setHeaderPref`, `setFooterPref`, `setBreadcrumbsPref`, `setFeedbackPref` (Task 2); `HeaderMode`/`FooterMode`/`OnOff` (Task 1); `PAGE_KIND_TUTORIAL` (existing).
- Produces (popover props): `headerMode: HeaderMode`, `footerAutohide: boolean`, `breadcrumbsOn: boolean`, `feedbackOn: boolean`. Emits: `('set-header', HeaderMode)`, `('toggle-footer')`, `('toggle-breadcrumbs')`, `('toggle-feedback')`.

- [ ] **Step 1: Add the Display section to `TutorialPrefsPopover.vue`**

In the template, inside `<template v-if="onTutorialPage">`, **above** the `Experimental` group label, insert:

```html
        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Display</p>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Header</span></label>
          <ui5-segmented-button @selection-change="onHeaderSelect">
            <ui5-segmented-button-item :pressed="headerMode === 'locked' || undefined" data-mode="locked">Locked</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="headerMode === 'thinbar' || undefined" data-mode="thinbar">Compact</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="headerMode === 'autohide' || undefined" data-mode="autohide">Auto-hide</ui5-segmented-button-item>
          </ui5-segmented-button>
          <p class="tut-prefs__desc">Reduce the space the sticky title bar uses while you read.</p>
        </section>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Auto-hide footer</span>
            <ui5-switch :checked="footerAutohide || undefined" @change="$emit('toggle-footer')"></ui5-switch>
          </label>
        </section>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Show breadcrumbs</span>
            <ui5-switch :checked="breadcrumbsOn || undefined" @change="$emit('toggle-breadcrumbs')"></ui5-switch>
          </label>
        </section>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Show feedback bar</span>
            <ui5-switch :checked="feedbackOn || undefined" @change="$emit('toggle-feedback')"></ui5-switch>
          </label>
        </section>
```

> `:checked="x || undefined"` is the mandatory UI5 boolean-attr guard — a literal `false` still coerces to checked on presence (memory: `ui5-boolean-attr-coercion`). Same for `:pressed`.

In `<script setup>`, extend `defineProps` with `headerMode: HeaderMode; footerAutohide: boolean; breadcrumbsOn: boolean; feedbackOn: boolean;` (import `HeaderMode` from `./constants`), extend `defineEmits` with the four new events, and add the segmented-button handler:

```ts
function onHeaderSelect(e: any) {
  const mode = e.detail?.selectedItems?.[0]?.dataset?.mode
    ?? e.target?.querySelector('[pressed]')?.dataset?.mode;
  if (mode) emit('set-header', mode as HeaderMode);
}
```

> Adjust `onHeaderSelect` to the installed `@ui5/webcomponents` version's `selection-change` payload — verify the event's `detail` shape with `get_api_reference` for `sap.ui.webc.main.SegmentedButton` if `selectedItems` is absent; the `[pressed]` fallback covers it either way.

- [ ] **Step 2: Register the segmented-button element (if not already global)**

Check whether `@ui5/webcomponents/dist/SegmentedButton.js` + `SegmentedButtonItem.js` are already imported by the island's bootstrap. If the popover renders switches but the segmented button stays un-upgraded, add the imports near the top of `main.ts`:

```ts
import '@ui5/webcomponents/dist/SegmentedButton.js';
import '@ui5/webcomponents/dist/SegmentedButtonItem.js';
```

- [ ] **Step 3: Wire state + handlers in `main.ts`**

Add to `main.ts`:
- Extend `State` with `headerMode: HeaderMode; footerAutohide: boolean; breadcrumbsOn: boolean; feedbackOn: boolean;`.
- Initialize from effective prefs at `init()`:

```ts
import { readPrefs, applyDisplayChrome, installAutoHide, computeEffective, isShortViewport } from './display-chrome';
import { setHeaderPref, setFooterPref, setBreadcrumbsPref, setFeedbackPref } from './prefs-store';
import type { HeaderMode } from './constants';
// ...inside init(), after `const onTutorial = ...`:
const eff0 = computeEffective(readPrefs(), isShortViewport());
// ...add to reactive state object:
//   headerMode: eff0.header, footerAutohide: eff0.footer === 'autohide',
//   breadcrumbsOn: eff0.breadcrumbs === 'on', feedbackOn: eff0.feedback === 'on',
```

- Add handlers that persist + re-apply + sync state:

```ts
function setHeader(state: State, mode: HeaderMode) {
  setHeaderPref(mode);
  state.headerMode = mode;
  applyDisplayChrome();
}
function toggleFooter(state: State) {
  const next = state.footerAutohide ? 'shown' : 'autohide';
  setFooterPref(next);
  state.footerAutohide = next === 'autohide';
  applyDisplayChrome();
}
function toggleBreadcrumbs(state: State) {
  const next = state.breadcrumbsOn ? 'off' : 'on';
  setBreadcrumbsPref(next);
  state.breadcrumbsOn = next === 'on';
  applyDisplayChrome();
}
function toggleFeedback(state: State) {
  const next = state.feedbackOn ? 'off' : 'on';
  setFeedbackPref(next);
  state.feedbackOn = next === 'on';
  applyDisplayChrome();
}
```

- Pass props + wire emits in the `h(TutorialPrefsPopover, { ... })` call:

```ts
      headerMode: state.headerMode,
      footerAutohide: state.footerAutohide,
      breadcrumbsOn: state.breadcrumbsOn,
      feedbackOn: state.feedbackOn,
      'onSet-header': (m: HeaderMode) => setHeader(state, m),
      'onToggle-footer': () => toggleFooter(state),
      'onToggle-breadcrumbs': () => toggleBreadcrumbs(state),
      'onToggle-feedback': () => toggleFeedback(state),
```

- At the end of `init()`, when `onTutorial`, ensure attributes reflect current prefs and install auto-hide (pre-paint already set them, but this covers the no-pre-paint dev path):

```ts
  if (onTutorial) {
    applyDisplayChrome();
    installAutoHide();
  }
```

- [ ] **Step 4: Typecheck + run island unit tests + build (budget gate)**

Run:
```
cd hugo-apps && npx tsc --noEmit -p tsconfig.json && cd ..
npx vitest run --project unit hugo-apps/src/tutorial-prefs
cd hugo-apps && npm run build
```
Expected: typecheck clean; all island tests PASS; Vite build succeeds **without** the `tutorial-prefs.js is … bytes gzipped (> 8192)` error. If it errors on budget, move `installAutoHide` behind `await import('./display-chrome')` in the `onTutorial` block and re-run.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue hugo-apps/src/tutorial-prefs/main.ts
git commit -m "feat(display-prefs): Display section in tutorial-prefs popover + wiring (#1966)"
```

---

### Task 6: CSS cascade

**Files:**
- Modify: `hugo/assets/css/ui5-overrides.css`

**Interfaces:**
- Consumes: `data-tut-header`, `data-tut-footer`, `data-tut-header-hidden`, `data-tut-breadcrumbs`, `data-tut-feedback` on `<html>` (set by pre-paint / `applyDisplayChrome`).

- [ ] **Step 1: Add the tutorial-scoped display block**

Append to `hugo/assets/css/ui5-overrides.css` (all selectors gated on `[data-page-kind="tutorial"]`):

```css
/* #1966 — tutorial display preferences. Attribute-driven; the effective values
   are computed in display-chrome.ts / head.html pre-paint (JS owns the height
   threshold, so there is no @media query here). Scoped to tutorial pages. */

/* Compact header: keep it sticky but drop description + chip row, tighten padding. */
html[data-tut-header="thinbar"][data-page-kind="tutorial"] .op-header__description,
html[data-tut-header="thinbar"][data-page-kind="tutorial"] .op-header__chips {
  display: none;
}
html[data-tut-header="thinbar"][data-page-kind="tutorial"] .op-header {
  padding-top: 0.5rem;
  padding-bottom: 0.25rem;
}

/* Auto-hide header: stays sticky, slides out of the way when data-tut-header-hidden is set. */
html[data-tut-header="autohide"][data-page-kind="tutorial"] .op-header {
  transition: transform 200ms ease;
  will-change: transform;
}
html[data-tut-header="autohide"][data-tut-header-hidden][data-page-kind="tutorial"] .op-header {
  transform: translateY(-100%);
}

/* Auto-hide footer: park it off the bottom edge; reveal on hover. Taskbar-style —
   content is not padded for it; it overlays on reveal. */
html[data-tut-footer="autohide"][data-page-kind="tutorial"] footer {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  transform: translateY(100%);
  transition: transform 200ms ease;
  z-index: 25;
}
html[data-tut-footer="autohide"][data-page-kind="tutorial"] footer:hover,
html[data-tut-footer="autohide"][data-page-kind="tutorial"] footer:focus-within {
  transform: translateY(0);
}

/* Hide breadcrumbs / feedback bar when turned off. */
html[data-tut-breadcrumbs="off"][data-page-kind="tutorial"] .breadcrumbs { display: none; }
html[data-tut-feedback="off"][data-page-kind="tutorial"] .feedback-share { display: none; }

@media (prefers-reduced-motion: reduce) {
  html[data-tut-header="autohide"][data-page-kind="tutorial"] .op-header,
  html[data-tut-footer="autohide"][data-page-kind="tutorial"] footer { transition: none; }
}
```

> Verify the footer selector: confirm the tutorial footer element is `footer` (via `partial "footer.html"`). If it is wrapped in a class, target that class instead — check `hugo/layouts/partials/footer.html`.

- [ ] **Step 2: Build the site CSS and eyeball the rules landed**

Run (from repo root): `npm run build:css` (or the project's CSS build step — check `jq '.scripts' package.json`).
Expected: build succeeds; grep the built CSS for `data-tut-header` to confirm the rules survived minification:
`grep -c "data-tut-header" hugo/static/css/*.css` → ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/css/ui5-overrides.css
git commit -m "feat(display-prefs): CSS cascade for compact/auto-hide chrome (#1966)"
```

---

### Task 7: head.html pre-paint (no-flash)

**Files:**
- Modify: `hugo/layouts/partials/head.html`

**Interfaces:**
- Produces: on first paint, sets `data-tut-header` / `data-tut-footer` / `data-tut-breadcrumbs` / `data-tut-feedback` on `<html>` from `tut.pref.*` localStorage, computing the same effective values as `display-chrome.ts`.

- [ ] **Step 1: Add the pre-paint block**

In `hugo/layouts/partials/head.html`, inside the existing pre-paint `<script>` (near the `reader`/`embed` blocks), add — guarded by `{{ if not site.Params.previewMode }}`:

```js
  {{ if not site.Params.previewMode }}
  // #1966 display-chrome pre-paint. Mirrors display-chrome.ts computeEffective()
  // so the compact/auto-hide chrome never flashes. Threshold 900 duplicates
  // SHORT_VIEWPORT_MAX_HEIGHT in tutorial-prefs/constants.ts (this inline script
  // cannot import). Tutorial pages only.
  if (document.documentElement.dataset.pageKind === 'tutorial') {
    try {
      var short = matchMedia('(max-height: 900px)').matches;
      var hp = localStorage.getItem('tut.pref.header');
      var fp = localStorage.getItem('tut.pref.footer');
      var header = (hp === 'locked' || hp === 'thinbar' || hp === 'autohide') ? hp : (short ? 'thinbar' : 'locked');
      var footer = (fp === 'shown' || fp === 'autohide') ? fp : (short ? 'autohide' : 'shown');
      var crumbs = localStorage.getItem('tut.pref.breadcrumbs') === 'off' ? 'off' : 'on';
      var fb = localStorage.getItem('tut.pref.feedback') === 'off' ? 'off' : 'on';
      var el = document.documentElement;
      el.dataset.tutHeader = header;
      el.dataset.tutFooter = footer;
      el.dataset.tutBreadcrumbs = crumbs;
      el.dataset.tutFeedback = fb;
    } catch (e) {}
  }
  {{ end }}
```

- [ ] **Step 2: Render the site and confirm no error / attributes present**

Run: `npm run dev` (or `hugo` build) and load a tutorial page; in devtools confirm `<html>` has `data-tut-header="locked"` (default, tall viewport) and no console error. (This step is manual; the automated guard is Task 8.)

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/partials/head.html
git commit -m "feat(display-prefs): pre-paint effective display-chrome attributes (#1966)"
```

---

### Task 8: Hugo template guard test

**Files:**
- Create: `test/unit/hugo/tutorial-display-prefs-prepaint.test.ts`

**Interfaces:**
- Consumes: source files `hugo/layouts/partials/head.html`, `hugo/assets/css/ui5-overrides.css`, `hugo-apps/src/tutorial-prefs/constants.ts`.

- [ ] **Step 1: Write the test**

Create `test/unit/hugo/tutorial-display-prefs-prepaint.test.ts`:

```ts
// test/unit/hugo/tutorial-display-prefs-prepaint.test.ts
// #1966: pin the pre-paint block + CSS hooks + threshold agreement so a future
// edit can't silently drop the no-flash path, the CSS cascade, or let the inline
// pre-paint threshold drift from SHORT_VIEWPORT_MAX_HEIGHT.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const head = readFileSync(path.join(root, 'hugo/layouts/partials/head.html'), 'utf8');
const css = readFileSync(path.join(root, 'hugo/assets/css/ui5-overrides.css'), 'utf8');
const constants = readFileSync(path.join(root, 'hugo-apps/src/tutorial-prefs/constants.ts'), 'utf8');

describe('tutorial display-prefs pre-paint (#1966)', () => {
  it('pre-paint sets all four data-tut-* attributes', () => {
    expect(head).toContain('tutHeader');
    expect(head).toContain('tutFooter');
    expect(head).toContain('tutBreadcrumbs');
    expect(head).toContain('tutFeedback');
  });

  it('pre-paint is gated to tutorial pages', () => {
    expect(head).toMatch(/pageKind === 'tutorial'[\s\S]*tutHeader/);
  });

  it('inline pre-paint threshold matches SHORT_VIEWPORT_MAX_HEIGHT', () => {
    const m = constants.match(/SHORT_VIEWPORT_MAX_HEIGHT\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    const threshold = m![1];
    expect(head).toContain(`max-height: ${threshold}px`);
  });

  it('CSS defines the four attribute hooks, all tutorial-scoped', () => {
    for (const hook of ['data-tut-header="thinbar"', 'data-tut-header="autohide"',
                        'data-tut-footer="autohide"', 'data-tut-breadcrumbs="off"',
                        'data-tut-feedback="off"']) {
      expect(css, hook).toContain(hook);
    }
    // every new rule is scoped to the tutorial page kind
    const lines = css.split('\n').filter(l => l.includes('data-tut-'));
    for (const l of lines) {
      if (l.trim().startsWith('html[data-tut-')) {
        expect(l, l).toContain('[data-page-kind="tutorial"]');
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify it passes (implementation already landed in Tasks 6-7)**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-display-prefs-prepaint.test.ts`
Expected: PASS. If the scoping assertion fails, fix the offending CSS selector in `ui5-overrides.css` (every `html[data-tut-*` rule must include `[data-page-kind="tutorial"]`).

- [ ] **Step 3: Commit**

```bash
git add test/unit/hugo/tutorial-display-prefs-prepaint.test.ts
git commit -m "test(display-prefs): guard pre-paint + CSS hooks + threshold agreement (#1966)"
```

---

### Task 9: E2E spec (post-deploy, self-skipping)

**Files:**
- Create: `test/e2e/tutorial-display-prefs.test.js`

**Interfaces:**
- Consumes: `test/e2e/e2e.config.js` (`hasBaseUrl`), `test/e2e/_browser.js` (`launchBrowser`, `newPage`). A deployed tutorial URL — reuse whatever path existing e2e specs hit (a known tutorial slug); pick one from an existing spec to avoid guessing.

- [ ] **Step 1: Write the spec**

Create `test/e2e/tutorial-display-prefs.test.js`:

```js
// e2e: tutorial display preferences (#1966).
//
// Drives the real popover + localStorage path against a deployed tutorial page:
//  - toggling the header to "Compact" hides the description/chip row and sets
//    data-tut-header="thinbar"
//  - a short viewport (height < 900) with no explicit pref auto-applies thinbar
//  - an explicit "Locked" pref overrides the short-viewport default
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so `npm test`
// (unit suite) is unaffected. Runs anonymously.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, baseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

// Reuse a known-good tutorial slug from an existing e2e/smoke spec rather than guessing.
const TUTORIAL_PATH = '/tutorials/<REPLACE-with-a-slug-used-by-an-existing-spec>/';

describe.skipIf(!hasBaseUrl())('e2e: tutorial display prefs (#1966)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('short viewport auto-applies compact header when no explicit pref', async () => {
    const page = await newPage(browser, { viewport: { width: 1280, height: 700 } });
    await page.addInitScript(() => localStorage.clear());
    await page.goto(baseUrl() + TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });
    const mode = await page.evaluate(() => document.documentElement.getAttribute('data-tut-header'));
    expect(mode).toBe('thinbar');
    await page.close();
  });

  it('explicit Locked pref overrides the short-viewport default', async () => {
    const page = await newPage(browser, { viewport: { width: 1280, height: 700 } });
    await page.addInitScript(() => localStorage.setItem('tut.pref.header', 'locked'));
    await page.goto(baseUrl() + TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });
    const mode = await page.evaluate(() => document.documentElement.getAttribute('data-tut-header'));
    expect(mode).toBe('locked');
    await page.close();
  });

  it('toggling header to Compact hides description + chips', async () => {
    const page = await newPage(browser, { viewport: { width: 1400, height: 1000 } });
    await page.addInitScript(() => localStorage.clear());
    await page.goto(baseUrl() + TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });
    // default tall viewport → locked, chips visible
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-tut-header'))).toBe('locked');
    await page.click('#sb-prefs');
    await page.click('ui5-segmented-button-item[data-mode="thinbar"]');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-tut-header'))).toBe('thinbar');
    const chipsHidden = await page.evaluate(() => {
      const chips = document.querySelector('.op-header__chips');
      return !chips || getComputedStyle(chips).display === 'none';
    });
    expect(chipsHidden).toBe(true);
    await page.close();
  });
});
```

- [ ] **Step 2: Fill in the tutorial slug**

Open an existing spec (e.g. `test/e2e/*.test.js`) or `test/smoke/` to find a stable tutorial slug already used, and replace `<REPLACE-...>`. Confirm `newPage` accepts a `viewport` option (check `_browser.js`); if not, set the viewport with the helper's actual API.

- [ ] **Step 3: Run locally against a base URL (or confirm clean skip)**

Run (skip path): `npx vitest run test/e2e/tutorial-display-prefs.test.js` → Expected: SKIPPED (no base URL).
Run (real, optional): `SMOKE_BASE_URL=https://<dev-approuter> npx vitest run test/e2e/tutorial-display-prefs.test.js` → Expected: PASS (only after the change is deployed to that env).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/tutorial-display-prefs.test.js
git commit -m "test(display-prefs): e2e for compact header + short-viewport auto path (#1966)"
```

---

### Task 10: Full unit suite + lint + island build

**Files:** none (verification task).

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: PASS (no regressions in existing hugo/island tests).

- [ ] **Step 2: Lint / typecheck the island**

Run: `cd hugo-apps && npx tsc --noEmit -p tsconfig.json && npm run build && cd ..`
Expected: clean typecheck; Vite build succeeds under the 8 KB `tutorial-prefs.js` budget.

- [ ] **Step 3: Manual smoke (dev server)**

Run `npm run dev`, open a tutorial page, and verify by hand: popover shows the Display section; each toggle changes the page and persists across reload; resizing the window below ~900px height auto-compacts the header when no explicit pref is set. Confirm no effect on a non-tutorial page (e.g. `/browse/`).

- [ ] **Step 4: Commit (if any fixups)**

```bash
git add -A && git commit -m "chore(display-prefs): suite/lint fixups (#1966)"
```

---

## Self-Review

**Spec coverage:**
- Preference model (individual `tut.pref.*` keys) → Tasks 1-2. ✓
- Effective-mode computation + attribute apply → Task 3. ✓
- Auto-hide header + live threshold re-apply → Task 4. ✓
- Footer auto-hide (CSS hover reveal) → Task 6. ✓
- Breadcrumbs / feedback toggles → Tasks 2, 5, 6. ✓
- Settings surface (Display section in existing popover) → Task 5. ✓
- Short-viewport auto-apply (JS-owned 900px threshold) → Tasks 3, 4, 7. ✓
- No-flash pre-paint → Task 7. ✓
- Tutorial-only scoping → enforced in every task + guarded in Task 8. ✓
- Testing (unit + hugo guard + e2e) → Tasks 2-4, 8, 9. ✓
- Gzip budget → Global Constraints + Tasks 5, 10. ✓

**Type consistency:** `HeaderMode`/`FooterMode`/`OnOff` defined once (Task 1), consumed identically in store (Task 2), display-chrome (Tasks 3-4), popover/main (Task 5). Attribute names (`data-tut-header`, `-footer`, `-breadcrumbs`, `-feedback`, `-header-hidden`) are identical across pre-paint (Task 7), apply (Task 3), auto-hide (Task 4), CSS (Task 6), and the guard test (Task 8). `applyDisplayChrome` / `installAutoHide` / `computeEffective` / `readPrefs` / `isShortViewport` signatures match between definition (Tasks 3-4) and callers (Task 5).

**Placeholder scan:** The only intentional placeholder is the e2e tutorial slug (Task 9 Step 2) — flagged with an explicit fill-in step because a stable slug must come from an existing spec, not be invented.

## Open verification items for the implementer

- Confirm the tutorial footer element/selector in `hugo/layouts/partials/footer.html` before finalizing the Task 6 footer rule.
- Confirm the installed `@ui5/webcomponents` `SegmentedButton` `selection-change` payload shape (Task 5); the `[pressed]` fallback is defensive but verify with `get_api_reference`.
- Confirm `newPage` viewport API in `test/e2e/_browser.js` (Task 9).

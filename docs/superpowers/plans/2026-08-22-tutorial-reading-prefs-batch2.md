# Tutorial Reading Preferences — Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second batch of per-device tutorial reading preferences (text size, reading width, code size/wrap/copy-clean, screenshot size/collapse, reduce-motion, OpenDyslexic font) to the existing `tutorial-prefs` island, applied pre-paint via `data-tut-*` attributes and CSS.

**Architecture:** Extends the #1966 pattern exactly — `tut.pref.*` localStorage → `head.html` pre-paint mirror → `data-tut-*` attrs on `<html>` → CSS in `ui5-overrides.css` keyed off attrs. New prefs are plain pass-through (no short-viewport auto behavior). Copy-clean is a behavioral transform in the page-script copy handler, not the island. OpenDyslexic is a self-hosted `@font-face` that the browser fetches only when the toggle is on.

**Tech Stack:** Vue 3 island (`hugo-apps/src/tutorial-prefs/`), TypeScript, UI5 Web Components (segmented-button, switch), Hugo templates, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-tutorial-reading-prefs-batch2-design.md`

## Global Constraints

- **Branch base:** `origin/DEV`; PR targets `DEV` (branch model — never `main`).
- **Per-device only:** all prefs are `tut.pref.*` localStorage keys via the `safeLocal()` helpers; **no schema/server/content change**. Works for anonymous visitors.
- **Tutorial-scoped:** every CSS rule is prefixed `html[data-tut-...][data-page-kind="tutorial"]`. The pre-paint block runs only under `dataset.pageKind === 'tutorial'`.
- **No flash:** any pref with a visual effect must be mirrored in the `head.html` pre-paint block before first paint. The inline block cannot `import`; mirror constants with a comment (as #1966 does for the 900px threshold).
- **Zero default-path cost:** the OpenDyslexic WOFF2 family is referenced **only** under `[data-tut-readable-font="on"]` so it is never fetched unless enabled. `font-display: swap`.
- **Defaults preserve current behavior:** `imgSize` default `l` (natural), `codeSize`/`textSize` default `m`, all toggles default `off`, `readWidth` default `full`.
- **Reuse existing helpers:** `safeLocal`/`safeSet` in `prefs-store.ts`; `OnOff` type from `constants.ts`; the parent-mediated emit pattern in `main.ts`.
- **Windows/CRLF:** repo is edited on Windows — do not introduce CRLF; match existing LF line endings.
- **Test running:** hugo-apps `.ts`/`.vue` tests run via `npx vitest --project unit` from **repo root**. Hugo guard tests live under `test/unit/hugo/`.

---

## File Structure

- `hugo-apps/src/tutorial-prefs/constants.ts` — MODIFY: 9 new keys, `SizeStep`/`ReadWidth` types.
- `hugo-apps/src/tutorial-prefs/prefs-store.ts` — MODIFY: 9 getter/setter pairs.
- `hugo-apps/src/tutorial-prefs/prefs-store.test.ts` — MODIFY: round-trip + default/invalid tests.
- `hugo-apps/src/tutorial-prefs/display-chrome.ts` — MODIFY: extend `DisplayPrefs`/`Effective`/`readPrefs`/`computeEffective`/`applyDisplayChrome`.
- `hugo-apps/src/tutorial-prefs/display-chrome.test.ts` — MODIFY: assert new attrs, pass-through.
- `hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue` — MODIFY: new Display rows + props/emits.
- `hugo-apps/src/tutorial-prefs/main.ts` — MODIFY: state, handlers, prop/emit wiring.
- `hugo/layouts/partials/head.html` — MODIFY: pre-paint the 6 new attrs.
- `hugo/assets/css/ui5-overrides.css` — MODIFY: attribute-keyed rules + `@font-face`.
- `hugo/assets/js/copy-clean.ts` — CREATE: pure `stripPrompts()` transform.
- `hugo/assets/js/tutorial.ts` — MODIFY: wire copy-clean into `copyCodeBlock`.
- `hugo/assets/js/copy-clean.test.ts` — CREATE: unit tests for `stripPrompts`.
- `hugo/static/fonts/OpenDyslexic-Regular.woff2`, `-Bold.woff2` — CREATE (vendored, SIL OFL).
- `test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts` — CREATE: pre-paint + CSS-hook + dead-selector + lazy-font guards.
- `test/e2e/tutorial-reading-prefs.test.js` — CREATE: behavioral E2E (self-skips w/o base URL).

---

### Task 1: Constants + prefs-store getters/setters

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/constants.ts`
- Modify: `hugo-apps/src/tutorial-prefs/prefs-store.ts`
- Test: `hugo-apps/src/tutorial-prefs/prefs-store.test.ts`

**Interfaces:**
- Consumes: `safeLocal`, `safeSet` (existing in prefs-store), `OnOff` (existing in constants).
- Produces:
  - Constants: `KEY_PREF_TEXT_SIZE`, `KEY_PREF_READ_WIDTH`, `KEY_PREF_CODE_SIZE`, `KEY_PREF_CODE_WRAP`, `KEY_PREF_COPY_CLEAN`, `KEY_PREF_IMG_SIZE`, `KEY_PREF_IMG_COLLAPSE`, `KEY_PREF_REDUCE_MOTION`, `KEY_PREF_READABLE_FONT`; types `SizeStep = 's'|'m'|'l'`, `ReadWidth = 'full'|'narrow'`.
  - prefs-store fns: `getTextSize(): SizeStep` / `setTextSize(v: SizeStep)`, `getReadWidth(): ReadWidth` / `setReadWidth`, `getCodeSize(): SizeStep` / `setCodeSize`, `getCodeWrap(): OnOff` / `setCodeWrap`, `getCopyClean(): OnOff` / `setCopyClean`, `getImgSize(): SizeStep` / `setImgSize`, `getImgCollapse(): OnOff` / `setImgCollapse`, `getReduceMotion(): OnOff` / `setReduceMotion`, `getReadableFont(): OnOff` / `setReadableFont`.
  - Defaults: size→`m`, imgSize→`l`, readWidth→`full`, all OnOff→`off`.

- [ ] **Step 1: Write the failing tests** — append to `prefs-store.test.ts`:

```ts
import {
  getTextSize, setTextSize, getReadWidth, setReadWidth,
  getCodeSize, setCodeSize, getCodeWrap, setCodeWrap,
  getCopyClean, setCopyClean, getImgSize, setImgSize,
  getImgCollapse, setImgCollapse, getReduceMotion, setReduceMotion,
  getReadableFont, setReadableFont
} from './prefs-store';

describe('reading-prefs batch 2 store', () => {
  beforeEach(() => localStorage.clear());

  it('size prefs default correctly and round-trip', () => {
    expect(getTextSize()).toBe('m');
    expect(getCodeSize()).toBe('m');
    expect(getImgSize()).toBe('l'); // natural by default
    setTextSize('l'); setCodeSize('s'); setImgSize('s');
    expect(getTextSize()).toBe('l');
    expect(getCodeSize()).toBe('s');
    expect(getImgSize()).toBe('s');
  });

  it('invalid stored size falls back to default', () => {
    localStorage.setItem('tut.pref.textSize', 'xl');
    expect(getTextSize()).toBe('m');
  });

  it('readWidth defaults full and round-trips', () => {
    expect(getReadWidth()).toBe('full');
    setReadWidth('narrow');
    expect(getReadWidth()).toBe('narrow');
  });

  it('OnOff toggles default off and round-trip', () => {
    for (const [get, set] of [
      [getCodeWrap, setCodeWrap], [getCopyClean, setCopyClean],
      [getImgCollapse, setImgCollapse], [getReduceMotion, setReduceMotion],
      [getReadableFont, setReadableFont]
    ] as const) {
      expect(get()).toBe('off');
      set('on');
      expect(get()).toBe('on');
      localStorage.clear();
    }
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/prefs-store.test.ts`
Expected: FAIL — the new exports are not defined.

- [ ] **Step 3: Add constants** — append to `constants.ts` (after the #1966 block):

```ts
// Reading preferences batch 2 (#1966 follow-up). Same tut.pref.* convention.
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
```

- [ ] **Step 4: Add store functions** — append to `prefs-store.ts`, and extend its import from `./constants` to include the 9 new keys plus `type SizeStep, type ReadWidth`:

```ts
const SIZE_STEPS: SizeStep[] = ['s', 'm', 'l'];
function readSize(key: string): SizeStep {
  const v = safeLocal()?.getItem(key);
  return (v && (SIZE_STEPS as string[]).includes(v)) ? (v as SizeStep) : 'm';
}
function readOnOff(key: string): OnOff { return safeLocal()?.getItem(key) === 'on' ? 'on' : 'off'; }

export function getTextSize(): SizeStep { return readSize(KEY_PREF_TEXT_SIZE); }
export function setTextSize(v: SizeStep): void { safeSet(safeLocal(), KEY_PREF_TEXT_SIZE, v); }

export function getReadWidth(): ReadWidth {
  return safeLocal()?.getItem(KEY_PREF_READ_WIDTH) === 'narrow' ? 'narrow' : 'full';
}
export function setReadWidth(v: ReadWidth): void { safeSet(safeLocal(), KEY_PREF_READ_WIDTH, v); }

export function getCodeSize(): SizeStep { return readSize(KEY_PREF_CODE_SIZE); }
export function setCodeSize(v: SizeStep): void { safeSet(safeLocal(), KEY_PREF_CODE_SIZE, v); }

export function getCodeWrap(): OnOff { return readOnOff(KEY_PREF_CODE_WRAP); }
export function setCodeWrap(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_CODE_WRAP, v); }

export function getCopyClean(): OnOff { return readOnOff(KEY_PREF_COPY_CLEAN); }
export function setCopyClean(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_COPY_CLEAN, v); }

// imgSize defaults to 'l' (natural), so default rendering is unchanged.
export function getImgSize(): SizeStep {
  const v = safeLocal()?.getItem(KEY_PREF_IMG_SIZE);
  return (v === 's' || v === 'm' || v === 'l') ? v : 'l';
}
export function setImgSize(v: SizeStep): void { safeSet(safeLocal(), KEY_PREF_IMG_SIZE, v); }

export function getImgCollapse(): OnOff { return readOnOff(KEY_PREF_IMG_COLLAPSE); }
export function setImgCollapse(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_IMG_COLLAPSE, v); }

export function getReduceMotion(): OnOff { return readOnOff(KEY_PREF_REDUCE_MOTION); }
export function setReduceMotion(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_REDUCE_MOTION, v); }

export function getReadableFont(): OnOff { return readOnOff(KEY_PREF_READABLE_FONT); }
export function setReadableFont(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_READABLE_FONT, v); }
```

Note: the existing import line is `import { KEY_PREF_EYE, ... type OnOff } from './constants';` — add the new symbols to it (do not create a second import statement).

- [ ] **Step 5: Run tests, verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/prefs-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/constants.ts hugo-apps/src/tutorial-prefs/prefs-store.ts hugo-apps/src/tutorial-prefs/prefs-store.test.ts
git commit -m "feat(prefs): reading-prefs batch 2 store keys + getters/setters (#1966)"
```

---

### Task 2: Extend display-chrome to apply new attrs

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/display-chrome.ts`
- Test: `hugo-apps/src/tutorial-prefs/display-chrome.test.ts`

**Interfaces:**
- Consumes: Task 1 getters; existing `computeEffective(prefs, shortViewport)`, `applyDisplayChrome(doc)`.
- Produces: `Effective`/`DisplayPrefs` gain `textSize/readWidth/codeSize/codeWrap/imgSize/imgCollapse/reduceMotion/readableFont`; `applyDisplayChrome` sets `data-tut-text-size`, `data-tut-read-width`, `data-tut-code-size`, `data-tut-code-wrap`, `data-tut-img-size`, `data-tut-img-collapse`, `data-tut-reduce-motion`, `data-tut-readable-font`. New prefs are pass-through (not affected by `shortViewport`).

- [ ] **Step 1: Write the failing test** — append to `display-chrome.test.ts`:

```ts
it('applies reading-prefs attrs from storage (pass-through, no short-viewport effect)', () => {
  localStorage.clear();
  localStorage.setItem('tut.pref.textSize', 'l');
  localStorage.setItem('tut.pref.readWidth', 'narrow');
  localStorage.setItem('tut.pref.codeSize', 's');
  localStorage.setItem('tut.pref.codeWrap', 'on');
  localStorage.setItem('tut.pref.imgSize', 's');
  localStorage.setItem('tut.pref.imgCollapse', 'on');
  localStorage.setItem('tut.pref.reduceMotion', 'on');
  localStorage.setItem('tut.pref.readableFont', 'on');
  applyDisplayChrome(document);
  const el = document.documentElement;
  expect(el.getAttribute('data-tut-text-size')).toBe('l');
  expect(el.getAttribute('data-tut-read-width')).toBe('narrow');
  expect(el.getAttribute('data-tut-code-size')).toBe('s');
  expect(el.getAttribute('data-tut-code-wrap')).toBe('on');
  expect(el.getAttribute('data-tut-img-size')).toBe('s');
  expect(el.getAttribute('data-tut-img-collapse')).toBe('on');
  expect(el.getAttribute('data-tut-reduce-motion')).toBe('on');
  expect(el.getAttribute('data-tut-readable-font')).toBe('on');
});

it('reading-prefs use defaults when unset', () => {
  localStorage.clear();
  applyDisplayChrome(document);
  const el = document.documentElement;
  expect(el.getAttribute('data-tut-text-size')).toBe('m');
  expect(el.getAttribute('data-tut-img-size')).toBe('l');
  expect(el.getAttribute('data-tut-read-width')).toBe('full');
  expect(el.getAttribute('data-tut-code-wrap')).toBe('off');
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/display-chrome.test.ts`
Expected: FAIL — attrs are null.

- [ ] **Step 3: Implement** — in `display-chrome.ts`:

Extend the import from `./prefs-store` to add the 8 new getters. Extend the interfaces and functions:

```ts
// add to DisplayPrefs AND Effective:
  textSize: SizeStep; readWidth: ReadWidth; codeSize: SizeStep; codeWrap: OnOff;
  imgSize: SizeStep; imgCollapse: OnOff; reduceMotion: OnOff; readableFont: OnOff;
```

Import the types: extend the `./constants` import to include `type SizeStep, type ReadWidth`.

In `readPrefs()` add:

```ts
    textSize: getTextSize(), readWidth: getReadWidth(),
    codeSize: getCodeSize(), codeWrap: getCodeWrap(),
    imgSize: getImgSize(), imgCollapse: getImgCollapse(),
    reduceMotion: getReduceMotion(), readableFont: getReadableFont()
```

In `computeEffective()` add pass-through (no `shortViewport` dependency):

```ts
    textSize: prefs.textSize, readWidth: prefs.readWidth,
    codeSize: prefs.codeSize, codeWrap: prefs.codeWrap,
    imgSize: prefs.imgSize, imgCollapse: prefs.imgCollapse,
    reduceMotion: prefs.reduceMotion, readableFont: prefs.readableFont
```

In `applyDisplayChrome()` add:

```ts
  html.setAttribute('data-tut-text-size', eff.textSize);
  html.setAttribute('data-tut-read-width', eff.readWidth);
  html.setAttribute('data-tut-code-size', eff.codeSize);
  html.setAttribute('data-tut-code-wrap', eff.codeWrap);
  html.setAttribute('data-tut-img-size', eff.imgSize);
  html.setAttribute('data-tut-img-collapse', eff.imgCollapse);
  html.setAttribute('data-tut-reduce-motion', eff.reduceMotion);
  html.setAttribute('data-tut-readable-font', eff.readableFont);
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/display-chrome.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/display-chrome.ts hugo-apps/src/tutorial-prefs/display-chrome.test.ts
git commit -m "feat(prefs): apply reading-prefs data-tut-* attrs (#1966)"
```

---

### Task 3: Pre-paint the new attrs in head.html

**Files:**
- Modify: `hugo/layouts/partials/head.html:136-151` (the #1966 pre-paint block)
- Test: `test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts` (created here; extended in later tasks)

**Interfaces:**
- Consumes: existing `document.documentElement.dataset.pageKind === 'tutorial'` gate.
- Produces: pre-paint sets `tutTextSize`, `tutReadWidth`, `tutCodeSize`, `tutCodeWrap`, `tutImgSize`, `tutImgCollapse`, `tutReduceMotion`, `tutReadableFont` dataset props before paint.

- [ ] **Step 1: Write the failing test** — create `test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const head = readFileSync(path.join(root, 'hugo/layouts/partials/head.html'), 'utf8');

describe('reading-prefs batch 2 pre-paint (#1966)', () => {
  it('pre-paint sets all reading-prefs data-tut-* attributes', () => {
    for (const prop of ['tutTextSize','tutReadWidth','tutCodeSize','tutCodeWrap',
                        'tutImgSize','tutImgCollapse','tutReduceMotion','tutReadableFont']) {
      expect(head, prop).toContain(prop);
    }
  });
  it('reading-prefs pre-paint is inside the tutorial page-kind gate', () => {
    expect(head).toMatch(/pageKind === 'tutorial'[\s\S]*tutTextSize/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: FAIL — props absent.

- [ ] **Step 3: Implement** — inside the existing `if (document.documentElement.dataset.pageKind === 'tutorial') { try { ... } }` block in head.html (extend it; keep the same `el` var), before the closing `} catch`:

```js
      var sizeOf = function (k, d) { var v = localStorage.getItem(k); return (v === 's' || v === 'm' || v === 'l') ? v : d; };
      var onoff = function (k) { return localStorage.getItem(k) === 'on' ? 'on' : 'off'; };
      el.dataset.tutTextSize = sizeOf('tut.pref.textSize', 'm');
      el.dataset.tutReadWidth = localStorage.getItem('tut.pref.readWidth') === 'narrow' ? 'narrow' : 'full';
      el.dataset.tutCodeSize = sizeOf('tut.pref.codeSize', 'm');
      el.dataset.tutCodeWrap = onoff('tut.pref.codeWrap');
      el.dataset.tutImgSize = sizeOf('tut.pref.imgSize', 'l');
      el.dataset.tutImgCollapse = onoff('tut.pref.imgCollapse');
      el.dataset.tutReduceMotion = onoff('tut.pref.reduceMotion');
      el.dataset.tutReadableFont = onoff('tut.pref.readableFont');
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/head.html test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts
git commit -m "feat(prefs): pre-paint reading-prefs attrs, no flash (#1966)"
```

---

### Task 4: CSS — text size + reading width

**Files:**
- Modify: `hugo/assets/css/ui5-overrides.css` (after the #1966 block, ~line 769)
- Test: `test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`

**Interfaces:**
- Consumes: `data-tut-text-size`, `data-tut-read-width` on `<html>`; content wrapper `.op-body`.
- Produces: CSS var `--tut-text-scale` on `.op-body`; `max-width` under narrow.

- [ ] **Step 1: Write the failing test** — append to the prepaint test file:

```ts
import { readFileSync as rf2 } from 'node:fs';
const css = rf2(path.join(root, 'hugo/assets/css/ui5-overrides.css'), 'utf8');

describe('reading-prefs batch 2 CSS text hooks', () => {
  it('defines tutorial-scoped text-size + read-width hooks', () => {
    for (const hook of ['data-tut-text-size="s"', 'data-tut-text-size="l"', 'data-tut-read-width="narrow"']) {
      expect(css, hook).toContain(hook);
    }
  });
  it('all new data-tut- CSS rules are tutorial-scoped', () => {
    for (const l of css.split('\n')) {
      if (l.trim().startsWith('html[data-tut-')) expect(l, l).toContain('[data-page-kind="tutorial"]');
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: FAIL — hooks absent.

- [ ] **Step 3: Implement** — append to `ui5-overrides.css`:

```css
/* #1966 batch 2 — reading preferences. All rules tutorial-scoped. */
html[data-tut-text-size="s"][data-page-kind="tutorial"] .op-body { font-size: 0.9rem; }
html[data-tut-text-size="l"][data-page-kind="tutorial"] .op-body { font-size: 1.15rem; }
html[data-tut-read-width="narrow"][data-page-kind="tutorial"] .op-body { max-width: 46rem; margin-inline: auto; }
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo/assets/css/ui5-overrides.css test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts
git commit -m "feat(prefs): text size + reading width CSS (#1966)"
```

---

### Task 5: CSS — code size + wrap

**Files:**
- Modify: `hugo/assets/css/ui5-overrides.css`
- Test: `test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`

**Interfaces:**
- Consumes: `data-tut-code-size`, `data-tut-code-wrap`; code markup `.code-block-body code` / `pre`.
- Produces: code font-size steps; `white-space: pre-wrap` + `overflow-wrap` under wrap.

- [ ] **Step 1: Write the failing test** — append:

```ts
describe('reading-prefs batch 2 CSS code hooks', () => {
  it('defines code-size and code-wrap hooks targeting .code-block-body', () => {
    for (const hook of ['data-tut-code-size="s"', 'data-tut-code-size="l"', 'data-tut-code-wrap="on"']) {
      expect(css, hook).toContain(hook);
    }
    expect(css).toContain('.code-block-body');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — append to `ui5-overrides.css`:

```css
html[data-tut-code-size="s"][data-page-kind="tutorial"] .code-block-body code,
html[data-tut-code-size="s"][data-page-kind="tutorial"] .code-block-body pre { font-size: 0.8rem; }
html[data-tut-code-size="l"][data-page-kind="tutorial"] .code-block-body code,
html[data-tut-code-size="l"][data-page-kind="tutorial"] .code-block-body pre { font-size: 1.05rem; }
html[data-tut-code-wrap="on"][data-page-kind="tutorial"] .code-block-body code,
html[data-tut-code-wrap="on"][data-page-kind="tutorial"] .code-block-body pre {
  white-space: pre-wrap; overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo/assets/css/ui5-overrides.css test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts
git commit -m "feat(prefs): code size + wrap CSS (#1966)"
```

---

### Task 6: CSS — screenshot size cap + collapse

**Files:**
- Modify: `hugo/assets/css/ui5-overrides.css`
- Test: `test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`

**Interfaces:**
- Consumes: `data-tut-img-size`, `data-tut-img-collapse`; figures render as `figure.tutorial-figure` and inline `img` inside `.op-body` (from `render-image.html`). Every zoomable image has `data-zoomable="true"` and opens the existing lightbox on click.
- Produces: `max-height` cap on tutorial images; collapsed dimmed strip that stays clickable (lightbox opens via existing `data-zoomable` handler — no new JS).

- [ ] **Step 1: Write the failing test** — append:

```ts
const renderImage = rf2(path.join(root, 'hugo/layouts/_default/_markup/render-image.html'), 'utf8');
describe('reading-prefs batch 2 CSS screenshot hooks', () => {
  it('defines img-size + img-collapse hooks, tutorial-scoped', () => {
    for (const hook of ['data-tut-img-size="s"', 'data-tut-img-size="m"', 'data-tut-img-collapse="on"']) {
      expect(css, hook).toContain(hook);
    }
  });
  it('targets the real zoomable image markup (not a dead selector)', () => {
    // render-image.html emits data-zoomable images inside .op-body / figure.tutorial-figure
    expect(renderImage).toContain('data-zoomable');
    expect(css).toContain('.op-body');
  });
  it('collapse rule does not touch the lightbox dialog', () => {
    for (const l of css.split('\n')) {
      if (l.includes('data-tut-img-collapse')) expect(l).not.toContain('image-lightbox');
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — append to `ui5-overrides.css`:

```css
/* Screenshot inline size cap — aspect ratio preserved by the browser. Lightbox unchanged. */
html[data-tut-img-size="s"][data-page-kind="tutorial"] .op-body img[data-zoomable] { max-height: 240px; width: auto; }
html[data-tut-img-size="m"][data-page-kind="tutorial"] .op-body img[data-zoomable] { max-height: 420px; width: auto; }
/* Collapse-all: slim dimmed strip; still click/keyboard-openable into the lightbox. */
html[data-tut-img-collapse="on"][data-page-kind="tutorial"] .op-body img[data-zoomable] {
  max-height: 2.5rem; width: auto; opacity: 0.55; cursor: zoom-in;
  outline: 1px dashed var(--sapList_BorderColor, #ccc); outline-offset: 2px;
}
html[data-tut-img-collapse="on"][data-page-kind="tutorial"] .op-body img[data-zoomable]:hover,
html[data-tut-img-collapse="on"][data-page-kind="tutorial"] .op-body img[data-zoomable]:focus { opacity: 1; }
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo/assets/css/ui5-overrides.css test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts
git commit -m "feat(prefs): screenshot size cap + collapse CSS (#1966)"
```

---

### Task 7: CSS — reduce motion

**Files:**
- Modify: `hugo/assets/css/ui5-overrides.css`
- Test: `test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`

**Interfaces:**
- Consumes: `data-tut-reduce-motion`; the #1966 header/footer auto-hide transitions.
- Produces: transitions disabled under the explicit toggle **and** under `@media (prefers-reduced-motion: reduce)`.

- [ ] **Step 1: Write the failing test** — append:

```ts
describe('reading-prefs batch 2 reduce-motion', () => {
  it('defines an explicit reduce-motion hook and honors prefers-reduced-motion', () => {
    expect(css).toContain('data-tut-reduce-motion="on"');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: FAIL (there may already be a `prefers-reduced-motion` occurrence from #1966; if the assertion passes for that string, the `data-tut-reduce-motion` one still fails — verify the FAIL is on the explicit hook).

- [ ] **Step 3: Implement** — append to `ui5-overrides.css`:

```css
html[data-tut-reduce-motion="on"][data-page-kind="tutorial"] .op-header,
html[data-tut-reduce-motion="on"][data-page-kind="tutorial"] footer,
html[data-tut-reduce-motion="on"][data-page-kind="tutorial"] .op-body img[data-zoomable] { transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  html[data-page-kind="tutorial"] .op-header,
  html[data-page-kind="tutorial"] footer { transition: none; }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo/assets/css/ui5-overrides.css test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts
git commit -m "feat(prefs): reduce-motion CSS + prefers-reduced-motion (#1966)"
```

---

### Task 8: OpenDyslexic font — vendored + lazy `@font-face`

**Files:**
- Create: `hugo/static/fonts/OpenDyslexic-Regular.woff2`, `hugo/static/fonts/OpenDyslexic-Bold.woff2`, `hugo/static/fonts/LICENSE-OpenDyslexic.txt`
- Modify: `hugo/assets/css/ui5-overrides.css`
- Test: `test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`

**Interfaces:**
- Consumes: `data-tut-readable-font`.
- Produces: an `@font-face` family `"OpenDyslexic"` referenced **only** under `[data-tut-readable-font="on"]` (so the browser fetches the WOFF2 only when enabled). Served from `/fonts/` (Hugo `static/` maps to site root).

- [ ] **Step 1: Vendor the font**

Download OpenDyslexic WOFF2 (SIL OFL 1.1) from the official release (https://github.com/antijingoist/opendyslexic) and place `OpenDyslexic-Regular.woff2` + `OpenDyslexic-Bold.woff2` in `hugo/static/fonts/`. Save the OFL license text as `hugo/static/fonts/LICENSE-OpenDyslexic.txt`.

Verify:

Run: `ls -la hugo/static/fonts/`
Expected: both `.woff2` files present, each > 10 KB.

- [ ] **Step 2: Write the failing test** — append:

```ts
describe('reading-prefs batch 2 OpenDyslexic (lazy)', () => {
  it('declares an @font-face for OpenDyslexic pointing at /fonts/', () => {
    expect(css).toMatch(/@font-face\s*\{[^}]*OpenDyslexic[^}]*\/fonts\/OpenDyslexic-Regular\.woff2/s);
    expect(css).toContain('font-display: swap');
  });
  it('the OpenDyslexic family is applied ONLY under data-tut-readable-font="on"', () => {
    // Every rule whose declaration block sets font-family to OpenDyslexic must be
    // gated by the readable-font attr — otherwise the font loads on the default path.
    const applyRules = css.split('}').filter(b => /font-family:[^;]*OpenDyslexic/i.test(b) && !/@font-face/i.test(b));
    expect(applyRules.length).toBeGreaterThan(0);
    for (const r of applyRules) expect(r, r).toContain('data-tut-readable-font="on"');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** — append to `ui5-overrides.css`:

```css
/* OpenDyslexic (SIL OFL). @font-face alone does NOT fetch the file; the browser
   downloads it only when the family is matched to rendered text — which happens
   solely under the readable-font toggle below. Zero cost on the default path. */
@font-face {
  font-family: "OpenDyslexic"; font-style: normal; font-weight: 400; font-display: swap;
  src: url("/fonts/OpenDyslexic-Regular.woff2") format("woff2");
}
@font-face {
  font-family: "OpenDyslexic"; font-style: normal; font-weight: 700; font-display: swap;
  src: url("/fonts/OpenDyslexic-Bold.woff2") format("woff2");
}
html[data-tut-readable-font="on"][data-page-kind="tutorial"] .op-body {
  font-family: "OpenDyslexic", var(--sapFontFamily, sans-serif);
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `npx vitest run --project unit test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo/static/fonts/ hugo/assets/css/ui5-overrides.css test/unit/hugo/tutorial-reading-prefs-prepaint.test.ts
git commit -m "feat(prefs): vendor OpenDyslexic + lazy @font-face (#1966)"
```

---

### Task 9: Copy-clean transform in the copy handler

**Files:**
- Create: `hugo/assets/js/copy-clean.ts`
- Create: `hugo/assets/js/copy-clean.test.ts`
- Modify: `hugo/assets/js/tutorial.ts:5-19` (`copyCodeBlock`)

**Interfaces:**
- Consumes: `localStorage['tut.pref.copyClean']`.
- Produces: `export function stripPrompts(text: string): string` — removes a single leading shell/REPL prompt token per line (`$ `, `> `, `# `, `PS> `, `PS ...> `), preserving indentation of the actual command and never altering mid-line characters.

- [ ] **Step 1: Write the failing test** — create `hugo/assets/js/copy-clean.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stripPrompts } from './copy-clean';

describe('stripPrompts', () => {
  it('strips a single leading $ prompt', () => {
    expect(stripPrompts('$ npm install')).toBe('npm install');
  });
  it('strips per line across a block', () => {
    expect(stripPrompts('$ cd app\n$ npm run build')).toBe('cd app\nnpm run build');
  });
  it('strips >, #, and PS> prompts', () => {
    expect(stripPrompts('> node x.js')).toBe('node x.js');
    expect(stripPrompts('# apt update')).toBe('apt update');
    expect(stripPrompts('PS> Get-Item')).toBe('Get-Item');
    expect(stripPrompts('PS C:\\app> dir')).toBe('dir');
  });
  it('leaves mid-line $ and > untouched', () => {
    expect(stripPrompts('echo $HOME > out.txt')).toBe('echo $HOME > out.txt');
  });
  it('leaves lines without a prompt untouched (incl. indentation)', () => {
    expect(stripPrompts('  const x = 1;')).toBe('  const x = 1;');
  });
  it('is a no-op on empty string', () => {
    expect(stripPrompts('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run --project unit hugo/assets/js/copy-clean.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `hugo/assets/js/copy-clean.ts`:

```ts
// Strip a single leading shell/REPL prompt token per line so pasted commands run
// cleanly. Only leading prompts (after optional whitespace) are removed; mid-line
// characters are never touched. Tokens: `$ `, `> `, `# `, `PS> `, `PS <path>> `.
const PROMPT_RE = /^[ \t]*(?:PS[^>\n]*>|[$>#])[ \t]+/;

export function stripPrompts(text: string): string {
  return text.split('\n').map((line) => line.replace(PROMPT_RE, '')).join('\n');
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run --project unit hugo/assets/js/copy-clean.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `copyCodeBlock`** — in `hugo/assets/js/tutorial.ts`, add the import at the top with the other imports:

```ts
import { stripPrompts } from './copy-clean'
```

Then change the `text` line inside `copyCodeBlock`:

```ts
  let text = code.textContent || ''
  try { if (localStorage.getItem('tut.pref.copyClean') === 'on') text = stripPrompts(text) } catch {}
  navigator.clipboard.writeText(text).then(() => {
```

(`const text` becomes `let text`.)

- [ ] **Step 6: Run the full copy-clean suite + typecheck the island bundle**

Run: `npx vitest run --project unit hugo/assets/js/copy-clean.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hugo/assets/js/copy-clean.ts hugo/assets/js/copy-clean.test.ts hugo/assets/js/tutorial.ts
git commit -m "feat(prefs): copy-without-prompt in code copy handler (#1966)"
```

---

### Task 10: Popover UI rows + main.ts wiring

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue`
- Modify: `hugo-apps/src/tutorial-prefs/main.ts`

**Interfaces:**
- Consumes: Task 1 setters, Task 2 `applyDisplayChrome`, existing `computeEffective`/`readPrefs`, the existing segmented-button `onHeaderSelect`/`syncHeaderPressed` pattern.
- Produces: new popover props `textSize/readWidth/codeSize: SizeStep`, `codeWrap/copyClean/imgCollapse/reduceMotion/readableFont: boolean`, `imgSize: SizeStep`; emits `set-text-size`, `set-read-width`, `set-code-size`, `toggle-code-wrap`, `toggle-copy-clean`, `set-img-size`, `toggle-img-collapse`, `toggle-reduce-motion`, `toggle-readable-font`. main.ts adds matching `State` fields + handlers that persist via setters and call `applyDisplayChrome()`.

- [ ] **Step 1: Add popover rows** — in `TutorialPrefsPopover.vue`, inside the `v-if="onTutorialPage"` block, after the "Show discussion section" row (line 45), before the `Experimental` separator (line 47), add:

```html
        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Text</p>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Text size</span></label>
          <ui5-segmented-button data-testid="tut-prefs-text-size" @selection-change="onSizeSelect('set-text-size', $event)">
            <ui5-segmented-button-item :pressed="textSize === 's' || undefined" data-size="s">Small</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="textSize === 'm' || undefined" data-size="m">Medium</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="textSize === 'l' || undefined" data-size="l">Large</ui5-segmented-button-item>
          </ui5-segmented-button>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Reading width</span></label>
          <ui5-segmented-button @selection-change="onWidthSelect">
            <ui5-segmented-button-item :pressed="readWidth === 'full' || undefined" data-width="full">Full</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="readWidth === 'narrow' || undefined" data-width="narrow">Narrow</ui5-segmented-button-item>
          </ui5-segmented-button>
        </section>

        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Code</p>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Code size</span></label>
          <ui5-segmented-button data-testid="tut-prefs-code-size" @selection-change="onSizeSelect('set-code-size', $event)">
            <ui5-segmented-button-item :pressed="codeSize === 's' || undefined" data-size="s">Small</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="codeSize === 'm' || undefined" data-size="m">Medium</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="codeSize === 'l' || undefined" data-size="l">Large</ui5-segmented-button-item>
          </ui5-segmented-button>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Wrap long lines</span>
            <ui5-switch data-testid="tut-prefs-code-wrap" :checked="codeWrap || undefined" @change="$emit('toggle-code-wrap')"></ui5-switch>
          </label>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Copy without prompt ($, &gt;)</span>
            <ui5-switch data-testid="tut-prefs-copy-clean" :checked="copyClean || undefined" @change="$emit('toggle-copy-clean')"></ui5-switch>
          </label>
        </section>

        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Screenshots</p>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Screenshot size</span></label>
          <ui5-segmented-button data-testid="tut-prefs-img-size" @selection-change="onSizeSelect('set-img-size', $event)">
            <ui5-segmented-button-item :pressed="imgSize === 's' || undefined" data-size="s">Small</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="imgSize === 'm' || undefined" data-size="m">Medium</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="imgSize === 'l' || undefined" data-size="l">Large</ui5-segmented-button-item>
          </ui5-segmented-button>
          <p class="tut-prefs__desc">Click any screenshot to open it full-size.</p>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Collapse screenshots</span>
            <ui5-switch data-testid="tut-prefs-img-collapse" :checked="imgCollapse || undefined" @change="$emit('toggle-img-collapse')"></ui5-switch>
          </label>
        </section>

        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Accessibility</p>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Reduce motion</span>
            <ui5-switch data-testid="tut-prefs-reduce-motion" :checked="reduceMotion || undefined" @change="$emit('toggle-reduce-motion')"></ui5-switch>
          </label>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Easier-to-read font</span>
            <ui5-switch data-testid="tut-prefs-readable-font" :checked="readableFont || undefined" @change="$emit('toggle-readable-font')"></ui5-switch>
          </label>
        </section>
```

- [ ] **Step 2: Extend props, emits, and the size-select helper** — in the `<script setup>` block:

Extend the `./constants` type import: `import type { FeatureId, HeaderMode, SizeStep, ReadWidth } from './constants';`

Add to `defineProps`:

```ts
  textSize: SizeStep;
  readWidth: ReadWidth;
  codeSize: SizeStep;
  codeWrap: boolean;
  copyClean: boolean;
  imgSize: SizeStep;
  imgCollapse: boolean;
  reduceMotion: boolean;
  readableFont: boolean;
```

Add to `defineEmits`:

```ts
  (e: 'set-text-size', size: SizeStep): void;
  (e: 'set-read-width', width: ReadWidth): void;
  (e: 'set-code-size', size: SizeStep): void;
  (e: 'toggle-code-wrap'): void;
  (e: 'toggle-copy-clean'): void;
  (e: 'set-img-size', size: SizeStep): void;
  (e: 'toggle-img-collapse'): void;
  (e: 'toggle-reduce-motion'): void;
  (e: 'toggle-readable-font'): void;
```

Add the select handlers (segmented-button fires on programmatic `.click()`, so guard against redundant emits by reading the item dataset):

```ts
function onSizeSelect(event: 'set-text-size' | 'set-code-size' | 'set-img-size', e: any) {
  const size = e.detail?.selectedItems?.[0]?.dataset?.size;
  if (size === 's' || size === 'm' || size === 'l') emit(event, size as SizeStep);
}
function onWidthSelect(e: any) {
  const w = e.detail?.selectedItems?.[0]?.dataset?.width;
  if (w === 'full' || w === 'narrow') emit('set-read-width', w as ReadWidth);
}
```

Note: `@selection-change="onSizeSelect('set-text-size', $event)"` in the template passes the event name; ensure the handler signature matches (event name first, DOM event second).

- [ ] **Step 3: Extend main.ts State + handlers + wiring** — in `hugo-apps/src/tutorial-prefs/main.ts`:

Extend the `./prefs-store` import to add the 9 new setters. Extend the `./constants` type import to add `SizeStep, ReadWidth`.

Add to `interface State`:

```ts
  textSize: SizeStep; readWidth: ReadWidth; codeSize: SizeStep;
  codeWrap: boolean; copyClean: boolean; imgSize: SizeStep;
  imgCollapse: boolean; reduceMotion: boolean; readableFont: boolean;
```

In `init()`, extend the `reactive<State>` initializer using `eff0` (already computed):

```ts
    textSize: eff0.textSize, readWidth: eff0.readWidth, codeSize: eff0.codeSize,
    codeWrap: eff0.codeWrap === 'on', copyClean: eff0.copyClean === 'on',
    imgSize: eff0.imgSize, imgCollapse: eff0.imgCollapse === 'on',
    reduceMotion: eff0.reduceMotion === 'on', readableFont: eff0.readableFont === 'on'
```

Add handler functions (near `setHeader`):

```ts
function setTextSize(state: State, v: SizeStep) { setTextSizePref(v); state.textSize = v; applyDisplayChrome(); }
function setReadWidth(state: State, v: ReadWidth) { setReadWidthPref(v); state.readWidth = v; applyDisplayChrome(); }
function setCodeSize(state: State, v: SizeStep) { setCodeSizePref(v); state.codeSize = v; applyDisplayChrome(); }
function toggleCodeWrap(state: State) { const n = state.codeWrap ? 'off' : 'on'; setCodeWrapPref(n); state.codeWrap = n === 'on'; applyDisplayChrome(); }
function toggleCopyClean(state: State) { const n = state.copyClean ? 'off' : 'on'; setCopyCleanPref(n); state.copyClean = n === 'on'; /* no attr — read at copy time */ }
function setImgSize(state: State, v: SizeStep) { setImgSizePref(v); state.imgSize = v; applyDisplayChrome(); }
function toggleImgCollapse(state: State) { const n = state.imgCollapse ? 'off' : 'on'; setImgCollapsePref(n); state.imgCollapse = n === 'on'; applyDisplayChrome(); }
function toggleReduceMotion(state: State) { const n = state.reduceMotion ? 'off' : 'on'; setReduceMotionPref(n); state.reduceMotion = n === 'on'; applyDisplayChrome(); }
function toggleReadableFont(state: State) { const n = state.readableFont ? 'off' : 'on'; setReadableFontPref(n); state.readableFont = n === 'on'; applyDisplayChrome(); }
```

Import aliasing: import the store setters under `*Pref` aliases to avoid the local-name clash (e.g. `import { ..., setTextSize as setTextSizePref, setReadWidth as setReadWidthPref, setCodeSize as setCodeSizePref, setCodeWrap as setCodeWrapPref, setCopyClean as setCopyCleanPref, setImgSize as setImgSizePref, setImgCollapse as setImgCollapsePref, setReduceMotion as setReduceMotionPref, setReadableFont as setReadableFontPref } from './prefs-store'`).

Add to the `h(TutorialPrefsPopover, { ... })` prop object:

```ts
      textSize: state.textSize,
      readWidth: state.readWidth,
      codeSize: state.codeSize,
      codeWrap: state.codeWrap,
      copyClean: state.copyClean,
      imgSize: state.imgSize,
      imgCollapse: state.imgCollapse,
      reduceMotion: state.reduceMotion,
      readableFont: state.readableFont,
      'onSet-text-size': (v: SizeStep) => setTextSize(state, v),
      'onSet-read-width': (v: ReadWidth) => setReadWidth(state, v),
      'onSet-code-size': (v: SizeStep) => setCodeSize(state, v),
      'onToggle-code-wrap': () => toggleCodeWrap(state),
      'onToggle-copy-clean': () => toggleCopyClean(state),
      'onSet-img-size': (v: SizeStep) => setImgSize(state, v),
      'onToggle-img-collapse': () => toggleImgCollapse(state),
      'onToggle-reduce-motion': () => toggleReduceMotion(state),
      'onToggle-readable-font': () => toggleReadableFont(state),
```

- [ ] **Step 4: Build the island to verify it compiles**

Run: `cd hugo-apps && npx vite build 2>&1 | tail -20 && cd ..`
Expected: build succeeds; a `tutorial-prefs-*.js` chunk is emitted. (If the repo builds islands via a different script, use `npm run build:apps` from repo root instead — check `jq '.scripts' package.json`.)

- [ ] **Step 5: Run the tutorial-prefs unit suite**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/`
Expected: PASS (existing header/footer tests + Tasks 1-2 tests still green).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue hugo-apps/src/tutorial-prefs/main.ts
git commit -m "feat(prefs): reading-prefs popover rows + wiring (#1966)"
```

---

### Task 11: E2E behavioral spec

**Files:**
- Create: `test/e2e/tutorial-reading-prefs.test.js`

**Interfaces:**
- Consumes: the deployed tutorial page; the `#sb-prefs` trigger; `data-testid` switches/segmented-buttons from Task 10; `data-tut-*` attrs from Tasks 2-3.
- Produces: a self-skipping Playwright spec (mirrors `test/e2e/tutorial-display-prefs.test.js` structure — read it first for the base-URL guard + auth setup).

- [ ] **Step 1: Read the existing display-prefs E2E spec** to copy its self-skip guard and navigation helper.

Run: `sed -n '1,60p' test/e2e/tutorial-display-prefs.test.js`

- [ ] **Step 2: Write the spec** — create `test/e2e/tutorial-reading-prefs.test.js` following that structure. Assertions:

```js
// Pseudocode of the core assertions — adapt to the existing spec's harness/helpers.
// 1. Open a known tutorial page; open the prefs popover via #sb-prefs.
// 2. Toggle "Wrap long lines" → assert html[data-tut-code-wrap="on"].
// 3. Select code size Large → assert html[data-tut-code-size="l"].
// 4. Toggle "Collapse screenshots" → assert html[data-tut-img-collapse="on"]
//    AND a tutorial image's rendered box height shrinks.
// 5. Enable "Easier-to-read font": assert the OpenDyslexic WOFF2 is NOT among
//    network requests BEFORE enabling, and IS requested AFTER (proves lazy load).
// 6. Enable copy-clean, click a code block's copy button on a block whose first
//    line begins "$ ", read clipboard, assert the "$ " prompt is stripped.
```

Use `page.on('request', ...)` captured before the toggle to prove the font is absent on the default path, then assert it appears after enabling (the lazy-load guarantee — the single most important behavioral check).

- [ ] **Step 3: Run locally only if a base URL is set** (otherwise it self-skips, which is expected in CI on PRs):

Run: `SMOKE_BASE_URL=<deployed-dev-url> npx playwright test test/e2e/tutorial-reading-prefs.test.js` (only if you have a deployed build with this branch; otherwise confirm it self-skips: `npx playwright test test/e2e/tutorial-reading-prefs.test.js` → skipped).
Expected: skipped without base URL; green against a deployed build.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/tutorial-reading-prefs.test.js
git commit -m "test(prefs): E2E for reading-prefs incl. lazy-font proof (#1966)"
```

---

### Task 12: Full verification + PR

**Files:** none (verification + integration).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS (no regressions in tutorial-prefs, hugo guards, or copy-clean).

- [ ] **Step 2: Lint/typecheck the island bundle**

Run: `npm run build:apps` (or the island build script from `jq '.scripts' package.json`)
Expected: `tutorial-prefs-*.js` emits with no TS errors.

- [ ] **Step 3: Hugo build sanity** (confirms CSS + head.html compile and the font path resolves)

Run: `npm run fetch-tutorials && npm run dev` in a scratch shell, load a tutorial page, open the prefs popover, exercise each control, confirm no console errors, and confirm `/fonts/OpenDyslexic-Regular.woff2` 200s only after enabling the font. Stop the dev server.
Expected: all controls apply visibly; font fetched lazily.

- [ ] **Step 4: Review the diff against the spec**

Confirm every spec preference maps to a shipped control + attr + CSS hook; confirm no CRLF was introduced (`git diff --stat`); confirm every new CSS rule is tutorial-scoped.

- [ ] **Step 5: Push and open a draft PR targeting DEV**

```bash
git push -u origin feat/tutorial-reading-prefs-batch2
gh pr create --repo sap-tutorials/tutorials-ims --base DEV --draft \
  --title "feat(prefs): tutorial reading preferences batch 2 (#1966)" \
  --body "Second batch of tutorial reading prefs — text size/width, code size/wrap/copy-clean, screenshot size/collapse, reduce-motion, OpenDyslexic (lazy). Extends #1966 pattern. Spec + plan in docs/superpowers/."
```

Expected: draft PR opened against `DEV`.

---

## Self-Review

**Spec coverage:**
- Text size + reading width → Tasks 1,2,3,4,10. ✓
- Code size + wrap + copy-clean → Tasks 1,2,3,5,9,10. ✓
- Screenshot size + collapse → Tasks 1,2,3,6,10. ✓
- Reduce motion (+ prefers-reduced-motion) → Tasks 1,2,3,7,10. ✓
- OpenDyslexic (lazy) → Tasks 1,2,3,8,10. ✓
- Pre-paint no-flash → Task 3. ✓
- Tutorial-scoping + zero default-path cost → Tasks 4-8 (CSS scoping) + Task 8/11 (lazy-font guard). ✓
- Popover UX (single popover, grouped) → Task 10. ✓
- Testing (unit/hugo-guard/E2E) → Tasks 1-2 (unit), 3-8 (guard), 9 (copy-clean unit), 11 (E2E). ✓

**Placeholder scan:** Task 11 uses pseudocode for the E2E body because it must adapt to the existing spec's harness — Step 1 mandates reading `tutorial-display-prefs.test.js` first, and the concrete assertions are enumerated. No other placeholders.

**Type consistency:** `SizeStep`/`ReadWidth`/`OnOff` used consistently across constants → prefs-store → display-chrome → popover → main. Getter/setter names match between Task 1 (definitions) and Tasks 2/10 (consumers). main.ts aliases store setters as `*Pref` to avoid the local-handler name clash — flagged explicitly in Task 10 Step 3.

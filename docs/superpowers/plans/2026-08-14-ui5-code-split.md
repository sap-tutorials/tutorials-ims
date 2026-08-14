# UI5 Code-Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic UI5 bootstrap into page-type-conditional Vite entries so each page loads only the UI5 components it renders (~362 KiB unused JS off the homepage), behind a reversible flag.

**Architecture:** Move `hugo/assets/js/ui5-bootstrap.ts` (Hugo `js.Build`) into four Vite entries under `hugo-apps/src/ui5/` (`ui5-core`, `ui5-tutorial`, `ui5-me`, `ui5-illustrations`). A shared `ui5-vendor` chunk (Vite `manualChunks`) keeps exactly one `@ui5/webcomponents-base` `Theme` instance. `baseof.html` loads `ui5-core` on every page plus the page-type entries by `.Type`, gated on `site.Params.ui5Split`; the current bootstrap stays as the OFF path. A build-time coverage guard fails the build if any page renders a `<ui5-*>` element no loaded entry registers.

**Tech Stack:** Vite/Rollup, Hugo (`resources`, `js.Build`, `island-src.html`), TypeScript, `@ui5/webcomponents*`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-14-ui5-code-split-design.md`

## Global Constraints

- **Single UI5 copy** — exactly one `@ui5/webcomponents-base` `Theme` module across all emitted chunks. Enforced by `manualChunks` + a build assertion. Violating it reintroduces the dark-on-dark theme bug (`feedback_ui5_duplicate_bundle_kills_settheme`).
- **Theming-only Assets** — entries import `@ui5/webcomponents-theming/dist/Assets.js` + `Themes.js` json-imports, **never** the blanket `@ui5/webcomponents/dist/Assets.js` (that re-adds the 11 MB CLDR, per #1770).
- **Flag default OFF** — `site.Params.ui5Split=false`. Both paths bake. Flipping ON per env is a deploy/rollout action, not a code change in this plan.
- **previewMode skips all UI5** — the flag-ON block must be inside the existing `{{ if not site.Params.previewMode }}` guard, matching today's `ui5-bootstrap` behavior (#1688).
- **Entry filenames stay hashed** — `[name]-[hash].js` (the default in `entryFileNames`); do NOT add the new entries to the un-hashed exception list (`nav-dropdown`/`concepts-filter`).
- **Fingerprint/retention is automatic** — hashed Vite chunks flow through `build:island-manifest` → `island-src.html` → `retain-asset-bundles` (already matches hashed `.js`). No changes there.

---

### Task 1: `ui5-core` entry + shared `ui5-vendor` chunk

**Files:**
- Create: `hugo-apps/src/ui5/ui5-core.ts`
- Modify: `hugo-apps/vite.config.ts` (input map ~L278-328; output ~L329-346)
- Test: `hugo-apps/src/ui5/__tests__/ui5-core.build.test.ts`

**Interfaces:**
- Produces: Vite entry `ui5-core` → `hugo/static/js/ui5-core-<hash>.js`, indexed in `island_manifest.json` as `ui5-core`. Registers chrome elements: `ui5-shellbar`, `ui5-shellbar-item`, `ui5-avatar`, `ui5-popover`, `ui5-button`, `ui5-input`, `ui5-list`, `ui5-li` (ListItemStandard), `ui5-switch`, `ui5-title`, `ui5-message-strip`, `ui5-toast`, `ui5-notification-list-item`. Emits a shared `ui5-vendor-<hash>.js` chunk.

- [ ] **Step 1: Write the failing build test**

```ts
// hugo-apps/src/ui5/__tests__/ui5-core.build.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(__dirname, '../../../../hugo/static/js');

describe('ui5-core Vite entry', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: resolve(__dirname, '../../..'), stdio: 'inherit' });
  }, 240000);

  it('emits a hashed ui5-core entry', () => {
    const files = readdirSync(OUT);
    expect(files.some(f => /^ui5-core-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });

  it('emits exactly one shared ui5-vendor chunk', () => {
    const files = readdirSync(OUT + '/chunks').filter(f => /^ui5-vendor-/.test(f));
    expect(files.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (repo root): `npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-core.build.test.ts`
Expected: FAIL — no `ui5-core-*.js` emitted.

- [ ] **Step 3: Create the `ui5-core` entry**

Move the chrome imports out of `hugo/assets/js/ui5-bootstrap.ts` into this file. Include theming-only Assets and the `setTheme` race logic verbatim from the current bootstrap:

```ts
// hugo-apps/src/ui5/ui5-core.ts — chrome + theme, loaded on every page.
import { setTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";
import "../../../hugo/assets/css/skeletons.css";
// Theming-only assets (NO blanket Assets.js — that re-adds 11MB CLDR, #1770)
import "@ui5/webcomponents-theming/dist/Assets.js";
import "@ui5/webcomponents/dist/generated/json-imports/Themes.js";
import "@ui5/webcomponents-fiori/dist/generated/json-imports/Themes.js";
// Chrome components
import "@ui5/webcomponents/dist/Avatar.js";
import "@ui5/webcomponents/dist/MessageStrip.js";
import "@ui5/webcomponents/dist/Popover.js";
import "@ui5/webcomponents/dist/Toast.js";
import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/Input.js";
import "@ui5/webcomponents/dist/List.js";
import "@ui5/webcomponents/dist/ListItemStandard.js";
import "@ui5/webcomponents/dist/Switch.js";
import "@ui5/webcomponents/dist/Title.js";
import "@ui5/webcomponents-fiori/dist/ShellBar.js";
import "@ui5/webcomponents-fiori/dist/ShellBarItem.js";
import "@ui5/webcomponents-fiori/dist/NotificationListItem.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoNotifications.js";
// Chrome/nav/verb icons (all icons NOT specific to tutorial lightbox)
import "@ui5/webcomponents-icons/dist/menu2.js";
import "@ui5/webcomponents-icons/dist/share-2.js";
import "@ui5/webcomponents-icons/dist/da.js";
import "@ui5/webcomponents-icons/dist/question-mark.js";
import "@ui5/webcomponents-icons/dist/search.js";
import "@ui5/webcomponents-icons/dist/action-settings.js";
import "@ui5/webcomponents-icons/dist/bbyd-active-sales.js";
import "@ui5/webcomponents-icons/dist/employee.js";
import "@ui5/webcomponents-icons/dist/accept.js";
import "@ui5/webcomponents-icons/dist/home.js";
import "@ui5/webcomponents-icons/dist/palette.js";
import "@ui5/webcomponents-icons/dist/arrow-right.js";
import "@ui5/webcomponents-icons/dist/bell.js";
import "@ui5/webcomponents-icons/dist/person-placeholder.js";
import "@ui5/webcomponents-icons/dist/dark-mode.js";
import "@ui5/webcomponents-icons/dist/light-mode.js";
import "@ui5/webcomponents-icons/dist/course-book.js";
import "@ui5/webcomponents-icons/dist/org-chart.js";
import "@ui5/webcomponents-icons/dist/command-line-interfaces.js";
import "@ui5/webcomponents-icons/dist/flight.js";
import "@ui5/webcomponents-icons/dist/sys-monitor.js";
import "@ui5/webcomponents-icons/dist/complete.js";
import "@ui5/webcomponents-icons/dist/course-program.js";
import "@ui5/webcomponents-icons/dist/settings.js";
import "@ui5/webcomponents-icons/dist/copy.js";
import "@ui5/webcomponents-icons/dist/discussion-2.js";
import "@ui5/webcomponents-icons/dist/write-new-document.js";
import "@ui5/webcomponents-icons/dist/email.js";
import "@ui5/webcomponents-icons/dist/post.js";
import "@ui5/webcomponents-icons/dist/customer-and-contacts.js";
import "@ui5/webcomponents-icons/dist/learning-assistant.js";
import "@ui5/webcomponents-icons/dist/developer-settings.js";
import "@ui5/webcomponents-icons/dist/chain-link.js";
import "@ui5/webcomponents-icons/dist/database.js";
import "@ui5/webcomponents-icons/dist/favorite.js";
import "@ui5/webcomponents-icons/dist/unfavorite.js";
import "@ui5/webcomponents-icons/dist/document.js";
import "@ui5/webcomponents-icons/dist/wrench.js";
import "@ui5/webcomponents-icons/dist/newspaper.js";
import "@ui5/webcomponents-icons/dist/documents.js";
import "@ui5/webcomponents-icons/dist/decline.js";
import "@ui5/webcomponents-icons/dist/navigation-up-arrow.js";   // popover arrows (chrome)
import "@ui5/webcomponents-icons/dist/navigation-down-arrow.js";
// Chrome local modules
import "../../../hugo/assets/js/nav-progress";
import "../../../hugo/assets/js/recommend";
import "../../../hugo/assets/js/view-transitions";

const root = document.documentElement;
function currentTheme(): "sap_horizon" | "sap_horizon_dark" {
  return root.dataset.theme === "dark" ? "sap_horizon_dark" : "sap_horizon";
}
setTheme(currentTheme());
queueMicrotask(() => setTheme(currentTheme()));
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTheme(currentTheme()), { once: true });
} else {
  requestAnimationFrame(() => setTheme(currentTheme()));
}
const observer = new MutationObserver(() => setTheme(currentTheme()));
observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
```

Note: the `../../../hugo/assets/js/*` relative imports let the local modules stay in place for the OFF path. If Vite's `resolve` rejects paths outside `hugo-apps`, add `server.fs.allow`/`build` allowance, or copy the modules under `hugo-apps/src/ui5/modules/` and update the OFF-path bootstrap import — decide in Step 3 and keep both paths pointing at one copy.

- [ ] **Step 4: Add the entry + `manualChunks` to Vite config**

In `hugo-apps/vite.config.ts`, add to `rollupOptions.input` (after `devtoberfest-faq`, L327):

```ts
        'ui5-core': resolve(__dirname, 'src/ui5/ui5-core.ts'),
```

And add `manualChunks` to `rollupOptions.output` (alongside `entryFileNames`/`chunkFileNames`, L346):

```ts
        manualChunks(id) {
          // Force the UI5 base (the Theme singleton) into ONE shared chunk so
          // every ui5-* entry references the same Theme instance. Single-copy
          // invariant — see spec. Do NOT widen this to all of @ui5 (that would
          // pull every component into the shared chunk, defeating the split).
          if (id.includes('@ui5/webcomponents-base')) return 'ui5-vendor';
        },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-core.build.test.ts`
Expected: PASS — `ui5-core-<hash>.js` + one `chunks/ui5-vendor-*.js` present.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/ui5/ui5-core.ts hugo-apps/vite.config.ts hugo-apps/src/ui5/__tests__/ui5-core.build.test.ts
git commit -m "feat(ui5): ui5-core Vite entry + shared ui5-vendor chunk (#1777)"
```

---

### Task 2: `ui5-tutorial` entry

**Files:**
- Create: `hugo-apps/src/ui5/ui5-tutorial.ts`
- Modify: `hugo-apps/vite.config.ts` (input map)
- Test: `hugo-apps/src/ui5/__tests__/ui5-tutorial.build.test.ts`

**Interfaces:**
- Produces: Vite entry `ui5-tutorial`. Registers: `ui5-wizard`, `ui5-wizard-step`, `ui5-segmented-button`, `ui5-segmented-button-item`, `ui5-tabcontainer`, `ui5-tab`, `ui5-progress-indicator`, `ui5-radio-button`, `ui5-checkbox`, `ui5-rating-indicator`, `ui5-textarea`, `ui5-dialog`, `ui5-busy-indicator`, `ui5-side-navigation`, `ui5-side-navigation-item`, `ui5-side-navigation-sub-item`.

- [ ] **Step 1: Write the failing build test**

```ts
// hugo-apps/src/ui5/__tests__/ui5-tutorial.build.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve(__dirname, '../../../../hugo/static/js');
describe('ui5-tutorial Vite entry', () => {
  it('emits a hashed ui5-tutorial entry (run after build)', () => {
    const files = readdirSync(OUT);
    expect(files.some(f => /^ui5-tutorial-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:apps && npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-tutorial.build.test.ts`
Expected: FAIL — no `ui5-tutorial-*.js`.

- [ ] **Step 3: Create the entry**

```ts
// hugo-apps/src/ui5/ui5-tutorial.ts — tutorial-page components + modules.
import "../../../hugo/assets/css/lightbox.css";
import "@ui5/webcomponents/dist/RadioButton.js";
import "@ui5/webcomponents/dist/CheckBox.js";
import "@ui5/webcomponents/dist/RatingIndicator.js";
import "@ui5/webcomponents/dist/ProgressIndicator.js";
import "@ui5/webcomponents/dist/Dialog.js";
import "@ui5/webcomponents/dist/BusyIndicator.js";
import "@ui5/webcomponents/dist/TextArea.js";
import "@ui5/webcomponents/dist/TabContainer.js";
import "@ui5/webcomponents/dist/Tab.js";
import "@ui5/webcomponents/dist/SegmentedButton.js";
import "@ui5/webcomponents/dist/SegmentedButtonItem.js";
import "@ui5/webcomponents-fiori/dist/Wizard.js";
import "@ui5/webcomponents-fiori/dist/SideNavigation.js";
import "@ui5/webcomponents-fiori/dist/SideNavigationItem.js";
import "@ui5/webcomponents-fiori/dist/SideNavigationSubItem.js";
// Lightbox toolbar icons
import "@ui5/webcomponents-icons/dist/zoom-in.js";
import "@ui5/webcomponents-icons/dist/zoom-out.js";
import "@ui5/webcomponents-icons/dist/navigation-left-arrow.js";
import "@ui5/webcomponents-icons/dist/navigation-right-arrow.js";
import "@ui5/webcomponents-icons/dist/reset.js";
import "@ui5/webcomponents-icons/dist/download.js";
// Tutorial local modules
import "../../../hugo/assets/js/codetabs";
import "../../../hugo/assets/js/os-toggle";
import "../../../hugo/assets/js/glossary";
import "../../../hugo/assets/js/reading-progress";
import "../../../hugo/assets/js/lightbox";
import "../../../hugo/assets/js/mission-side-nav";
import "../../../hugo/assets/css/mission-side-nav.css";
```

- [ ] **Step 4: Add to Vite input**

```ts
        'ui5-tutorial': resolve(__dirname, 'src/ui5/ui5-tutorial.ts'),
```

- [ ] **Step 5: Build + run test to verify pass**

Run: `npm run build:apps && npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-tutorial.build.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/ui5/ui5-tutorial.ts hugo-apps/vite.config.ts hugo-apps/src/ui5/__tests__/ui5-tutorial.build.test.ts
git commit -m "feat(ui5): ui5-tutorial Vite entry (#1777)"
```

---

### Task 3: `ui5-me` entry

**Files:**
- Create: `hugo-apps/src/ui5/ui5-me.ts`
- Modify: `hugo-apps/vite.config.ts` (input map)
- Test: `hugo-apps/src/ui5/__tests__/ui5-me.build.test.ts`

**Interfaces:**
- Produces: Vite entry `ui5-me`. Registers: `ui5-select`, `ui5-option`, `ui5-label`, `ui5-text`, `ui5-panel`, `ui5-timeline`, `ui5-timeline-item`.

- [ ] **Step 1: Write the failing build test**

```ts
// hugo-apps/src/ui5/__tests__/ui5-me.build.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve(__dirname, '../../../../hugo/static/js');
describe('ui5-me Vite entry', () => {
  it('emits a hashed ui5-me entry (run after build)', () => {
    expect(readdirSync(OUT).some(f => /^ui5-me-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:apps && npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-me.build.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create the entry**

```ts
// hugo-apps/src/ui5/ui5-me.ts — /me page components.
import "@ui5/webcomponents/dist/Select.js";
import "@ui5/webcomponents/dist/Option.js";
import "@ui5/webcomponents/dist/Label.js";
import "@ui5/webcomponents/dist/Text.js";
import "@ui5/webcomponents/dist/Panel.js";
import "@ui5/webcomponents-fiori/dist/Timeline.js";
import "@ui5/webcomponents-fiori/dist/TimelineItem.js";
```

- [ ] **Step 4: Add to Vite input**

```ts
        'ui5-me': resolve(__dirname, 'src/ui5/ui5-me.ts'),
```

- [ ] **Step 5: Build + run test to verify pass**

Run: `npm run build:apps && npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-me.build.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/ui5/ui5-me.ts hugo-apps/vite.config.ts hugo-apps/src/ui5/__tests__/ui5-me.build.test.ts
git commit -m "feat(ui5): ui5-me Vite entry (#1777)"
```

---

### Task 4: `ui5-illustrations` entry + retire the old bootstrap's moved imports

**Files:**
- Create: `hugo-apps/src/ui5/ui5-illustrations.ts`
- Modify: `hugo-apps/vite.config.ts` (input map)
- Modify: `hugo/assets/js/ui5-bootstrap.ts` (leave intact for the OFF path — do NOT delete; see Task 7)
- Test: `hugo-apps/src/ui5/__tests__/ui5-illustrations.build.test.ts`

**Interfaces:**
- Produces: Vite entry `ui5-illustrations`. Registers: `ui5-illustrated-message` + illustration assets PageNotFound, NoData, NoFilterResults, tnt/Lock, UnableToLoad.

- [ ] **Step 1: Write the failing build test**

```ts
// hugo-apps/src/ui5/__tests__/ui5-illustrations.build.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve(__dirname, '../../../../hugo/static/js');
describe('ui5-illustrations Vite entry', () => {
  it('emits a hashed ui5-illustrations entry (run after build)', () => {
    expect(readdirSync(OUT).some(f => /^ui5-illustrations-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:apps && npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-illustrations.build.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create the entry**

```ts
// hugo-apps/src/ui5/ui5-illustrations.ts — error pages + browse no-results.
import "@ui5/webcomponents-fiori/dist/IllustratedMessage.js";
import "@ui5/webcomponents-fiori/dist/illustrations/PageNotFound.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoFilterResults.js";
import "@ui5/webcomponents-fiori/dist/illustrations/tnt/Lock.js";
import "@ui5/webcomponents-fiori/dist/illustrations/UnableToLoad.js";
```

- [ ] **Step 4: Add to Vite input**

```ts
        'ui5-illustrations': resolve(__dirname, 'src/ui5/ui5-illustrations.ts'),
```

- [ ] **Step 5: Build + run test to verify pass**

Run: `npm run build:apps && npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-illustrations.build.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/ui5/ui5-illustrations.ts hugo-apps/vite.config.ts hugo-apps/src/ui5/__tests__/ui5-illustrations.build.test.ts
git commit -m "feat(ui5): ui5-illustrations Vite entry (#1777)"
```

---

### Task 5: Single-UI5-copy build assertion

**Files:**
- Create: `scripts/check-ui5-single-copy.cjs`
- Modify: `package.json` (add `check:ui5-single-copy`; chain into `build:all` after `build:island-manifest`)
- Test: `test/unit/check-ui5-single-copy.test.js`

**Interfaces:**
- Consumes: emitted chunks in `hugo/static/js/` + `hugo/static/js/chunks/`.
- Produces: CLI exiting non-zero if `@ui5/webcomponents-base`'s `Theme` module appears in more than one emitted chunk. Exported function `countThemeCopies(dir): number` for the test.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/check-ui5-single-copy.test.js
import { describe, it, expect } from 'vitest';
import { countThemeCopies } from '../../scripts/check-ui5-single-copy.cjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(files) {
  const d = mkdtempSync(join(tmpdir(), 'ui5copy-'));
  mkdirSync(join(d, 'chunks'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(d, rel), body);
  return d;
}

describe('countThemeCopies', () => {
  it('returns 1 when the Theme marker is in one shared chunk', () => {
    const d = fixture({
      'ui5-core-a1b2c3d4.js': 'import "./chunks/ui5-vendor-x.js"',
      'chunks/ui5-vendor-x.js': '/* @ui5/webcomponents-base/dist/config/Theme */ setTheme',
    });
    expect(countThemeCopies(d)).toBe(1);
  });
  it('returns 2 when Theme is duplicated across chunks', () => {
    const d = fixture({
      'ui5-core-a1b2c3d4.js': '/* @ui5/webcomponents-base/dist/config/Theme */',
      'chunks/ui5-vendor-x.js': '/* @ui5/webcomponents-base/dist/config/Theme */',
    });
    expect(countThemeCopies(d)).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/check-ui5-single-copy.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guard**

```js
// scripts/check-ui5-single-copy.cjs
const fs = require('node:fs');
const path = require('node:path');

// Vite prepends each source module's path as a comment banner in the bundle.
// The Theme singleton lives at @ui5/webcomponents-base/dist/config/Theme.
const MARKER = /@ui5\/webcomponents-base\/dist\/config\/Theme/;

function listJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listJs(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function countThemeCopies(dir) {
  return listJs(dir).filter(f => MARKER.test(fs.readFileSync(f, 'utf8'))).length;
}

if (require.main === module) {
  const dir = path.resolve(__dirname, '..', 'hugo', 'static', 'js');
  const n = countThemeCopies(dir);
  if (n !== 1) {
    console.error(`[check-ui5-single-copy] FAIL: expected exactly 1 @ui5 Theme copy, found ${n}. ` +
      `Check vite manualChunks (ui5-vendor).`);
    process.exit(1);
  }
  console.log('[check-ui5-single-copy] OK — single UI5 Theme copy');
}

module.exports = { countThemeCopies };
```

Note for implementer: if minification strips the path banner, switch the marker to a stable Theme-internal string (verify by grepping the built `ui5-vendor-*.js` for a unique token from `Theme.js`, e.g. `getTheme`), and update the test fixtures to match.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run --project unit test/unit/check-ui5-single-copy.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into build:all**

In `package.json`, add script `"check:ui5-single-copy": "node scripts/check-ui5-single-copy.cjs"` and insert `&& npm run check:ui5-single-copy` in `build:all` immediately after `npm run build:island-manifest`.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-ui5-single-copy.cjs test/unit/check-ui5-single-copy.test.js package.json
git commit -m "feat(ui5): build assertion for single UI5 Theme copy (#1777)"
```

---

### Task 6: Coverage guard — every rendered `<ui5-*>` is registered by a loaded entry

**Files:**
- Create: `scripts/check-ui5-entry-coverage.ts`
- Create: `scripts/ui5-entry-page-map.cjs` (shared source of truth: page-type → entries; imported by both the guard and referenced by baseof in Task 7)
- Modify: `package.json` `build:all` chain (insert `&& npx tsx scripts/check-ui5-entry-coverage.ts` after `check:ui5-single-copy`)
- Test: `test/unit/check-ui5-entry-coverage.test.ts`

**Interfaces:**
- Consumes: **built** chunks in `hugo/static/js/` (via `hugo/data/island_manifest.json` entry→file map); Hugo layouts (`hugo/layouts/**`), shortcodes, and Vue islands (`hugo-apps/src/**`).
- Produces: CLI exiting non-zero on an uncovered element. Exports `extractDefinedTags(bundleText): Set<string>` (scans `customElements.define("ui5-…")` — the ACTUAL registered tags, since UI5 tags are irregular: `ShellBar`→`ui5-shellbar`, `ListItemStandard`→`ui5-li`) and `reachableChunks(entryFile, jsDir): string[]` for the test.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/check-ui5-entry-coverage.test.ts
import { describe, it, expect } from 'vitest';
import { extractDefinedTags } from '../../scripts/check-ui5-entry-coverage.ts';

describe('extractDefinedTags', () => {
  it('reads the actual tag from customElements.define, incl. irregular tags', () => {
    const bundle = `customElements.define("ui5-shellbar",X);customElements.define('ui5-li',Y);`;
    const tags = extractDefinedTags(bundle);
    expect(tags.has('ui5-shellbar')).toBe(true);   // NOT ui5-shell-bar
    expect(tags.has('ui5-li')).toBe(true);          // ListItemStandard
  });
  it('ignores non-ui5 defines', () => {
    expect(extractDefinedTags(`customElements.define("my-widget",Z)`).has('my-widget')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/check-ui5-entry-coverage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the page map**

```js
// scripts/ui5-entry-page-map.cjs
// Single source of truth for page-type -> UI5 entries. baseof.html mirrors
// these conditions; the coverage guard enforces them. Keep in sync.
module.exports = {
  // entry -> predicate over a layout's repo-relative path
  entryLayoutGlobs: {
    'ui5-core': () => true, // every page
    'ui5-tutorial': (p) => p.includes('/layouts/tutorials/') || p.includes('/shortcodes/codetabs.html') || p.includes('/partials/mission-side-nav.html'),
    'ui5-me': (p) => p.includes('/layouts/me/'),
    'ui5-illustrations': (p) => /\/layouts\/(403|404|502)\.html$/.test(p) || p.includes('/layouts/browse/'),
  },
  entrySrcFiles: {
    'ui5-core': 'hugo-apps/src/ui5/ui5-core.ts',
    'ui5-tutorial': 'hugo-apps/src/ui5/ui5-tutorial.ts',
    'ui5-me': 'hugo-apps/src/ui5/ui5-me.ts',
    'ui5-illustrations': 'hugo-apps/src/ui5/ui5-illustrations.ts',
  },
};
```

Note: `ui5-*` custom elements rendered by a Vue **island** (e.g. `validation`, `me`) count too — treat the island `.vue`/`.ts` files as layouts owned by the page type that mounts them (validation/code-check → tutorial; me → me). Extend `entryLayoutGlobs` predicates to include those island source dirs.

- [ ] **Step 4: Implement the guard**

```ts
// scripts/check-ui5-entry-coverage.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const MAP = require('./ui5-entry-page-map.cjs');
const ROOT = join(__dirname, '..');
const JS_DIR = join(ROOT, 'hugo/static/js');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'hugo/data/island_manifest.json'), 'utf8'));

// Read the ACTUAL registered tags from a built bundle. UI5 tags are irregular
// (ShellBar->ui5-shellbar, ListItemStandard->ui5-li), so never guess from the
// import path — read the customElements.define() calls in the emitted JS.
export function extractDefinedTags(bundleText: string): Set<string> {
  const tags = new Set<string>();
  for (const m of bundleText.matchAll(/customElements\.define\(\s*["'](ui5-[a-z0-9-]+)["']/g)) tags.add(m[1]);
  return tags;
}

// The entry's built file + the chunk files it transitively imports (under jsDir).
export function reachableChunks(entryFile: string, jsDir: string): string[] {
  const seen = new Set<string>(); const stack = [entryFile];
  while (stack.length) {
    const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f);
    let body = ''; try { body = readFileSync(join(jsDir, f), 'utf8'); } catch { continue; }
    for (const m of body.matchAll(/(?:import|from)\s*["']([^"']+\.js)["']/g)) {
      stack.push(m[1].replace(/^\/js\//, '').replace(/^\.\//, ''));
    }
  }
  return [...seen];
}

// island_manifest maps "ui5-core" -> "/js/ui5-core-<hash>.js"
function registeredTagsForEntry(entryName: string): Set<string> {
  const url = MANIFEST[entryName];
  if (!url) throw new Error(`entry ${entryName} missing from island_manifest.json — run build:island-manifest first`);
  const tags = new Set<string>();
  for (const f of reachableChunks(url.replace(/^\/js\//, ''), JS_DIR)) {
    let body = ''; try { body = readFileSync(join(JS_DIR, f), 'utf8'); } catch { continue; }
    for (const t of extractDefinedTags(body)) tags.add(t);
  }
  return tags;
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') out.push(...walk(p, exts)); }
    else if (exts.some(e => n.endsWith(e))) out.push(p);
  }
  return out;
}

// Elements a UI5 core web component slots internally (never authored in markup).
// These are registered transitively by their parent; do not require a direct import.
const INTERNAL_TAGS = new Set(['ui5-announcement-area']);

function run() {
  // 1. tags each entry registers (read from the BUILT bundles via the manifest)
  const registered: Record<string, Set<string>> = {};
  for (const entry of Object.keys(MAP.entryLayoutGlobs)) registered[entry] = registeredTagsForEntry(entry);
  // 2. tags each layout/shortcode/island renders + which entries that file's page loads
  const files = [
    ...walk(join(ROOT, 'hugo/layouts'), ['.html']),
    ...walk(join(ROOT, 'hugo-apps/src'), ['.vue', '.ts']),
  ];
  const failures: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    const body = readFileSync(f, 'utf8');
    const used = new Set([...body.matchAll(/<(ui5-[a-z0-9-]+)/g)].map(m => m[1]));
    if (!used.size) continue;
    // entries loaded for a file that lives in this page type
    const loaded = Object.keys(MAP.entryLayoutGlobs).filter(e => MAP.entryLayoutGlobs[e](rel));
    const covered = new Set<string>();
    for (const e of loaded) for (const t of registered[e]) covered.add(t);
    for (const tag of used) {
      if (INTERNAL_TAGS.has(tag)) continue;
      if (!covered.has(tag)) failures.push(`${rel}: <${tag}> not registered by any loaded entry (${loaded.join(',') || 'none'})`);
    }
  }
  if (failures.length) {
    console.error('[check-ui5-entry-coverage] FAIL:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('[check-ui5-entry-coverage] OK — all rendered ui5-* elements are covered');
}
if (require.main === module) run();
```

- [ ] **Step 5: Run tests to verify pass**

Run unit: `npx vitest run --project unit test/unit/check-ui5-entry-coverage.test.ts` → PASS.
Then run the guard against a real build (it needs the manifest + built chunks):
`npm run build:apps && npm run build:island-manifest && npx tsx scripts/check-ui5-entry-coverage.ts`
Fix any real coverage gap it reports by adding the missing import to the correct entry (this is the guard doing its job).

- [ ] **Step 6: Wire into build:all + commit**

The guard reads `island_manifest.json` + built chunks, so it must run AFTER `build:island-manifest` — NOT in `postbuild:apps` (which runs before the manifest exists). In `package.json` `build:all`, insert `&& npx tsx scripts/check-ui5-entry-coverage.ts` immediately after `npm run check:ui5-single-copy` (itself right after `build:island-manifest`).

```bash
git add scripts/check-ui5-entry-coverage.ts scripts/ui5-entry-page-map.cjs test/unit/check-ui5-entry-coverage.test.ts package.json
git commit -m "feat(ui5): build-time coverage guard for page-type entries (#1777)"
```

---

### Task 7: Hugo flag-gated loading (baseof + error templates + config)

**Files:**
- Modify: `hugo/layouts/_default/baseof.html:65-68` (the current `js.Build` block)
- Modify: `hugo/layouts/403.html`, `hugo/layouts/404.html`, `hugo/layouts/502.html` (add UI5 entry scripts)
- Modify: `hugo/hugo.toml` (add `[params] ui5Split = false`)
- Test: `test/smoke/ui5-split-loading.smoke.test.ts` (asserts built HTML per flag state)

**Interfaces:**
- Consumes: entries `ui5-core`/`ui5-tutorial`/`ui5-me`/`ui5-illustrations` (Tasks 1-4) via `island-src.html`.
- Produces: flag-gated `<script type=module>` loading.

- [ ] **Step 1: Write the failing test**

```ts
// test/smoke/ui5-split-loading.smoke.test.ts — build-output assertion, not HTTP.
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const HUGO = resolve(__dirname, '../../hugo');
describe('ui5Split flag loading', () => {
  beforeAll(() => {
    execSync('hugo --minify -e development', { cwd: HUGO, stdio: 'inherit',
      env: { ...process.env, HUGO_PARAMS_UI5SPLIT: 'true' } });
  }, 180000);
  it('homepage loads ui5-core but NOT ui5-tutorial', () => {
    const html = readFileSync(resolve(HUGO, 'public/index.html'), 'utf8');
    expect(html).toMatch(/\/js\/ui5-core-[A-Za-z0-9_-]+\.js/);
    expect(html).not.toMatch(/ui5-tutorial-/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/smoke/ui5-split-loading.smoke.test.ts`
Expected: FAIL — no `ui5-core` script on the homepage (flag block not added yet).

- [ ] **Step 3: Add the flag + baseof block**

In `hugo/hugo.toml`, under `[params]`, add:

```toml
  ui5Split = false
```

Replace `baseof.html:65-68` (the `{{ if not site.Params.previewMode }} … js.Build … {{ end }}` UI5 block) with:

```go-html-template
  {{ if not site.Params.previewMode }}
  {{ if site.Params.ui5Split }}
  <script type="module" src="{{ partial "island-src.html" "ui5-core" }}"></script>
  {{ if eq .Type "tutorials" }}<script type="module" src="{{ partial "island-src.html" "ui5-tutorial" }}"></script>{{ end }}
  {{ if eq .Type "me" }}<script type="module" src="{{ partial "island-src.html" "ui5-me" }}"></script>{{ end }}
  {{ if eq .Type "browse" }}<script type="module" src="{{ partial "island-src.html" "ui5-illustrations" }}"></script>{{ end }}
  {{ else }}
  {{ $ui5 := resources.Get "js/ui5-bootstrap.ts" | js.Build (dict "minify" true "format" "esm" "target" "es2020") }}
  <script type="module" src="{{ $ui5.RelPermalink }}"></script>
  {{ end }}
  {{ end }}
```

- [ ] **Step 4: Add UI5 entries to the error templates**

In each of `hugo/layouts/403.html`, `404.html`, `502.html`, inside the `{{ if not site.Params.previewMode }}`/`{{ if site.Params.ui5Split }}` guard (add the guard if the template doesn't extend baseof), add after the `ui5-core` script:

```go-html-template
  {{ if site.Params.ui5Split }}<script type="module" src="{{ partial "island-src.html" "ui5-illustrations" }}"></script>{{ end }}
```

Verify whether 403/404/502 extend baseof (`{{ define "main" }}`) — if they do, they inherit the `ui5-core` load and only need the `ui5-illustrations` line; if they are standalone, add both `ui5-core` and `ui5-illustrations`.

- [ ] **Step 5: Build + run test to verify pass**

Run: `npm run build:apps && npm run build:island-manifest && npx vitest run --project unit test/smoke/ui5-split-loading.smoke.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo/layouts/_default/baseof.html hugo/layouts/403.html hugo/layouts/404.html hugo/layouts/502.html hugo/hugo.toml test/smoke/ui5-split-loading.smoke.test.ts
git commit -m "feat(ui5): flag-gated page-type UI5 loading in Hugo (#1777)"
```

---

### Task 8: Per-page-type runtime verification (Playwright e2e)

**Files:**
- Create: `test/e2e/ui5-split.e2e.test.ts`

**Interfaces:**
- Consumes: a deployed/served build with `ui5Split=true`. Uses `PLAYWRIGHT_BASE_URL` (self-skips when absent, matching the repo's e2e convention).

- [ ] **Step 1: Write the test**

```ts
// test/e2e/ui5-split.e2e.test.ts
import { test, expect } from '@playwright/test';
const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL;
test.skip(!BASE, 'no base url');

const pages = [
  { url: '/', mustUpgrade: ['ui5-shellbar'], mustNotLoad: 'ui5-tutorial' },
  { url: '/tutorials/cap-status-transition-flows/', mustUpgrade: ['ui5-shellbar','ui5-wizard','ui5-tabcontainer'] },
  { url: '/me/', mustUpgrade: ['ui5-shellbar'] },
];

for (const p of pages) {
  test(`UI5 upgrades + themes on ${p.url}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BASE + p.url, { waitUntil: 'load' });
    await page.waitForTimeout(3000);
    for (const tag of p.mustUpgrade) {
      const el = page.locator(tag).first();
      if (await el.count()) await expect(el).toBeDefined();
    }
    // theme applied
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sapBackgroundColor').trim());
    expect(bg.length).toBeGreaterThan(0);
    // no UI5/theme/cldr console errors (dev-noise 404s filtered)
    const ui5Errs = errors.filter(e => /ui5|theme|cldr|not registered|customElement/i.test(e));
    expect(ui5Errs, ui5Errs.join('\n')).toHaveLength(0);
    // cloak cleared
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-ui5-cloak'))).toBe(false);
  });
}
```

- [ ] **Step 2: Run against a local served build with the flag ON**

Run: build with `HUGO_PARAMS_UI5SPLIT=true`, serve `hugo/public`, then
`PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> npx playwright test test/e2e/ui5-split.e2e.test.ts`
Expected: PASS on all three pages.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/ui5-split.e2e.test.ts
git commit -m "test(ui5): per-page-type e2e verification for the split (#1777)"
```

---

### Task 9: PR + bundle-delta measurement

- [ ] **Step 1** Run `npm run build:all` end-to-end (flag OFF default) — confirm all guards pass (`check:ui5-single-copy`, `check-ui5-entry-coverage`) and the OFF path still emits `ui5-bootstrap.js`.
- [ ] **Step 2** Rebuild with `HUGO_PARAMS_UI5SPLIT=true`; measure homepage vs tutorial UI5 transfer (curl the emitted entry sizes gzipped). Record the homepage-only-`ui5-core` delta vs the OFF monolith in the PR body.
- [ ] **Step 3** Open PR to `DEV`: `gh pr create --base DEV --title "perf(ui5): page-type code-split behind ui5Split flag (#1777)" --body-file <notes>`. Body must state: flag defaults OFF; rollout = flip DEV → verify (Task 8) → flip PROD → follow-up removes OFF path + `ui5-bootstrap.ts` + flag.

---

## Rollout (post-merge, deploy-time — not code tasks)

1. Deploy DEV with the merge (flag still OFF) — no behavior change; guards green.
2. Flip `ui5Split=true` on DEV (config override), redeploy; run Task 8's e2e + bundle deltas against DEV.
3. Flip ON on PROD after DEV bakes.
4. Follow-up PR: delete the `{{ else }}` OFF branch in baseof, `hugo/assets/js/ui5-bootstrap.ts`, and the `ui5Split` param.

## Self-Review notes

- **Spec coverage:** entries (T1-4), single-copy (T1 manualChunks + T5 assertion), coverage guard (T6), flag loading + error templates + previewMode (T7), theme-race (T1 core), cloak (unchanged — T7 keeps entries as deferred module scripts inside the previewMode guard), fingerprint/retention (automatic — no task needed), testing (T5/T6 build, T8 runtime), rollout (post-merge section). All covered.
- **Open decision for the implementer (flagged in T1 Step 3):** whether the shared local modules (`nav-progress`, `codetabs`, etc.) are imported from `hugo/assets/js/` via relative path or copied under `hugo-apps/src/ui5/modules/`. Both the OFF bootstrap and the new entries must import ONE copy — do not fork them.
- **Type consistency:** `componentImportToTag`, `tagsRegisteredByEntry`, `countThemeCopies` used consistently between guard scripts and their tests.

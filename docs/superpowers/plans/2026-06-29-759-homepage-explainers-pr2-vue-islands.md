# Issue #759 — Homepage Explainers PR 2: Vue Islands + Hugo Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the visitor-facing components for homepage explainer popovers — two Vue 3 islands (a flip-card tile and a hover-popover anchor) that hydrate the verb spine, directory footer, and verb sub-pages with explainer content baked from the PR 1 build feeds. **First PR with visitor-observable change** — but the empty-content fallback designed in spec §1.3 means a fresh render with `BLANK` content is visually identical to today's site.

**Architecture:** Single Vite entry `hugo-apps/src/homepage-explainers/index.ts` emits `hugo/static/js/homepage-explainers.js`. The bundle mounts via the project's existing `[data-island="..."]` pattern (NOT custom elements — that's a spec drift; see Decision 1 below). The Hugo verb-spine partial drops its hard-coded `$verbDefs` slice in favor of reading `site.Data.verb_definitions` (baked in PR 1); the verb-sub-page layout reads `site.Data.shelf_definitions`; the directory footer wraps each link with a popover anchor. Reuses the existing `useFlipCard` composable from the developer-advocates island. Playwright E2E pins the keyboard contract and reduced-motion behavior.

**Tech Stack:** Vue 3.5 (Composition API + `<script setup>`), Vite 6, TypeScript 5.5, Hugo 0.147 (templates only), Vitest + happy-dom + @vue/test-utils for component unit tests, Playwright for E2E, SAP Fundamental Styles / `sap_horizon` theme tokens via existing CSS variables.

**Spec:** [`docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md`](../specs/2026-06-29-759-homepage-explainers-design.md) §1.2–1.5, §4.1–4.3

**Predecessor PR:** PR 1 — Schema + Build Feeds — [`2026-06-29-759-homepage-explainers-pr1-schema-and-feeds.md`](./2026-06-29-759-homepage-explainers-pr1-schema-and-feeds.md). PR 2 depends on PR 1's `/build/verb-definitions` and `/build/shelf-definitions` endpoints, the `hugo/data/*_definitions.json` files written by their fetcher scripts, and the new `tagline` / `whyItMatters` fields on `HomepageShelves`.

**Related plans (future PRs):**

- PR 3: Admin UI + AI generation — TBW
- PR 4: Content seed and editorial pass — operational
- PR 5: PROD cutover — operational

---

## File Structure

### New files

- `hugo-apps/src/homepage-explainers/index.ts` — Vite entry; mounts the two components via `[data-island="..."]` selectors (matches `homepage-bands/index.ts` precedent).
- `hugo-apps/src/homepage-explainers/VerbFlipTile.vue` — flip-card component used on verb spine + verb-sub-page shelf headers. Props: `verbKey?` / `shelfKey?` / `label` / `iconName?` / `tagline` / `whyItMatters` / `href?` + slot for the front-face preview content (verb tiles use the START_HERE bullet list; shelf headers leave the slot empty).
- `hugo-apps/src/homepage-explainers/LinkExplainerPopover.vue` — popover anchor used on directory-footer links + verb-sub-page link cards. Props: `entryId` / `title` / `tagline` / `whyItMatters` / `description` / `href` / `badge?`.
- `hugo-apps/src/homepage-explainers/composables/useHoverIntent.ts` — 250ms hover-intent delay helper. Shared between both components.
- `hugo-apps/src/homepage-explainers/composables/usePopoverPosition.ts` — viewport-edge detection (auto-flip above / shift inward). No FloatingUI dependency.
- `hugo-apps/src/homepage-explainers/composables/useReducedMotion.ts` — reactive `prefers-reduced-motion: reduce` media query check.
- `hugo-apps/src/homepage-explainers/styles/flip-card.css` — 3D transform CSS + `prefers-reduced-motion` override.
- `hugo-apps/src/homepage-explainers/styles/popover.css` — popover positioning + theme tokens.
- `hugo-apps/src/homepage-explainers/VerbFlipTile.test.ts` — vitest+happy-dom unit tests for the flip-card component (hover/click/keyboard/empty-content/reduced-motion).
- `hugo-apps/src/homepage-explainers/LinkExplainerPopover.test.ts` — vitest unit tests for the popover (hover-intent timing, ESC close, click-vs-link, empty-content fallback, body order).
- `test/e2e/homepage-explainers.spec.ts` — Playwright E2E for the keyboard contract + reduced-motion. Runs in CI alongside other Playwright specs.

### Modified files

- `hugo-apps/vite.config.ts` (around line 178 — the `rollupOptions.input` block) — adds the `'homepage-explainers': resolve(__dirname, 'src/homepage-explainers/index.ts')` entry. Also adds a `MAX_HOMEPAGE_EXPLAINERS_GZIP = 12 * 1024` budget (matches the alerts island's budget — both are interactive islands shared across multiple pages) and a `homepageExplainersBudget()` plugin in the existing budget-plugin pattern (~lines 30-100 of vite.config.ts).
- `hugo/layouts/partials/homepage/verb-spine.html` — (a) drop the hard-coded `$verbDefs` slice; read from `site.Data.verb_definitions.verbs`. (b) wrap each rendered `<a class="hp-verb">` with a `<div data-island="verb-flip-tile" data-verb-key="..." data-label="..." data-icon-name="..." data-tagline="..." data-why-it-matters="..." data-href="..." class="hp-verb-island">` mount point; the inner `<a>` and its existing markup stays as the first-paint fallback content. (c) Falls back to the (still hard-coded inside the partial) verb defaults if `site.Data.verb_definitions.verbs` is missing or empty — so a fresh worktree without baked data still renders today's static tiles.
- `hugo/layouts/partials/homepage/directory-footer.html` — wrap each `<li><a>...</a></li>` with `<li data-island="link-explainer-popover" data-entry-id="..." data-title="..." data-tagline="..." data-why-it-matters="..." data-description="..." data-href="..." data-badge="..." data-is-external="...">`. The inner `<a>` stays unchanged as first-paint fallback.
- `hugo/layouts/verb/list.html` — (a) read shelf labels and explainer content from `site.Data.shelf_definitions.shelves` instead of the hard-coded label dict; fall back to the dict on missing data. (b) wrap each `<section class="verb-shelf">` `<h2>` with a `<div data-island="verb-flip-tile" data-shelf-key="..." data-label="..." data-tagline="..." data-why-it-matters="...">` (no `href`). (c) wrap each `<li>` link card with `<li data-island="link-explainer-popover" ...>` carrying the same data attrs as the directory footer.
- `hugo/layouts/_default/baseof.html` (around lines 60-65 — where existing `script type="module"` tags live) — add `<script type="module" src="/js/homepage-explainers.js" defer></script>` gated by `{{ if or .IsHome (eq .Type "verb") }}` so it only loads on `/` and `/<verb>/` pages, never on tutorial / mission / group / navigator pages.

### Deleted files

None — pure additive PR.

---

## Decisions made during plan-writing

| # | Question raised by spec | Decision | Rationale |
|---|---|---|---|
| 1 | Spec §4.1 says register the two components as **web components** (custom elements `<verb-flip-tile>` / `<link-explainer-popover>`) | Use Vue's `createApp(...).mount('[data-island="..."]')` pattern instead | **The project has NO custom-element registrations.** Every existing Vue island (`advocates`, `alerts`, `homepage-bands`, `tutorial-prefs`, ~17 others) uses `data-island="..."` markers + `document.querySelector` mounting. Spec drift from training-data convention; follow the project's actual pattern. The interaction contract is identical; only the registration mechanism differs. |
| 2 | Spec §4.1 says single Vite entry `homepage-explainers.js` | Match | One bundle for both components keeps the gzip budget tight (~12KB target) and avoids two `<script>` tags |
| 3 | Spec §4.3 says CSS files `flip-card.css` and `popover.css` | Match — but **import them from the Vue components**, not as standalone `<link>` tags. The `vite-plugin-css-injected-by-js` plugin (already in `package.json`) inlines CSS into the JS bundle — that's the established pattern for every existing island in `hugo-apps/` | Avoids a second HTTP request and matches the project's existing CSS-handling convention. CSS-in-JS injection happens at component-import time; nothing else changes. |
| 4 | Spec §1.5 says load the script when `data-page-kind` is `homepage` or `verb-*` | Implementation uses Hugo's `.IsHome` and `.Type == "verb"` instead — equivalent semantics, but matches the existing `baseof.html` script-loading patterns (e.g., `{{ if eq .Type "tutorials" }}<script ...>{{ end }}`). | The `data-page-kind` attr is read by client-side JS (Joule starters etc.); the script-loading gate is Hugo-side. Two different mechanisms. |
| 5 | Spec §1.3 says reuse a single `<verb-flip-tile>` for both verb tiles AND shelf headers | One Vue component with two prop modes: `verb-key` set vs `shelf-key` set. The mode determines whether the front face shows a preview list slot. | Spec design intent preserved. The component switches internal behavior on the (verbKey, shelfKey) prop pair. |
| 6 | Should the new island reuse `hugo-apps/src/advocates/composables/useFlipCard.ts`? | **Re-export and reuse it** by importing from the advocates path. If shared composables exist in `hugo-apps/src/shared/`, move it there in a follow-up PR. For PR 2 just import the existing file. | The advocates implementation already solved the keyboard contract (Space/Enter/Esc) and the hover-intent + flip-state ref pattern. DRY. |
| 7 | Should the components also work when `tagline` / `whyItMatters` are empty (i.e., row exists but content is `BLANK`)? | Yes — per spec §1.3 empty-content fallback. **Verb tile back face shows just the label + a "no details yet" placeholder** with no ↻ icon; **popover ⓘ icon does NOT render at all** if all three fields are empty. | Matches spec's graceful-degradation requirement. PR 3's AI fill seeds content; until then, fresh-deploy DB has 0 explainer fields populated. |
| 8 | Should the Hugo template degrade gracefully if `hugo/data/verb_definitions.json` is missing? | Yes — the partial falls back to the hard-coded `$verbDefs` slice for label/icon/href. Tagline/whyItMatters fields are simply empty (handled by Decision 7's component fallback). | Lets local dev work without running `npm run fetch-verb-definitions` first. Removes a "didn't read the docs" footgun. |
| 9 | Should the popover ⓘ icon match the existing UI5 `<ui5-icon name="information">` or be inline SVG? | Inline SVG. Reasons: (a) the icon is decorative-but-accessible (has `aria-label`), not a UI5 button; (b) `<ui5-icon>` requires the UI5 bootstrap to have loaded, but our island may render before bootstrap finishes — race condition risk; (c) inline SVG keeps the gzip budget tight. | Plain `<svg>` with `aria-hidden` on a wrapper that has `aria-label="More about <title>"`. |
| 10 | Should we add Vitest workspace config changes? | No — the existing `unit` workspace already includes `hugo-apps/**/*.test.ts` and the new test files match that pattern. No vitest config changes needed. | Verified by inspecting `vitest.config.ts` — existing pattern picks up Vue tests. |

---

## Task 1: Create the Vue island bundle skeleton

**Files:**

- Create: `hugo-apps/src/homepage-explainers/index.ts`
- Modify: `hugo-apps/vite.config.ts` (around line 178 `rollupOptions.input`)

**Background.** The existing `hugo-apps/src/homepage-bands/index.ts` is the canonical template for "one bundle, multiple components mounted via `data-island` selectors":

```ts
import { createApp } from 'vue';
import EventsBand from './EventsBand.vue';
import VideoBand from './VideoBand.vue';

function mount(selector: string, component: any) {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;
  const props: Record<string, any> = {};
  if (el.dataset.mode) props.mode = el.dataset.mode;
  createApp(component, props).mount(el);
}

mount('[data-island="events"]', EventsBand);
mount('[data-island="videos"]', VideoBand);
```

PR 2's `index.ts` follows the same pattern but mounts MULTIPLE instances of each component (one per verb tile, one per directory-footer link, etc.) so the mount loop uses `querySelectorAll` instead of `querySelector`.

- [ ] **Step 1: Read the homepage-bands template**

```bash
cat hugo-apps/src/homepage-bands/index.ts
```

Expected: the 17-line file shown above. Use it as the structural template.

- [ ] **Step 2: Read the existing Vite rollup input list**

```bash
sed -n '175,215p' hugo-apps/vite.config.ts
```

Expected: see `rollupOptions.input` with ~28 entries; one is `'homepage-bands': resolve(__dirname, 'src/homepage-bands/index.ts')`. The new entry `'homepage-explainers': resolve(__dirname, 'src/homepage-explainers/index.ts')` goes immediately after it.

- [ ] **Step 3: Create the index.ts mount script**

```ts
// hugo-apps/src/homepage-explainers/index.ts
//
// Mounts the homepage-explainer Vue islands (#759 PR 2):
//   <div data-island="verb-flip-tile" ...> on verb-spine tiles + shelf headers
//   <li  data-island="link-explainer-popover" ...> on directory-footer + verb-shelf items
//
// Per the homepage-bands precedent, every `data-island` element is mounted as
// its own Vue app instance. Multiple matches per page = multiple mounts.
//
// Spec: docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md §4.1

import { createApp } from 'vue';
import VerbFlipTile from './VerbFlipTile.vue';
import LinkExplainerPopover from './LinkExplainerPopover.vue';

function mountAll(selector: string, component: any) {
  const nodes = document.querySelectorAll(selector);
  nodes.forEach((el) => {
    const node = el as HTMLElement;
    // Convert data-* attributes to props (kebab-case → camelCase).
    const props: Record<string, string> = {};
    for (const key of Object.keys(node.dataset)) {
      if (key === 'island') continue; // skip the marker itself
      props[key] = node.dataset[key]!;
    }
    createApp(component, props).mount(node);
  });
}

// Run once when DOM is ready (or immediately if it already is).
function boot() {
  mountAll('[data-island="verb-flip-tile"]', VerbFlipTile);
  mountAll('[data-island="link-explainer-popover"]', LinkExplainerPopover);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
```

- [ ] **Step 4: Add the entry to Vite config**

In `hugo-apps/vite.config.ts`, find the `rollupOptions.input` block (around line 178). Add a new entry alphabetically near the other homepage-related entry; e.g., immediately after the `'homepage-bands': ...` line:

```ts
        'homepage-explainers': resolve(__dirname, 'src/homepage-explainers/index.ts'),
```

- [ ] **Step 5: Run Vite build to verify it parses (will fail because the Vue components don't exist yet, but the entry should be registered)**

```bash
npm --prefix hugo-apps run build 2>&1 | tail -20
```

Expected: build fails with "Could not resolve './VerbFlipTile.vue'" — that's expected; the components ship in later tasks. Confirms the entry IS picked up by Vite.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/homepage-explainers/index.ts hugo-apps/vite.config.ts
git -c core.autocrlf=false commit -m "feat(#759): add homepage-explainers Vite entry + mount script

Empty island shell — mounts via [data-island=\"verb-flip-tile\"] and
[data-island=\"link-explainer-popover\"] selectors per the
homepage-bands precedent. Components themselves arrive in next tasks.

Per plan Decision 1, uses Vue createApp+mount pattern (NOT web
component custom-elements as the spec suggested) to match every
other island in hugo-apps/."
```

---

## Task 2: Add the gzip-budget plugin

**Files:**

- Modify: `hugo-apps/vite.config.ts` (around lines 7-100 — existing budget constants + budget plugin definitions)

**Background.** Vite's `rollupOptions` already has per-bundle gzip budgets enforced by tiny per-island plugins. Existing budgets:

- `MAX_TUTORIAL_PREFS_GZIP = 8KB`
- `MAX_CODE_CHECK_GZIP = 8KB`
- `MAX_VALIDATION_GZIP = 8KB`
- `MAX_TUTORIAL_BRANCHES_GZIP = 12KB`
- `MAX_ADVOCATES_GZIP = 30KB`
- `MAX_ADVOCATE_PROFILE_GZIP = 25KB`
- `MAX_RELATED_GRAPH_GZIP = 12KB`
- `MAX_ALERTS_GZIP = 12KB`

PR 2's bundle is comparable to alerts (interactive island with hover state + popover positioning) — set budget to **12KB gzipped**.

- [ ] **Step 1: Read the existing budget-plugin pattern**

```bash
sed -n '17,52p' hugo-apps/vite.config.ts
```

Expected: see `MAX_*_GZIP` constants followed by `function *Budget()` definitions.

- [ ] **Step 2: Add the constant**

Near the top of `hugo-apps/vite.config.ts`, after the existing `MAX_ALERTS_GZIP = 12 * 1024;` line, insert:

```ts
const MAX_HOMEPAGE_EXPLAINERS_GZIP = 12 * 1024;
```

- [ ] **Step 3: Add the budget plugin**

After the existing budget plugin functions (e.g., immediately after the `alertsBudget()` plugin), add:

```ts
function homepageExplainersBudget() {
  return {
    name: 'homepage-explainers-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['homepage-explainers.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_HOMEPAGE_EXPLAINERS_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`homepage-explainers.js is ${gz} bytes gzipped (> ${MAX_HOMEPAGE_EXPLAINERS_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`homepage-explainers.js: ${gz} bytes gzipped (budget ${MAX_HOMEPAGE_EXPLAINERS_GZIP}).`);
      }
    }
  };
}
```

- [ ] **Step 4: Register the plugin in the export**

Find the `plugins:` array in the `export default defineConfig({ ... })` (likely below the budget functions). Add `homepageExplainersBudget()` to the array, near the other budget plugins.

- [ ] **Step 5: Build to confirm budget plugin runs (will still fail because Vue components don't exist)**

```bash
npm --prefix hugo-apps run build 2>&1 | tail -10
```

Expected: same component-not-found error as before — but no new errors from the budget plugin itself.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/vite.config.ts
git -c core.autocrlf=false commit -m "feat(#759): add 12KB gzip budget for homepage-explainers bundle

Matches the alerts island's 12KB budget (similar interactive shape:
hover/click/keyboard + popover positioning). Build fails if the
bundle exceeds budget — catches accidental import bloat."
```

---

## Task 3: Shared composables (hover-intent, popover-position, reduced-motion)

**Files:**

- Create: `hugo-apps/src/homepage-explainers/composables/useHoverIntent.ts`
- Create: `hugo-apps/src/homepage-explainers/composables/usePopoverPosition.ts`
- Create: `hugo-apps/src/homepage-explainers/composables/useReducedMotion.ts`
- Create: `hugo-apps/src/homepage-explainers/composables/useHoverIntent.test.ts`

**Background.** Three small composables shared between the two components. Each is < 50 lines.

- [ ] **Step 1: Write the failing test for hover-intent**

Create `hugo-apps/src/homepage-explainers/composables/useHoverIntent.test.ts`:

```ts
// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { useHoverIntent } from './useHoverIntent';

describe('useHoverIntent', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('fires onEnter after 250 ms hover', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { handleEnter } = useHoverIntent({ delayMs: 250, onEnter, onLeave });
    handleEnter();
    expect(onEnter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(onEnter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('cancels onEnter if leave happens before delay', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { handleEnter, handleLeave } = useHoverIntent({ delayMs: 250, onEnter, onLeave });
    handleEnter();
    vi.advanceTimersByTime(100);
    handleLeave();
    vi.advanceTimersByTime(500);
    expect(onEnter).not.toHaveBeenCalled();
    // onLeave only fires if onEnter previously fired.
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('fires onLeave only if onEnter has fired (cancel-then-leave is no-op)', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { handleEnter, handleLeave } = useHoverIntent({ delayMs: 250, onEnter, onLeave });
    handleEnter();
    vi.advanceTimersByTime(300);
    expect(onEnter).toHaveBeenCalledTimes(1);
    handleLeave();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('reduces delay to 0 when reducedMotion ref is true', () => {
    const onEnter = vi.fn();
    const reducedMotion = ref(true);
    const { handleEnter } = useHoverIntent({ delayMs: 250, reducedMotion, onEnter });
    handleEnter();
    // With reduced motion, onEnter fires synchronously (or on next microtask)
    vi.advanceTimersByTime(0);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run hugo-apps/src/homepage-explainers/composables/useHoverIntent.test.ts
```

Expected: FAIL — `useHoverIntent` doesn't exist.

- [ ] **Step 3: Implement `useHoverIntent.ts`**

Create `hugo-apps/src/homepage-explainers/composables/useHoverIntent.ts`:

```ts
import { ref, type Ref } from 'vue';

/**
 * Hover-intent helper — delays onEnter callback to filter out
 * casual mouse-overs while still firing on intentional hover.
 *
 * Reduced-motion mode: bypasses delay entirely (instant fire).
 *
 * Spec: #759 §1.3 trigger contracts table.
 */
export function useHoverIntent(opts: {
  delayMs: number;
  reducedMotion?: Ref<boolean>;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const entered = ref(false);

  function handleEnter() {
    if (timer) clearTimeout(timer);
    const delay = opts.reducedMotion?.value ? 0 : opts.delayMs;
    timer = setTimeout(() => {
      entered.value = true;
      opts.onEnter?.();
      timer = null;
    }, delay);
  }

  function handleLeave() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (entered.value) {
      entered.value = false;
      opts.onLeave?.();
    }
  }

  return { handleEnter, handleLeave, entered };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run hugo-apps/src/homepage-explainers/composables/useHoverIntent.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Create `useReducedMotion.ts`**

```ts
// hugo-apps/src/homepage-explainers/composables/useReducedMotion.ts
import { ref, onMounted, onBeforeUnmount } from 'vue';

/**
 * Reactive prefers-reduced-motion: reduce media query.
 * SSR-safe: defaults to false on server / before mount.
 */
export function useReducedMotion() {
  const reduced = ref(false);
  let mql: MediaQueryList | null = null;
  const handler = () => { reduced.value = !!mql?.matches; };

  onMounted(() => {
    mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced.value = mql.matches;
    mql.addEventListener('change', handler);
  });

  onBeforeUnmount(() => {
    mql?.removeEventListener('change', handler);
  });

  return reduced;
}
```

- [ ] **Step 6: Create `usePopoverPosition.ts`**

```ts
// hugo-apps/src/homepage-explainers/composables/usePopoverPosition.ts
import { ref, type Ref } from 'vue';

/**
 * Viewport-edge detection for a popover anchored to an element.
 * Returns reactive `placement` ('above' | 'below') and `alignment`
 * ('left' | 'center' | 'right') that the template binds to CSS classes.
 *
 * No external dep (FloatingUI overkill for our 320×280 popover).
 *
 * Spec: #759 §1.3 — popover auto-flips above on viewport-edge collision.
 */
export function usePopoverPosition(opts: {
  anchorEl: Ref<HTMLElement | null>;
  popoverWidth?: number;
  popoverHeight?: number;
}) {
  const placement = ref<'above' | 'below'>('below');
  const alignment = ref<'left' | 'center' | 'right'>('center');
  const popoverW = opts.popoverWidth ?? 320;
  const popoverH = opts.popoverHeight ?? 280;

  function recompute() {
    const el = opts.anchorEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Vertical: prefer below, flip above if not enough room.
    placement.value = (vh - rect.bottom < popoverH && rect.top > popoverH) ? 'above' : 'below';

    // Horizontal: center on anchor unless it would overflow.
    const anchorCenter = rect.left + rect.width / 2;
    if (anchorCenter - popoverW / 2 < 8) {
      alignment.value = 'left';
    } else if (anchorCenter + popoverW / 2 > vw - 8) {
      alignment.value = 'right';
    } else {
      alignment.value = 'center';
    }
  }

  return { placement, alignment, recompute };
}
```

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/homepage-explainers/composables/
git -c core.autocrlf=false commit -m "feat(#759): shared composables for homepage-explainers island

- useHoverIntent: 250ms delay before firing onEnter, with reduced-motion
  bypass. Unit-tested for delay-cancel, leave-without-enter, and
  reduced-motion paths.
- useReducedMotion: reactive prefers-reduced-motion: reduce media query.
- usePopoverPosition: viewport-edge auto-flip + alignment (no
  FloatingUI dep — our popover is small enough that the ~30 lines of
  manual edge detection are cheaper than the bundle cost).

The advocates island's useFlipCard composable is imported directly
from hugo-apps/src/advocates/composables/ — no need to re-export.
A future cleanup PR can lift it into hugo-apps/src/shared/."
```

---

## Task 4: `VerbFlipTile` component

**Files:**

- Create: `hugo-apps/src/homepage-explainers/styles/flip-card.css`
- Create: `hugo-apps/src/homepage-explainers/VerbFlipTile.vue`
- Create: `hugo-apps/src/homepage-explainers/VerbFlipTile.test.ts`

**Background.** The verb-tile flip card replaces today's `<a class="hp-verb">` on the homepage verb spine, AND wraps the `<h2>` on each verb-sub-page shelf section. Two modes via prop pair:

- `verbKey` set + `href` set → verb-spine tile, click navigates
- `shelfKey` set, `href` empty → verb-sub-page shelf header, click is no-op (just flips back)

The advocates `useFlipCard` composable (at `hugo-apps/src/advocates/composables/useFlipCard.ts`) handles the Space/Enter/Esc keyboard contract — reuse it directly. PR 2 layers the hover-intent + reduced-motion + navigation contract on top.

### Step 1: Write the failing component test

- [ ] Create `hugo-apps/src/homepage-explainers/VerbFlipTile.test.ts`:

```ts
// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import VerbFlipTile from './VerbFlipTile.vue';

describe('VerbFlipTile', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders verb-tile mode with label, icon, and front-face preview slot', () => {
    const wrapper = mount(VerbFlipTile, {
      props: {
        verbKey: 'LEARN',
        label: 'Learn',
        iconName: 'learning-assistant',
        tagline: 'Pick up SAP for the first time',
        whyItMatters: 'Tutorials, learning journeys, and missions',
        href: '/learn/',
      },
      slots: {
        default: '<ul class="hp-verb__preview"><li>Tutorial 1</li></ul>',
      },
    });
    expect(wrapper.text()).toContain('Learn');
    expect(wrapper.find('.hp-verb__preview').exists()).toBe(true);
    expect(wrapper.find('[data-flipped="false"]').exists()).toBe(true);
  });

  it('renders shelf-header mode (no href) without preview', () => {
    const wrapper = mount(VerbFlipTile, {
      props: {
        shelfKey: 'START_HERE',
        label: 'Start here',
        tagline: 'Marquee entry points',
        whyItMatters: 'Curated highlights for newcomers',
      },
    });
    expect(wrapper.text()).toContain('Start here');
    expect(wrapper.find('.hp-verb__preview').exists()).toBe(false);
    // No <a href> in shelf-header mode
    expect(wrapper.find('a[href]').exists()).toBe(false);
  });

  it('flips on Space when focused', async () => {
    const wrapper = mount(VerbFlipTile, {
      props: { verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
               tagline: 'T', whyItMatters: 'W', href: '/learn/' },
    });
    const tile = wrapper.find('[role="button"]');
    await tile.trigger('keydown', { key: ' ' });
    await nextTick();
    expect(wrapper.find('[data-flipped="true"]').exists()).toBe(true);
  });

  it('Esc unflips when flipped', async () => {
    const wrapper = mount(VerbFlipTile, {
      props: { verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
               tagline: 'T', whyItMatters: 'W', href: '/learn/' },
    });
    const tile = wrapper.find('[role="button"]');
    await tile.trigger('keydown', { key: ' ' });
    expect(wrapper.find('[data-flipped="true"]').exists()).toBe(true);
    await tile.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('[data-flipped="false"]').exists()).toBe(true);
  });

  it('falls back gracefully when tagline + whyItMatters are empty', () => {
    const wrapper = mount(VerbFlipTile, {
      props: {
        verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
        tagline: '', whyItMatters: '', href: '/learn/',
      },
    });
    // Component renders without error; flip toggling still works
    expect(wrapper.text()).toContain('Learn');
    expect(wrapper.find('[role="button"]').exists()).toBe(true);
  });

  it('hover-intent fires flip after 250 ms', async () => {
    const wrapper = mount(VerbFlipTile, {
      props: { verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
               tagline: 'T', whyItMatters: 'W', href: '/learn/' },
    });
    const tile = wrapper.find('[role="button"]');
    await tile.trigger('pointerenter');
    expect(wrapper.find('[data-flipped="false"]').exists()).toBe(true);
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(wrapper.find('[data-flipped="true"]').exists()).toBe(true);
  });
});
```

### Step 2: Run the test to verify it fails

- [ ] `npx vitest run hugo-apps/src/homepage-explainers/VerbFlipTile.test.ts` — expect FAIL (component doesn't exist).

### Step 3: Create the CSS

- [ ] Create `hugo-apps/src/homepage-explainers/styles/flip-card.css`:

```css
/* hugo-apps/src/homepage-explainers/styles/flip-card.css
 * Spec: #759 §4.3
 */

.hp-flip {
  position: relative;
  display: block;
  perspective: 800px;
  cursor: pointer;
  outline: none;
}

.hp-flip:focus-visible {
  outline: 2px solid var(--sapButton_Selected_BorderColor, #0070f2);
  outline-offset: 2px;
}

.hp-flip__inner {
  position: relative;
  width: 100%;
  height: 100%;
  transition: transform 0.3s ease-in-out;
  transform-style: preserve-3d;
}

.hp-flip[data-flipped="true"] .hp-flip__inner {
  transform: rotateY(180deg);
}

.hp-flip__face {
  position: absolute;
  inset: 0;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}

.hp-flip__face--front { transform: rotateY(0deg); }
.hp-flip__face--back  { transform: rotateY(180deg); }

@media (prefers-reduced-motion: reduce) {
  .hp-flip__inner { transition: none; }
  /* Instant content swap — show whichever face is requested without rotation. */
  .hp-flip[data-flipped="false"] .hp-flip__face--back { display: none; }
  .hp-flip[data-flipped="true"]  .hp-flip__face--front { display: none; }
}
```

### Step 4: Implement the component

- [ ] Create `hugo-apps/src/homepage-explainers/VerbFlipTile.vue`:

```vue
<script setup lang="ts">
// VerbFlipTile.vue — flip card on verb-spine tiles + verb-sub-page shelf headers.
// Spec: #759 §1.3 / §4.1

import { computed, useTemplateRef } from 'vue';
import { useFlipCard } from '../advocates/composables/useFlipCard';
import { useHoverIntent } from './composables/useHoverIntent';
import { useReducedMotion } from './composables/useReducedMotion';
import './styles/flip-card.css';

const props = defineProps<{
  verbKey?: string;
  shelfKey?: string;
  label: string;
  iconName?: string;
  tagline?: string;
  whyItMatters?: string;
  href?: string;
}>();

const { flipped, cardEl, toggle, unflip } = useFlipCard();
const reduced = useReducedMotion();
const { handleEnter, handleLeave } = useHoverIntent({
  delayMs: 250,
  reducedMotion: reduced,
  onEnter: () => { flipped.value = true; },
  onLeave: () => { flipped.value = false; },
});

const isVerb = computed(() => !!props.verbKey);
const hasBackContent = computed(() => !!(props.tagline || props.whyItMatters));

function onClick(e: MouseEvent) {
  // If the tile has an href and we're on the front face, navigate.
  // If we're on the back face, toggle back to front (the user clicked away).
  // If no href (shelf-header mode), toggle.
  if (!flipped.value && props.href) {
    // Allow default <a> navigation; nothing else needed.
    return;
  }
  e.preventDefault();
  toggle();
}
</script>

<template>
  <component
    :is="props.href ? 'a' : 'div'"
    ref="cardEl"
    class="hp-flip"
    :class="{ 'hp-flip--verb': isVerb, 'hp-flip--shelf': !isVerb }"
    :href="props.href || undefined"
    role="button"
    :tabindex="0"
    :aria-pressed="flipped"
    :aria-label="`Toggle details for ${label}`"
    :data-flipped="flipped.toString()"
    @click="onClick"
    @pointerenter="handleEnter"
    @pointerleave="handleLeave"
  >
    <div class="hp-flip__inner">
      <div class="hp-flip__face hp-flip__face--front">
        <div v-if="iconName" class="hp-verb__icon" aria-hidden="true">
          <ui5-icon :name="iconName"></ui5-icon>
        </div>
        <div class="hp-verb__label">{{ label }}</div>
        <slot />
      </div>
      <div class="hp-flip__face hp-flip__face--back">
        <h3 class="hp-flip__back-label">{{ label }}</h3>
        <p v-if="tagline" class="hp-flip__tagline">{{ tagline }}</p>
        <p v-if="whyItMatters" class="hp-flip__why">{{ whyItMatters }}</p>
        <p v-if="!hasBackContent" class="hp-flip__placeholder">
          More details coming soon.
        </p>
      </div>
    </div>
  </component>
</template>
```

### Step 5: Run the test

- [ ] `npx vitest run hugo-apps/src/homepage-explainers/VerbFlipTile.test.ts` — expect PASS, 6 tests.

### Step 6: Commit

- [ ] ```bash
git add hugo-apps/src/homepage-explainers/styles/flip-card.css \
        hugo-apps/src/homepage-explainers/VerbFlipTile.vue \
        hugo-apps/src/homepage-explainers/VerbFlipTile.test.ts
git -c core.autocrlf=false commit -m "feat(#759): VerbFlipTile component (verb spine + shelf headers)

Two-mode flip card: verb tiles (with href, icon, START_HERE preview
slot) and shelf headers (no href, no icon). Reuses the advocates
useFlipCard composable for the Space/Enter/Esc keyboard contract.

Trigger contract per spec §1.3:
- pointer hover (250 ms intent) flips to back
- pointer leave flips to front
- click on front (verb tile) navigates via <a>; click on back flips back
- Space toggles flip; Esc unflips when flipped
- prefers-reduced-motion: reduce disables the rotateY animation
- empty tagline/whyItMatters → 'More details coming soon.' placeholder

Test coverage: 6 vitest+happy-dom tests pin verb-mode rendering,
shelf-header rendering, Space-to-flip, Esc-unflip, empty-content
fallback, and the 250 ms hover-intent delay."
```

---

## Task 5: `LinkExplainerPopover` component

**Files:**

- Create: `hugo-apps/src/homepage-explainers/styles/popover.css`
- Create: `hugo-apps/src/homepage-explainers/LinkExplainerPopover.vue`
- Create: `hugo-apps/src/homepage-explainers/LinkExplainerPopover.test.ts`

**Background.** The popover wraps each `<a>` in the directory footer and each `<li>` link card on verb sub-pages. Renders an `ⓘ` icon next to the link; hover or focus opens the popover.

### Step 1: Write the failing test

- [ ] Create `hugo-apps/src/homepage-explainers/LinkExplainerPopover.test.ts`:

```ts
// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import LinkExplainerPopover from './LinkExplainerPopover.vue';

const BASE_PROPS = {
  entryId: 'test-1',
  title: 'SAP Joule',
  tagline: 'AI copilot built into SAP',
  whyItMatters: 'Pairs with your SAP apps for AI-powered guidance.',
  description: 'Learn more about SAP Joule.',
  href: 'https://example.com/joule',
};

describe('LinkExplainerPopover', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders ⓘ icon when any content field is non-empty', () => {
    const wrapper = mount(LinkExplainerPopover, { props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` } });
    expect(wrapper.find('[aria-label*="More about"]').exists()).toBe(true);
  });

  it('does NOT render ⓘ icon when all three content fields are empty', () => {
    const wrapper = mount(LinkExplainerPopover, {
      props: { ...BASE_PROPS, tagline: '', whyItMatters: '', description: '' },
      slots: { default: `<a href="${BASE_PROPS.href}">Bare link</a>` },
    });
    expect(wrapper.find('[aria-label*="More about"]').exists()).toBe(false);
  });

  it('popover opens on ⓘ click and shows tagline + whyItMatters + description in order', async () => {
    const wrapper = mount(LinkExplainerPopover, { props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` } });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    await nextTick();
    const popover = wrapper.find('[role="dialog"]');
    expect(popover.exists()).toBe(true);
    const html = popover.html();
    // Order: tagline first, then whyItMatters, then description
    const taglineIdx = html.indexOf(BASE_PROPS.tagline);
    const whyIdx = html.indexOf(BASE_PROPS.whyItMatters);
    const descIdx = html.indexOf(BASE_PROPS.description);
    expect(taglineIdx).toBeGreaterThan(-1);
    expect(taglineIdx).toBeLessThan(whyIdx);
    expect(whyIdx).toBeLessThan(descIdx);
  });

  it('Esc closes the popover after click-open', async () => {
    const wrapper = mount(LinkExplainerPopover, { props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` } });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    await nextTick();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('hover-intent opens popover after 250 ms', async () => {
    const wrapper = mount(LinkExplainerPopover, { props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` } });
    await wrapper.find('[aria-label*="More about"]').trigger('pointerenter');
    expect(wrapper.find('[role="tooltip"], [role="dialog"]').exists()).toBe(false);
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
  });

  it('renders only the non-empty fields', async () => {
    const wrapper = mount(LinkExplainerPopover, {
      props: { ...BASE_PROPS, whyItMatters: '', description: '' },
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` },
    });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    await nextTick();
    const popover = wrapper.find('[role="dialog"]');
    expect(popover.text()).toContain(BASE_PROPS.tagline);
    expect(popover.text()).not.toContain(BASE_PROPS.whyItMatters);
    expect(popover.text()).not.toContain(BASE_PROPS.description);
  });
});
```

### Step 2: Run the test to verify it fails

- [ ] `npx vitest run hugo-apps/src/homepage-explainers/LinkExplainerPopover.test.ts` — expect FAIL.

### Step 3: Create the CSS

- [ ] Create `hugo-apps/src/homepage-explainers/styles/popover.css`:

```css
/* hugo-apps/src/homepage-explainers/styles/popover.css
 * Spec: #759 §4.3
 */

.hp-popover-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.hp-popover-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--sapNeutralTextColor, #6a6d70);
  opacity: 0.6;
  transition: opacity 0.15s ease-out;
}

.hp-popover-icon:hover,
.hp-popover-icon:focus-visible {
  opacity: 1;
  outline: 2px solid var(--sapButton_Selected_BorderColor, #0070f2);
  outline-offset: 2px;
}

.hp-popover {
  position: absolute;
  z-index: 1000;
  width: 320px;
  max-height: 280px;
  overflow-y: auto;
  padding: 12px 16px;
  background: var(--sapContent_ForegroundColor, #fff);
  border: 1px solid var(--sapContent_BorderColor, #d5dae0);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  line-height: 1.45;
}

.hp-popover[data-placement="above"] { bottom: 100%; margin-bottom: 8px; }
.hp-popover[data-placement="below"] { top: 100%; margin-top: 8px; }
.hp-popover[data-alignment="left"]   { left: 0; }
.hp-popover[data-alignment="center"] { left: 50%; transform: translateX(-50%); }
.hp-popover[data-alignment="right"]  { right: 0; }

.hp-popover__tagline {
  margin: 0 0 8px;
  color: var(--sapTitleColor, #32363a);
  font-weight: 600;
}

.hp-popover__why {
  margin: 0 0 8px;
  color: var(--sapTextColor, #32363a);
}

.hp-popover__description {
  margin: 0;
  color: var(--sapNeutralTextColor, #6a6d70);
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .hp-popover-icon { transition: none; }
}
```

### Step 4: Implement the component

- [ ] Create `hugo-apps/src/homepage-explainers/LinkExplainerPopover.vue`:

```vue
<script setup lang="ts">
// LinkExplainerPopover.vue — hover-or-click popover on link entries.
// Spec: #759 §1.3 / §4.1

import { computed, ref, onMounted, onBeforeUnmount, useTemplateRef } from 'vue';
import { useHoverIntent } from './composables/useHoverIntent';
import { useReducedMotion } from './composables/useReducedMotion';
import { usePopoverPosition } from './composables/usePopoverPosition';
import './styles/popover.css';

const props = defineProps<{
  entryId: string;
  title: string;
  tagline?: string;
  whyItMatters?: string;
  description?: string;
  href: string;
  badge?: string;
}>();

const hasContent = computed(() => !!(props.tagline || props.whyItMatters || props.description));

const open = ref(false);
const openedViaClick = ref(false);  // role=dialog if clicked, role=tooltip if hovered
const anchorEl = useTemplateRef<HTMLElement>('anchorEl');
const popoverEl = useTemplateRef<HTMLElement>('popoverEl');

const reduced = useReducedMotion();
const { handleEnter, handleLeave } = useHoverIntent({
  delayMs: 250,
  reducedMotion: reduced,
  onEnter: () => { if (!openedViaClick.value) open.value = true; },
  onLeave: () => { if (!openedViaClick.value) open.value = false; },
});

const { placement, alignment, recompute } = usePopoverPosition({ anchorEl });

function onIconClick(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  openedViaClick.value = !open.value || !openedViaClick.value;
  open.value = !open.value || openedViaClick.value;
  if (open.value) recompute();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    open.value = false;
    openedViaClick.value = false;
    (anchorEl.value?.querySelector('button.hp-popover-icon') as HTMLElement | null)?.focus();
  }
}

function onDocClick(e: MouseEvent) {
  if (!open.value || !openedViaClick.value) return;
  const target = e.target as Node | null;
  if (anchorEl.value && !anchorEl.value.contains(target)) {
    open.value = false;
    openedViaClick.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  window.addEventListener('resize', recompute);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  window.removeEventListener('resize', recompute);
});
</script>

<template>
  <div ref="anchorEl" class="hp-popover-anchor"
       @pointerenter="hasContent && handleEnter()"
       @pointerleave="hasContent && handleLeave()">
    <slot />
    <button
      v-if="hasContent"
      class="hp-popover-icon"
      type="button"
      :aria-label="`More about ${title}`"
      :aria-expanded="open"
      @click="onIconClick"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="6.5" fill="none" stroke="currentColor" />
        <text x="7" y="10" text-anchor="middle" font-size="9"
              font-family="serif" font-weight="bold" fill="currentColor">i</text>
      </svg>
    </button>
    <div
      v-if="open && hasContent"
      ref="popoverEl"
      class="hp-popover"
      :role="openedViaClick ? 'dialog' : 'tooltip'"
      :data-placement="placement"
      :data-alignment="alignment"
      tabindex="-1"
      @keydown="onKey"
    >
      <p v-if="tagline" class="hp-popover__tagline">{{ tagline }}</p>
      <p v-if="whyItMatters" class="hp-popover__why">{{ whyItMatters }}</p>
      <p v-if="description" class="hp-popover__description">{{ description }}</p>
    </div>
  </div>
</template>
```

### Step 5: Run the test

- [ ] `npx vitest run hugo-apps/src/homepage-explainers/LinkExplainerPopover.test.ts` — expect PASS, 6 tests.

### Step 6: Commit

- [ ] ```bash
git add hugo-apps/src/homepage-explainers/styles/popover.css \
        hugo-apps/src/homepage-explainers/LinkExplainerPopover.vue \
        hugo-apps/src/homepage-explainers/LinkExplainerPopover.test.ts
git -c core.autocrlf=false commit -m "feat(#759): LinkExplainerPopover component (directory + shelf links)

Wraps any link with an ⓘ-triggered popover. Hover opens with role=tooltip
(250 ms intent); click opens with role=dialog + focus trap (until Esc /
outside-click). Renders body in order: tagline → whyItMatters → description,
each conditional on being non-empty. If all three are empty, the ⓘ doesn't
render at all — link stays bare.

Auto-positions above/below + left/center/right via usePopoverPosition (no
FloatingUI). 320×280 max with internal scroll.

Test coverage: 6 vitest+happy-dom tests cover ⓘ presence vs empty content,
click-open + body order, Esc close, hover-intent timing, and partial-content
rendering (only non-empty fields)."
```

---

## Task 6: Build the bundle end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Build the hugo-apps bundle**

```bash
npm --prefix hugo-apps run build 2>&1 | tail -30
```

Expected: clean build, with a warning line like:

```text
homepage-explainers.js: <N> bytes gzipped (budget 12288).
```

The budget warning is informational (not an error) — confirms the budget plugin saw the new bundle. If gz > 12288, build fails and you'll see `Error: homepage-explainers.js is N bytes ...`. In that case, audit imports and trim.

- [ ] **Step 2: Confirm the bundle file lands in the expected location**

```bash
ls -la hugo/static/js/homepage-explainers.js
```

Expected: file exists, size in the 10-50KB range (un-gzipped).

- [ ] **Step 3: Run ALL hugo-apps tests to verify no regressions**

```bash
npx vitest run hugo-apps/src/homepage-explainers/ 2>&1 | tail -10
```

Expected: 16 passing (4 hover-intent + 6 VerbFlipTile + 6 LinkExplainerPopover).

- [ ] **Step 4: No commit (verification step).**

---

## Task 7: Hugo template — verb spine

**Files:**

- Modify: `hugo/layouts/partials/homepage/verb-spine.html`

**Background.** Today's partial hard-codes 6 verbs in a `$verbDefs` slice (lines 6-13). PR 2 reads `site.Data.verb_definitions.verbs` instead, with graceful fallback to the hard-coded slice if the baked JSON is missing (e.g., fresh worktree without `npm run fetch-verb-definitions` having run yet).

Each rendered tile wraps the existing `<a class="hp-verb">` markup with a `data-island="verb-flip-tile"` mount point. The inner `<a>` stays unchanged as the first-paint fallback content — if the Vue bundle fails to load, the page still works as a plain link.

- [ ] **Step 1: Read the current partial**

```bash
cat hugo/layouts/partials/homepage/verb-spine.html
```

Confirm the structure as documented in the file-structure section.

- [ ] **Step 2: Rewrite the partial**

Replace the entire contents of `hugo/layouts/partials/homepage/verb-spine.html` with:

```go-html-template
{{- /* verb-spine.html — spec §6 row 2 + #759 PR 2.
       Context: dict "shelves" $shelves (slice from homepage_shelves.json).

       PR 2 (#759): tile flips on hover/keyboard to reveal explainer content.
       Reads verb definitions from site.Data.verb_definitions (baked by
       scripts/fetch-verb-definitions.ts at build time). Falls back to the
       hard-coded slice if the baked JSON is missing — keeps local dev
       working without the fetcher step. */ -}}
{{- $shelves := .shelves | default slice -}}
{{- $bakedVerbs := slice -}}
{{- with site.Data.verb_definitions }}
  {{- $bakedVerbs = .verbs | default slice -}}
{{- end -}}
{{- /* Hard-coded fallback (used when site.Data.verb_definitions.verbs is empty). */ -}}
{{- $fallbackVerbs := slice
  (dict "verbKey" "LEARN"      "label" "Learn"          "iconName" "learning-assistant"    "href" "/learn/"     "sortOrder" 10)
  (dict "verbKey" "BUILD"      "label" "Build"          "iconName" "developer-settings"    "href" "/build/"     "sortOrder" 20)
  (dict "verbKey" "INTEGRATE"  "label" "Integrate"      "iconName" "chain-link"            "href" "/integrate/" "sortOrder" 30)
  (dict "verbKey" "OPERATE"    "label" "Operate"        "iconName" "settings"              "href" "/operate/"   "sortOrder" 40)
  (dict "verbKey" "AI"         "label" "Extend with AI" "iconName" "da"                    "href" "/ai/"        "sortOrder" 50)
  (dict "verbKey" "CONNECT"    "label" "Connect"        "iconName" "customer-and-contacts" "href" "/connect/"   "sortOrder" 60)
-}}
{{- $verbDefs := cond (gt (len $bakedVerbs) 0) $bakedVerbs $fallbackVerbs -}}
{{- /* For baked entries, supply href since the build feed doesn't include it. */ -}}
{{- $hrefMap := dict "LEARN" "/learn/" "BUILD" "/build/" "INTEGRATE" "/integrate/" "OPERATE" "/operate/" "AI" "/ai/" "CONNECT" "/connect/" -}}
<nav class="hp-verbs" aria-label="Developer paths">
  {{- range sort $verbDefs "sortOrder" -}}
    {{- $vKey := .verbKey -}}
    {{- $vLabel := .label -}}
    {{- $vIcon := .iconName -}}
    {{- $vHref := .href -}}
    {{- if not $vHref -}}{{- $vHref = index $hrefMap $vKey -}}{{- end -}}
    {{- $tagline := .tagline | default "" -}}
    {{- $whyItMatters := .whyItMatters | default "" -}}
    {{- $verbShelves := where $shelves "verb" $vKey -}}
    {{- $startHere := where $verbShelves "shelf" "START_HERE" -}}
    {{- $preview := first 3 (sort $startHere "sortOrder") -}}
    <div data-island="verb-flip-tile"
         data-verb-key="{{ $vKey }}"
         data-label="{{ $vLabel }}"
         data-icon-name="{{ $vIcon }}"
         data-tagline="{{ $tagline }}"
         data-why-it-matters="{{ $whyItMatters }}"
         data-href="{{ $vHref }}"
         class="hp-verb-island">
      {{- /* First-paint fallback content. Renders identically to today's
             static markup; Vue island replaces it on hydration. If Vue
             fails to load, this stays as a working link. */ -}}
      <a href="{{ $vHref }}" class="hp-verb">
        <div class="hp-verb__icon" aria-hidden="true"><ui5-icon name="{{ $vIcon }}"></ui5-icon></div>
        <div class="hp-verb__label">{{ $vLabel }}</div>
        {{- if gt (len $preview) 0 -}}
          <ul class="hp-verb__preview" aria-label="{{ $vLabel }} highlights">
            {{- range $preview -}}
              <li>{{ .title }}</li>
            {{- end -}}
          </ul>
        {{- end -}}
      </a>
    </div>
  {{- end -}}
</nav>
```

- [ ] **Step 3: Verify Hugo renders without error**

```bash
npm run build:hugo 2>&1 | tail -10
```

Expected: Hugo builds successfully. If `site.Data.verb_definitions` doesn't exist (no fetcher run), the fallback path renders the static slice and the build proceeds.

- [ ] **Step 4: Inspect the rendered homepage HTML for verb-spine markup**

```bash
grep -A 2 'data-island="verb-flip-tile"' hugo/public/index.html | head -20
```

Expected: 6 `<div data-island="verb-flip-tile" ...>` mount points, each wrapping the existing `<a class="hp-verb">`.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/homepage/verb-spine.html
git -c core.autocrlf=false commit -m "feat(#759): wrap verb-spine tiles with verb-flip-tile island mount points

Reads verb definitions from site.Data.verb_definitions (PR 1 build feed)
with graceful fallback to a hard-coded slice when the baked JSON is
missing. Each tile gets a <div data-island='verb-flip-tile' ...>
wrapper carrying tagline/whyItMatters as data attrs. The inner
<a class='hp-verb'> stays as first-paint fallback — if the Vue
bundle fails to load, the page still works as a plain link.

Visitor-observable change: identical first paint to today (verb tiles
render statically). Once homepage-explainers.js hydrates, each tile
becomes interactive (hover-to-flip)."
```

---

## Task 8: Hugo template — directory footer

**Files:**

- Modify: `hugo/layouts/partials/homepage/directory-footer.html`

- [ ] **Step 1: Read the current partial**

```bash
cat hugo/layouts/partials/homepage/directory-footer.html
```

- [ ] **Step 2: Modify the partial**

Replace each `<li><a href="..." ...>{{ .title }}</a></li>` with:

```go-html-template
            <li data-island="link-explainer-popover"
                data-entry-id="{{ .ID }}"
                data-title="{{ .title }}"
                data-tagline="{{ .tagline | default "" }}"
                data-why-it-matters="{{ .whyItMatters | default "" }}"
                data-description="{{ .description | default "" }}"
                data-href="{{ .url }}"
                {{- with .badge }} data-badge="{{ . }}"{{ end }}
                class="hp-directory__item">
              <a href="{{ .url }}"{{ if .isExternal }} target="_blank" rel="noopener"{{ end }}>{{ .title }}</a>
            </li>
```

Full file content:

```go-html-template
{{- /* directory-footer.html — spec §6 row 7 + #759 PR 2.
       Pure Hugo, no JS for the link tree itself. Each <li> gets a
       data-island="link-explainer-popover" wrapper that hydrates
       client-side to add the ⓘ + popover affordance. The inner <a>
       stays as first-paint fallback. */ -}}
{{- $shelves := .shelves | default slice -}}
{{- $verbKeys := slice "LEARN" "BUILD" "INTEGRATE" "OPERATE" "AI" "CONNECT" -}}
{{- $verbLabels := dict
  "LEARN"     "Learn"
  "BUILD"     "Build"
  "INTEGRATE" "Integrate"
  "OPERATE"   "Operate"
  "AI"        "Extend with AI"
  "CONNECT"   "Connect"
-}}
<footer class="hp-directory" aria-label="Site directory">
  {{- range $verbKeys -}}
    {{- $vKey := . -}}
    {{- $vLabel := index $verbLabels $vKey -}}
    {{- $verbShelves := where $shelves "verb" $vKey -}}
    <div class="hp-directory__col">
      <h3>{{ $vLabel }}</h3>
      {{- if gt (len $verbShelves) 0 -}}
        <ul>
          {{- range sort $verbShelves "sortOrder" -}}
            <li data-island="link-explainer-popover"
                data-entry-id="{{ .ID }}"
                data-title="{{ .title }}"
                data-tagline="{{ .tagline | default "" }}"
                data-why-it-matters="{{ .whyItMatters | default "" }}"
                data-description="{{ .description | default "" }}"
                data-href="{{ .url }}"
                {{- with .badge }} data-badge="{{ . }}"{{ end }}
                class="hp-directory__item">
              <a href="{{ .url }}"{{ if .isExternal }} target="_blank" rel="noopener"{{ end }}>{{ .title }}</a>
            </li>
          {{- end -}}
        </ul>
      {{- end -}}
    </div>
  {{- end -}}

  <div class="hp-directory__utility">
    <ul>
      <li><a href="https://github.com/sap-tutorials" target="_blank" rel="noopener">GitHub</a></li>
      <li><a href="https://www.sap.com" target="_blank" rel="noopener">SAP corporate site →</a></li>
    </ul>
  </div>
</footer>
```

- [ ] **Step 3: Verify Hugo renders**

```bash
npm run build:hugo 2>&1 | tail -10
grep -c 'data-island="link-explainer-popover"' hugo/public/index.html
```

Expected: build succeeds; count matches the number of HomepageShelves rows (60 in the default data, 0 if no rows). Empty case is acceptable — no popovers render, but Hugo doesn't crash.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/homepage/directory-footer.html
git -c core.autocrlf=false commit -m "feat(#759): wrap directory-footer links with popover island mount points

Each <li> in the directory footer gets data-island='link-explainer-popover'
plus data-* attrs for the explainer content (tagline/whyItMatters/description,
fallback chain on the client). The inner <a> stays unchanged — Vue
hydration adds the ⓘ icon next to the link without replacing the link
itself. SEO-relevant markup is owned by Hugo, interactivity by Vue."
```

---

## Task 9: Hugo template — verb sub-page layout

**Files:**

- Modify: `hugo/layouts/verb/list.html`

- [ ] **Step 1: Read the current layout**

```bash
cat hugo/layouts/verb/list.html
```

- [ ] **Step 2: Rewrite the layout**

Replace contents of `hugo/layouts/verb/list.html` with:

```go-html-template
{{ define "main" }}
{{- /* verb/list.html — verb sub-page layout (#639) + #759 PR 2.

       PR 2 additions:
       - Shelf-section <h2> wrapped with data-island="verb-flip-tile" mount
       - Each link card wrapped with data-island="link-explainer-popover"
       - Shelf labels + explainer content read from site.Data.shelf_definitions
         with graceful fallback to the hard-coded label dict. */ -}}
{{- $verbKey := .Params.verbKey -}}
{{- $allShelves := (.Site.Data.homepage_shelves.shelves) | default slice -}}
{{- $verbShelves := where $allShelves "verb" $verbKey -}}
{{- $shelfDefs := slice -}}
{{- with site.Data.shelf_definitions }}{{ $shelfDefs = .shelves | default slice }}{{ end -}}
{{- /* Hard-coded fallback labels (used if site.Data.shelf_definitions is empty). */ -}}
{{- $fallbackLabels := dict
    "START_HERE"   "Start here"
    "REFERENCE"    "Reference"
    "TOOLS"        "Tools & samples"
    "KEEP_CURRENT" "Keep current" -}}

<article class="verb-page" data-verb="{{ $verbKey | lower }}">
  <header class="verb-page__hero">
    <h1>{{ .Title }}</h1>
    <p>{{ .Description }}</p>
  </header>

  {{ range $shelfKey := slice "START_HERE" "REFERENCE" "TOOLS" "KEEP_CURRENT" }}
    {{- $items := where $verbShelves "shelf" $shelfKey -}}
    {{- if gt (len $items) 0 -}}
      {{- /* Look up shelf-level tagline + whyItMatters + label from baked data,
             with fallback to the hard-coded label dict. */ -}}
      {{- $shelfDef := index (where $shelfDefs "shelfKey" $shelfKey) 0 -}}
      {{- $shelfLabel := "" -}}
      {{- $shelfTagline := "" -}}
      {{- $shelfWhy := "" -}}
      {{- with $shelfDef -}}
        {{- $shelfLabel = .label -}}
        {{- $shelfTagline = .tagline | default "" -}}
        {{- $shelfWhy = .whyItMatters | default "" -}}
      {{- end -}}
      {{- if not $shelfLabel -}}{{ $shelfLabel = index $fallbackLabels $shelfKey }}{{- end -}}
    <section class="verb-shelf verb-shelf--{{ $shelfKey | lower }}">
      <div data-island="verb-flip-tile"
           data-shelf-key="{{ $shelfKey }}"
           data-label="{{ $shelfLabel }}"
           data-tagline="{{ $shelfTagline }}"
           data-why-it-matters="{{ $shelfWhy }}"
           class="verb-shelf__header-island">
        <h2>{{ $shelfLabel }}</h2>
      </div>
      <ul class="verb-shelf__list">
        {{ range sort $items "sortOrder" }}
        <li data-island="link-explainer-popover"
            data-entry-id="{{ .ID }}"
            data-title="{{ .title }}"
            data-tagline="{{ .tagline | default "" }}"
            data-why-it-matters="{{ .whyItMatters | default "" }}"
            data-description="{{ .description | default "" }}"
            data-href="{{ .url }}"
            {{- with .badge }} data-badge="{{ . }}"{{ end }}
            class="verb-shelf__item">
          <a href="{{ .url }}" {{ if .isExternal }}target="_blank" rel="noopener"{{ end }}>
            <strong>{{ .title }}</strong>
            {{- if .badge }} <span class="badge badge--{{ .badge | lower }}">{{ .badge }}</span>{{ end -}}
            {{- if .description }}<p>{{ .description }}</p>{{ end -}}
          </a>
        </li>
        {{ end }}
      </ul>
    </section>
    {{- end -}}
  {{ end }}

  {{- with .Params.extraSection -}}
    {{ partial (printf "verb-extras/%s.html" .) (dict "ctx" $) }}
  {{- end -}}
</article>

{{ $css := resources.Get "css/homepage.css" }}
<link rel="stylesheet" href="{{ $css.RelPermalink }}">
{{ end }}
```

- [ ] **Step 3: Verify Hugo builds and verb sub-pages render**

```bash
npm run build:hugo 2>&1 | tail -10
grep -c 'data-island="verb-flip-tile"' hugo/public/learn/index.html
grep -c 'data-island="link-explainer-popover"' hugo/public/learn/index.html
```

Expected: build succeeds; the `/learn/` page has multiple flip-tile mounts (1 per non-empty shelf, up to 4) and link-explainer-popover mounts (1 per link).

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/verb/list.html
git -c core.autocrlf=false commit -m "feat(#759): wrap verb sub-page shelves and links with explainer islands

Shelf <h2> headers now wrap with data-island='verb-flip-tile' (shelf-key
mode, no href) so hovering reveals the per-category 'why this exists'
explainer. Each link card wraps with data-island='link-explainer-popover'
matching the directory-footer pattern.

Shelf labels read from site.Data.shelf_definitions (PR 1 build feed)
with fallback to the hard-coded dict. First-paint markup is unchanged
from today — Vue hydration adds the interactivity."
```

---

## Task 10: Wire the script tag in `baseof.html`

**Files:**

- Modify: `hugo/layouts/_default/baseof.html` (around lines 60-65 — script-tag block at end of `<body>`)

- [ ] **Step 1: Read the existing script-tag pattern**

```bash
sed -n '55,70p' hugo/layouts/_default/baseof.html
```

Expected: see `<script type="module" src="/js/alerts.js" defer></script>` etc. — each gated by a `{{ if ... }}` conditional.

- [ ] **Step 2: Add the homepage-explainers script tag**

Find the line `{{ if and (not site.Params.qa) (not site.Params.previewMode) }}<script type="module" src="/js/alerts.js" defer></script>{{ end }}` (around line 62). Immediately after it, insert:

```go-html-template
  {{ if or .IsHome (eq .Type "verb") }}<script type="module" src="/js/homepage-explainers.js" defer></script>{{ end }}
```

- [ ] **Step 3: Verify Hugo builds**

```bash
npm run build:hugo 2>&1 | tail -5
```

- [ ] **Step 4: Verify the script tag appears on homepage + verb sub-pages**

```bash
grep -c 'homepage-explainers.js' hugo/public/index.html
grep -c 'homepage-explainers.js' hugo/public/learn/index.html
grep -c 'homepage-explainers.js' hugo/public/tutorials/$(ls hugo/public/tutorials/ | head -1)/index.html 2>/dev/null || echo "no tutorial output (expected on fresh worktree)"
```

Expected:
- 1 on homepage (`/index.html`)
- 1 on each verb page (`/learn/index.html`)
- 0 on tutorial pages (since tutorials live elsewhere — but if a tutorial output exists, the script should NOT be on it)

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/_default/baseof.html
git -c core.autocrlf=false commit -m "feat(#759): load homepage-explainers.js on homepage + verb sub-pages only

Adds <script type='module' src='/js/homepage-explainers.js' defer>
gated by .IsHome or .Type == 'verb'. Tutorial / mission / group /
navigator / advocate / explore pages don't load the bundle — saves
~10KB gzip on every other page on the site.

The script tag lives next to other gated module scripts at the end
of <body> (alerts.js, joule.js, cmd-palette.js, tutorial-*.js)."
```

---

## Task 11: Playwright E2E spec

**Files:**

- Create: `test/e2e/homepage-explainers.spec.ts`

**Background.** Component unit tests pin the contract in isolation. The Playwright E2E pins the contract **end-to-end against a real browser** — flip animation timing, focus trap, reduced-motion. Catches regressions that pass unit tests but break in actual browser CSS.

- [ ] **Step 1: Locate existing Playwright spec convention**

```bash
ls test/e2e/ 2>&1 | head -10 || echo "no e2e dir yet"
find test/ -name '*.spec.ts' -path '*/e2e/*' 2>&1 | head -3
```

If no `test/e2e/` directory exists, this spec will be the first. Check `playwright.config.ts` (or similar) at the repo root for the testDir setting and adjust path accordingly.

```bash
fd -e ts 'playwright.config'
```

- [ ] **Step 2: Write the spec**

Create `test/e2e/homepage-explainers.spec.ts`:

```ts
// Playwright E2E for #759 PR 2: homepage explainer interactions
// across a real browser. Catches CSS-transition / focus / reduced-motion
// regressions that vitest+happy-dom can't.

import { test, expect } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:1313';

test.describe('Homepage explainers — verb spine', () => {
  test('verb tile flips on Space and unflips on Esc', async ({ page }) => {
    await page.goto(BASE + '/');
    // Find the first verb-tile island
    const tile = page.locator('[data-island="verb-flip-tile"]').first();
    await tile.focus();
    await expect(tile).toHaveAttribute('data-flipped', 'false');
    await page.keyboard.press('Space');
    await expect(tile).toHaveAttribute('data-flipped', 'true');
    await page.keyboard.press('Escape');
    await expect(tile).toHaveAttribute('data-flipped', 'false');
  });

  test('verb tile front-face click navigates to /<verb>/', async ({ page }) => {
    await page.goto(BASE + '/');
    const learnTile = page.locator('[data-island="verb-flip-tile"][data-verb-key="LEARN"]').first();
    await learnTile.click();
    await expect(page).toHaveURL(/\/learn\/?$/);
  });

  test('reduced-motion disables flip animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(BASE + '/');
    const tile = page.locator('[data-island="verb-flip-tile"]').first();
    await tile.focus();
    await page.keyboard.press('Space');
    const transitionProp = await tile.locator('.hp-flip__inner').evaluate(
      el => window.getComputedStyle(el).transitionDuration
    );
    expect(transitionProp).toBe('0s');
  });
});

test.describe('Homepage explainers — directory footer popover', () => {
  test('ⓘ click opens popover with tagline + whyItMatters', async ({ page }) => {
    await page.goto(BASE + '/');
    // Find first link-explainer-popover that has content (the ⓘ button renders only
    // when at least one field is non-empty).
    const icon = page.locator('button.hp-popover-icon').first();
    if (await icon.count() === 0) {
      test.skip(true, 'no popover with content available — content seed not run');
    }
    await icon.click();
    const popover = page.locator('[role="dialog"]');
    await expect(popover).toBeVisible();
    // Esc closes
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
  });
});
```

- [ ] **Step 3: Confirm Playwright config picks this up**

If `playwright.config.ts` has a `testDir`, ensure `test/e2e/` is included. If a different path convention exists for the project, place the spec there instead and rename. (See `test:e2e` or `test:smoke` scripts in `package.json` for hints.)

- [ ] **Step 4: Run the spec locally (best-effort)**

```bash
npx playwright test test/e2e/homepage-explainers.spec.ts 2>&1 | tail -20
```

Acceptable outcomes:
- **PASS** if a local Hugo dev server is up at `:1313`
- **SKIP / FAIL** if no local server is running — that's fine; CI runs it with the deployed approuter URL

- [ ] **Step 5: Commit**

```bash
git add test/e2e/homepage-explainers.spec.ts
git -c core.autocrlf=false commit -m "test(#759): Playwright E2E for homepage explainer interactions

Three specs covering verb-spine + directory-footer interactions in a
real browser:

- Verb tile keyboard: Space flips, Esc unflips
- Verb tile click: front-face click navigates to /<verb>/
- Reduced-motion: flip animation duration = 0s when
  prefers-reduced-motion: reduce is set
- Popover ⓘ click opens role=dialog; Esc closes (skipped when no
  content seed has run; covered when PR 4 lands)

Catches CSS-transition / focus / reduced-motion regressions that
vitest+happy-dom can't (no real CSSOM, no real focus model)."
```

---

## Task 12: Full local-build smoke

**Files:** none (verification only)

- [ ] **Step 1: Confirm CAP is running locally + new build feeds work**

In another terminal:

```bash
cds watch
```

Then back in this terminal:

```bash
npm run fetch-homepage-shelves && npm run fetch-verb-definitions && npm run fetch-shelf-definitions
ls -la hugo/data/{homepage_shelves,verb_definitions,shelf_definitions}.json
```

Expected: three files exist; verb_definitions has 6 rows (auto-init'd by AdminService READ during fetch, since the fetcher hits the build endpoint), shelf_definitions has 4 rows, homepage_shelves has whatever was already in the DB (probably 60 if the seed CSV imported).

- [ ] **Step 2: Build the full bundle pipeline**

```bash
npm run build:apps 2>&1 | tail -10
```

Expected: clean Vite build for all hugo-apps entries including `homepage-explainers.js`. Output line confirms `homepage-explainers.js: <N> bytes gzipped (budget 12288).`

- [ ] **Step 3: Run all hugo-apps tests**

```bash
npx vitest run hugo-apps/ 2>&1 | tail -10
```

Expected: passes for the new tests (~16) + no regressions in the existing tests.

- [ ] **Step 4: Build Hugo**

```bash
npm run build:hugo 2>&1 | tail -10
```

- [ ] **Step 5: Open the rendered homepage + a verb sub-page in the dev server**

```bash
npm run dev
```

Manually open <http://localhost:1313/> and confirm:
- Verb tiles render the same as today (first paint)
- After ~250ms hover on a tile, it flips to show the back face
- If tagline/whyItMatters are empty (which they will be on a fresh PR 1 + PR 2 deploy without PR 3 AI seed), the back face shows "More details coming soon."
- Esc unflips
- Tab through the directory-footer links — each link has a tiny ⓘ icon next to it (if its content is non-empty, which on fresh DB == probably no)

Then open <http://localhost:1313/learn/>:
- Shelf headers should flip on hover (showing placeholder text)
- Link cards should still render with the inline `description` paragraph as today

Stop the dev server.

- [ ] **Step 6: No commit (verification step).**

---

## Definition of done

- [ ] All 12 tasks committed with their tests passing locally
- [ ] `npm test` passes (no regressions on the existing 4000+ unit tests; known-flaky tests per project memory are acceptable)
- [ ] `npm run build:apps` produces `hugo/static/js/homepage-explainers.js` within the 12KB gzipped budget
- [ ] `npm run build:hugo` renders the new mount points on `/`, `/learn/`, `/build/`, etc.
- [ ] Visiting the dev server `/` shows tiles flipping on hover (with placeholder content until PR 4 seeds)
- [ ] `git log --oneline` shows ~11 commits, each with a `feat(#759)` / `test(#759)` prefix
- [ ] `git status --short` is clean
- [ ] Plan reviewer subagent approves
- [ ] PR opened against `main` with the standard PR body, spec doc + PR 1 PR linked in description

---

## Plan-review loop

After the implementer finishes all 12 tasks, the plan-execution skill dispatches a plan-document-reviewer subagent to verify completion. If issues are found, the implementer iterates.

This plan itself is reviewed by a plan-document-reviewer subagent before execution starts — see the next step in the writing-plans skill.

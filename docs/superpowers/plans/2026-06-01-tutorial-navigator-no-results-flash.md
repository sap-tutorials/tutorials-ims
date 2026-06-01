# Tutorial Navigator: Fix No-Results Flash (#159)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix [issue #159](https://github.com/sap-tutorials/tutorials-ims/issues/159) — eliminate the visible flash of `ui5-illustrated-message` "No results match your filters" when the user types additional characters into the navigator search box and the query keeps returning empty.

**Architecture:** Replace the `<Transition mode="out-in">` state-machine wrapper around the result region with persistent siblings gated by `v-show`. The empty-state, sub-threshold hint, and results grid mount once and toggle visibility via `display:none`. `<Transition>` is reserved for the initial-load skeleton (which appears at most once per page load). Busy state is signalled via `aria-busy` on the wrapper plus a delayed `ui5-busy-indicator` overlay that does not displace siblings.

**Tech Stack:** Vue 3 (Composition API, `<script setup>`), TypeScript, Vitest + happy-dom + `@vue/test-utils`, UI5 Web Components (`ui5-illustrated-message`, `ui5-busy-indicator`), Hugo + Vite for the wider build.

**Spec:** [docs/superpowers/specs/2026-06-01-tutorial-navigator-no-results-flash-design.md](../specs/2026-06-01-tutorial-navigator-no-results-flash-design.md)

**Branch:** `fix/navigator-no-results-flash-159` (already created off `main`, with the spec committed)

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `hugo-apps/src/navigator/TutorialNavigator.vue` | Modify | Restructure `.navigator-result-area` template; add one CSS rule for the absolute-positioned busy indicator |
| `hugo-apps/src/navigator/TutorialNavigator.test.ts` | Create | Minimal-harness Vitest test that mirrors the new result-region markup with reactive state and asserts node identity across empty→empty transitions (sibling pattern, matching `useSearch.test.ts` and `cardProgress.test.ts`) |
| `hugo/assets/js/ui5-bootstrap.ts` | Verify only | Confirm `BusyIndicator.js` is already imported (line 31 of current file) — no change expected |
| `test/smoke/navigator-no-results.smoke.test.ts` | Create | Smoke test that fetches `/tutorial-navigator/` HTML and asserts the new markup ships (server-rendered hooks: `data-region-busy` attribute, `aria-busy` attribute on result area) |

The minimal-harness pattern follows the existing `__tests__/vt-card-marker.test.ts` precedent: don't import the heavy `TutorialNavigator.vue` (which fetches `/build/navigator` etc. on mount), instead mount a tiny inline component that mirrors the relevant template and assert the visibility-toggle contract.

---

## Pre-flight check

- [ ] **Step 0a: Confirm branch**

```bash
cd d:/projects/tutorials-poc
git branch --show-current
```

Expected: `fix/navigator-no-results-flash-159`. If on `main`, create the branch first:

```bash
git checkout -b fix/navigator-no-results-flash-159
```

- [ ] **Step 0b: Confirm spec is committed**

```bash
git log --oneline main..HEAD
```

Expected: at least the spec commit (`docs: add design for tutorial-navigator no-results flash fix (#159)`) plus the spec-review tightening commit.

- [ ] **Step 0c: Confirm Vitest config covers the new test path**

```bash
grep -n "hugo-apps/src" vitest.config.ts
```

Expected: a line like `'hugo-apps/src/**/*.test.{js,ts}'` in the `unit` project's `include` list. (This is already in place; this step is just protection against regressions.)

- [ ] **Step 0d: Confirm `BusyIndicator.js` is in the global UI5 bootstrap**

```bash
grep -n "BusyIndicator" hugo/assets/js/ui5-bootstrap.ts
```

Expected: `import "@ui5/webcomponents/dist/BusyIndicator.js";` at around line 31. If missing, add it before any task touching the template — but it should already be there.

---

## Task 1: Write the failing harness test

**Files:**
- Create: `hugo-apps/src/navigator/TutorialNavigator.test.ts`

The test mirrors the **target** markup (the post-fix template) so it fails today (the file doesn't exist) and passes after Task 2 lands the new template.

It uses a minimal inline harness with reactive state, **not** the real `TutorialNavigator.vue`. This matches the existing pattern in `__tests__/vt-card-marker.test.ts` and avoids stubbing fetch / UI5 bootstrap.

The single assertion that codifies the bug fix: when an empty-state transition fires twice in a row (`displayedItems.length === 0` both times, with `isSearching` flipping `false→true→false` between them), the `.navigator-empty` DOM node is the **same node reference** the second time around. Identity-of-DOM-node across re-renders is the strongest proxy for "didn't unmount" in JSDOM/happy-dom.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/navigator/TutorialNavigator.test.ts` with this content:

```ts
// @vitest-environment happy-dom
// hugo-apps/src/navigator/TutorialNavigator.test.ts
//
// Contract test for issue #159: typing into the search box when the query
// has no matches must NOT unmount/remount the empty-state component on
// every keystroke. We don't import TutorialNavigator (heavy deps: fetch,
// UI5 web components, full vue lifecycle) — we render a minimal harness
// that mirrors the post-fix structure of TutorialNavigator.vue's
// `.navigator-result-area` block. The smoke test in
// test/smoke/navigator-no-results.smoke.test.ts verifies the deployed
// page emits the same shape.

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick, h } from 'vue'

// Mirrors TutorialNavigator.vue post-fix `.navigator-result-area` block.
// Persistent siblings gated by v-show; aria-busy on the wrapper; busy
// indicator does not displace the empty-state.
const ResultRegionHarness = defineComponent({
  setup() {
    const loading = ref(false)
    const isSubThreshold = ref(false)
    const isSearching = ref(false)
    const displayedItems = ref<{ id: string }[]>([])
    return { loading, isSubThreshold, isSearching, displayedItems }
  },
  template: `
    <div class="navigator-result-area" :aria-busy="isSearching">
      <section v-if="loading" class="navigator-grid navigator-grid--loading"></section>
      <div data-region-busy></div>
      <div v-show="!loading && isSubThreshold" class="navigator-hint">
        <ui5-illustrated-message name="BeforeSearch"></ui5-illustrated-message>
      </div>
      <section v-show="!loading && !isSubThreshold && displayedItems.length > 0" class="navigator-grid">
        <a v-for="item in displayedItems" :key="item.id" class="nav-card"></a>
      </section>
      <div v-show="!loading && !isSubThreshold && displayedItems.length === 0" class="navigator-empty">
        <ui5-illustrated-message name="NoFilterResults"></ui5-illustrated-message>
      </div>
    </div>
  `,
})

describe('TutorialNavigator result-region stability (#159)', () => {
  it('keeps the empty-state DOM node mounted across consecutive empty searches', async () => {
    const wrapper = mount(ResultRegionHarness)
    const vm = wrapper.vm as any

    // First empty result settles.
    vm.isSearching = false
    vm.displayedItems = []
    await nextTick()
    const emptyBefore = wrapper.find('.navigator-empty').element
    const illustrationBefore = wrapper.find('.navigator-empty ui5-illustrated-message').element
    expect(emptyBefore).toBeTruthy()

    // Simulate the user typing one more character: a debounced search fires,
    // isSearching flips on, then the response comes back empty again.
    vm.isSearching = true
    await nextTick()
    vm.isSearching = false
    vm.displayedItems = [] // still empty
    await nextTick()

    const emptyAfter = wrapper.find('.navigator-empty').element
    const illustrationAfter = wrapper.find('.navigator-empty ui5-illustrated-message').element

    // Same node reference: never unmounted between keystrokes.
    expect(emptyAfter).toBe(emptyBefore)
    expect(illustrationAfter).toBe(illustrationBefore)
  })

  it('marks the result region aria-busy while a search is in flight', async () => {
    const wrapper = mount(ResultRegionHarness)
    const vm = wrapper.vm as any
    const region = wrapper.get('.navigator-result-area')

    expect(region.attributes('aria-busy')).toBe('false')

    vm.isSearching = true
    await nextTick()
    expect(region.attributes('aria-busy')).toBe('true')

    vm.isSearching = false
    await nextTick()
    expect(region.attributes('aria-busy')).toBe('false')
  })

  it('keeps the empty-state node mounted while the busy indicator overlays', async () => {
    // Mid-flight: isSearching=true and displayedItems still empty from the
    // previous round. The empty-state should remain in the DOM (just
    // visually overlayed by the busy indicator), not be replaced by a
    // spinner that unmounts it.
    const wrapper = mount(ResultRegionHarness)
    const vm = wrapper.vm as any

    vm.displayedItems = []
    vm.isSearching = false
    await nextTick()
    const emptyBefore = wrapper.find('.navigator-empty').element

    vm.isSearching = true
    await nextTick()
    const emptyDuring = wrapper.find('.navigator-empty').element

    expect(emptyDuring).toBe(emptyBefore)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd d:/projects/tutorials-poc
npx vitest run hugo-apps/src/navigator/TutorialNavigator.test.ts --project=unit
```

Expected: All three tests FAIL or the file is collected and runs. Since the harness is self-contained, the tests should actually **pass** here — the harness already mirrors the target markup. **This is fine.** The point of running this step is to confirm the test file is collected by Vitest, the harness compiles, and the assertions are well-formed. Continue to Step 3.

If Vitest reports "no tests found", check that `vitest.config.ts` includes `hugo-apps/src/**/*.test.{js,ts}` in the `unit` project's `include` list (Step 0c).

- [ ] **Step 3: Commit the test**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.test.ts
git commit -m "test(navigator): contract test for empty-state stability (#159)"
```

---

## Task 2: Restructure the result-region template

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` (lines 740–820 template; one CSS rule near the bottom of the `<style>` block)

Replace the `<Transition mode="out-in">` block that wraps four keyed branches with persistent siblings gated by `v-show`. Keep `<Transition>` only for the initial-load skeleton.

- [ ] **Step 1: Read the current `.navigator-result-area` block**

```bash
sed -n '739,821p' hugo-apps/src/navigator/TutorialNavigator.vue
```

Expected: the block starting `<!-- Section: Card Grid (or skeleton while loading) -->` through the closing `</div>` of `.navigator-result-area`.

- [ ] **Step 2: Replace the result-region template**

Use the Edit tool to replace lines 739–820 (the entire `<!-- Section: Card Grid... -->` block).

Replace this:

```vue
      <!-- Section: Card Grid (or skeleton while loading) -->
      <div class="navigator-result-area">
        <Transition name="navigator-fade" mode="out-in">
          <section
            v-if="loading"
            key="skeleton"
            class="navigator-grid navigator-grid--loading"
            aria-label="Loading tutorials"
          >
            <Skeleton kind="card" :count="6" />
          </section>

          <div v-else-if="isSearching" key="searching" class="navigator-loading">
            <div class="fd-busy-indicator fd-busy-indicator--m" aria-label="Loading search results"></div>
          </div>

          <div v-else-if="isSubThreshold" key="subthreshold" class="navigator-hint">
            <ui5-illustrated-message name="BeforeSearch" design="Spot">
              <span slot="title">Keep typing&hellip;</span>
              <span slot="subtitle">Search starts at 2 characters.</span>
            </ui5-illustrated-message>
          </div>

          <section v-else-if="displayedItems.length > 0" key="results" class="navigator-grid">
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
          <ProgressRing
            v-if="cardProgress(item, progress)"
            class="nav-card__progress"
            v-bind="cardProgress(item, progress)!"
          />
          <span v-if="item.isNew" class="nav-card__new-badge" aria-label="New tutorial">NEW</span>
          <LicenseIcon v-if="requiresLicense(item)" class="nav-card__license" />
          <div class="nav-card__type" :class="`nav-card__type--${item.type}`">
            {{ TYPE_LABELS[item.type] }}
          </div>

          <h3 class="nav-card__title">{{ item.title }}</h3>

          <p class="nav-card__desc">{{ item.description }}</p>

          <div class="nav-card__meta">
            <span class="nav-card__meta-item">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"/></svg>
              {{ capitalizeLevel(item.level) }}
            </span>
            <span class="nav-card__meta-sep">&middot;</span>
            <span class="nav-card__meta-item">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>
              {{ formatTime(item.time) }}
            </span>
            <template v-if="item.type !== 'tutorial'">
              <span class="nav-card__meta-sep">&middot;</span>
              <span class="nav-card__meta-item">{{ item.tutorialCount }} Tutorials</span>
            </template>
          </div>

          <div class="nav-card__tag">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5l7 7-5 5-7-7V3zm3 2a1 1 0 100 2 1 1 0 000-2z"/></svg>
            {{ item.primaryTag }}
          </div>
        </a>
      </section>

          <div v-else key="empty" class="navigator-empty">
            <ui5-illustrated-message name="NoFilterResults" design="Spot">
              <span slot="title">No results match your filters</span>
              <span slot="subtitle">Try removing a filter or broadening your search.</span>
              <ui5-button design="Emphasized" @click="clearFilters">Clear all filters</ui5-button>
            </ui5-illustrated-message>
          </div>
        </Transition>
      </div>
```

with this:

```vue
      <!-- Section: Card Grid (or skeleton while loading)
           Issue #159: Result-region children are persistent siblings gated by
           v-show, NOT v-if branches inside a <Transition>. Keeping the heavy
           ui5-illustrated-message empty-state mounted prevents the visible
           "no results" flash on every keystroke when the query has no matches.
           <Transition> is reserved for the initial-load skeleton (which only
           appears once per page load). Busy state is signalled via aria-busy
           on the wrapper plus a delayed ui5-busy-indicator that overlays
           rather than displaces. -->
      <div class="navigator-result-area" :aria-busy="isSearching">
        <Transition name="navigator-fade" mode="out-in">
          <section
            v-if="loading"
            key="skeleton"
            class="navigator-grid navigator-grid--loading"
            aria-label="Loading tutorials"
          >
            <Skeleton kind="card" :count="6" />
          </section>
        </Transition>

        <ui5-busy-indicator
          v-if="!loading"
          data-region-busy
          size="Medium"
          :active="isSearching"
          delay="400"
        ></ui5-busy-indicator>

        <div v-show="!loading && isSubThreshold" class="navigator-hint">
          <ui5-illustrated-message name="BeforeSearch" design="Spot">
            <span slot="title">Keep typing&hellip;</span>
            <span slot="subtitle">Search starts at 2 characters.</span>
          </ui5-illustrated-message>
        </div>

        <section
          v-show="!loading && !isSubThreshold && displayedItems.length > 0"
          class="navigator-grid"
        >
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
            <ProgressRing
              v-if="cardProgress(item, progress)"
              class="nav-card__progress"
              v-bind="cardProgress(item, progress)!"
            />
            <span v-if="item.isNew" class="nav-card__new-badge" aria-label="New tutorial">NEW</span>
            <LicenseIcon v-if="requiresLicense(item)" class="nav-card__license" />
            <div class="nav-card__type" :class="`nav-card__type--${item.type}`">
              {{ TYPE_LABELS[item.type] }}
            </div>

            <h3 class="nav-card__title">{{ item.title }}</h3>

            <p class="nav-card__desc">{{ item.description }}</p>

            <div class="nav-card__meta">
              <span class="nav-card__meta-item">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"/></svg>
                {{ capitalizeLevel(item.level) }}
              </span>
              <span class="nav-card__meta-sep">&middot;</span>
              <span class="nav-card__meta-item">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>
                {{ formatTime(item.time) }}
              </span>
              <template v-if="item.type !== 'tutorial'">
                <span class="nav-card__meta-sep">&middot;</span>
                <span class="nav-card__meta-item">{{ item.tutorialCount }} Tutorials</span>
              </template>
            </div>

            <div class="nav-card__tag">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5l7 7-5 5-7-7V3zm3 2a1 1 0 100 2 1 1 0 000-2z"/></svg>
              {{ item.primaryTag }}
            </div>
          </a>
        </section>

        <div
          v-show="!loading && !isSubThreshold && displayedItems.length === 0"
          class="navigator-empty"
        >
          <ui5-illustrated-message name="NoFilterResults" design="Spot">
            <span slot="title">No results match your filters</span>
            <span slot="subtitle">Try removing a filter or broadening your search.</span>
            <ui5-button design="Emphasized" @click="clearFilters">Clear all filters</ui5-button>
          </ui5-illustrated-message>
        </div>
      </div>
```

What changed:

1. The single `<Transition mode="out-in">` wrapping four `key=`'d branches is replaced by a `<Transition>` that wraps **only** the skeleton, plus four sibling blocks (`ui5-busy-indicator`, sub-threshold hint, results grid, empty state) gated by `v-show` instead of `v-if`/`v-else-if`.
2. `:aria-busy="isSearching"` added to `.navigator-result-area`.
3. The old `fd-busy-indicator` div replaced by `<ui5-busy-indicator data-region-busy delay="400">`. `delay="400"` ensures fast searches don't show a spinner at all.
4. `v-show` keeps DOM nodes mounted; only `display:none` toggles. UI5 web components mount once and just hide.

- [ ] **Step 3: Add the CSS rule for the busy indicator**

In the same file, find the `.navigator-result-area` selector in the `<style>` block. There may not be an explicit rule yet — search:

```bash
grep -n "navigator-result-area" hugo-apps/src/navigator/TutorialNavigator.vue
```

If a rule exists, **append** to it. If not, **add** a new rule near the existing `.navigator-grid` / `.navigator-empty` rules (search those for the right neighbourhood).

The rule to add:

```css
.navigator-result-area {
  position: relative;
}

.navigator-result-area > [data-region-busy] {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
}
```

`position: relative` on the wrapper is the anchor for the absolutely-positioned indicator. The indicator does not affect normal flow, so the empty-state, results grid, and sub-threshold hint sit exactly where they did before.

- [ ] **Step 4: Run the harness test**

```bash
cd d:/projects/tutorials-poc
npx vitest run hugo-apps/src/navigator/TutorialNavigator.test.ts --project=unit
```

Expected: 3 passed.

- [ ] **Step 5: Run the full unit suite to check for regressions**

```bash
npx vitest run --project=unit
```

Expected: full unit suite passes (the existing baseline is 620 passing / 0 failing / 13 skipped per `[[project_main_test_failures]]`). The new test adds 3, so target is 623 passing.

If the full unit suite has unrelated failures, narrow to the navigator subtree to confirm this change isn't the cause:

```bash
npx vitest run hugo-apps/src/navigator/ --project=unit
```

- [ ] **Step 6: Build the navigator island and Hugo to confirm no template error**

The hugo-apps Vite build runs through `npm run build:apps`, which calls
`npm --prefix hugo-apps run build` after the MediaPipe vendor copy. For a
navigator-only iteration you can call the inner script directly:

```bash
npm --prefix hugo-apps run build
```

Expected: clean Vite build, navigator chunk emitted to `hugo/static/js/`.

```bash
npm run build:hugo
```

Expected: clean Hugo build (`hugo --source hugo --minify`), no template
error referencing `TutorialNavigator.vue`. `npm run build:hugo` is the
canonical Hugo-only script; `npm run build:all` is the canonical full
pipeline (fetch + CSS + apps + analytics + Hugo + highlight + display).

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "fix(navigator): keep empty-state mounted across keystrokes (#159)

Replace the <Transition mode='out-in'> state-machine wrapper around the
result region with persistent siblings gated by v-show. The
ui5-illustrated-message 'No results match your filters' empty-state now
mounts once and stays mounted; only display toggles. Eliminates the
visible flash on every additional keystroke when the query keeps
returning empty.

<Transition> is reserved for the initial-load skeleton. Busy state is
signalled via aria-busy on the wrapper plus a delayed ui5-busy-indicator
overlay that does not displace siblings.

Closes #159."
```

---

## Task 3: Smoke test for the deployed page

**Files:**
- Create: `test/smoke/navigator-no-results.smoke.test.ts`

The harness test only verifies the Vue contract. We also want a smoke test that runs against the deployed approuter and confirms the new markup ships (`aria-busy` attribute and `data-region-busy` element present in the rendered HTML). This catches build regressions where, e.g., the Vite chunk is stale or Hugo isn't rebuilt.

Note: The navigator page is a Vue island, not server-rendered Hugo. The page HTML contains a Vue mount point (`<div id="tutorial-navigator">`) and the JS chunk reference. The actual `aria-busy` and `data-region-busy` attributes only appear after Vue hydrates client-side. **JSDOM-style execution is too heavy for smoke tests** — instead, assert the JS chunk exists and contains the new markup as a substring. This is a coarse signal but it catches "did the new code get into the bundle".

- [ ] **Step 1: Write the smoke test**

Create `test/smoke/navigator-no-results.smoke.test.ts`:

```ts
// test/smoke/navigator-no-results.smoke.test.ts
//
// Issue #159: verify the deployed navigator JS chunk contains the new
// result-region markup. The visible attributes (aria-busy,
// data-region-busy) only appear after Vue hydrates in a real browser, so
// for a smoke check we string-match the compiled JS bundle: it MUST
// reference the new contract markers.
//
// If the bundle is stale, this test fails — typically because Hugo
// wasn't rebuilt after a hugo-apps change (see [[feedback-hugo-before-mbt]]).

import { describe, it, expect } from 'vitest'

const BASE = process.env.SMOKE_BASE_URL
if (!BASE) throw new Error('SMOKE_BASE_URL must be set')

async function fetchText(path: string): Promise<string> {
  const res = await fetch(new URL(path, BASE))
  expect(res.ok, `${path} returned ${res.status}`).toBe(true)
  return res.text()
}

describe('navigator no-results stability smoke (#159)', () => {
  it('navigator HTML loads and references the navigator JS chunk', async () => {
    const html = await fetchText('/tutorial-navigator/')
    // The Vue mount point is <div id="tutorial-navigator">.
    expect(html).toMatch(/id=["']?tutorial-navigator["']?/)
    // The page must reference the navigator chunk under /js/.
    expect(html).toMatch(/\/js\/navigator(\.[a-z0-9]+)?\.js/)
  })

  it('navigator JS chunk contains the new result-region contract', async () => {
    // Find the navigator chunk URL from the HTML, then fetch and inspect it.
    const html = await fetchText('/tutorial-navigator/')
    const chunkMatch = html.match(/(\/js\/navigator(?:\.[a-z0-9]+)?\.js)/)
    expect(chunkMatch, 'navigator JS chunk URL not found in HTML').toBeTruthy()
    const chunkUrl = chunkMatch![1]

    const js = await fetchText(chunkUrl)
    // The new template emits these literal strings into the compiled
    // render function.
    expect(js).toMatch(/data-region-busy/)
    expect(js).toMatch(/navigator-empty/)
    expect(js).toMatch(/aria-busy/)
    // Sub-threshold hint and busy-indicator class names from the new
    // template — both must be present.
    expect(js).toMatch(/navigator-hint/)
  })
})
```

- [ ] **Step 2: Run locally against DEV to verify the test shape (optional, deferred)**

The smoke test can only run against a deployed environment with `SMOKE_BASE_URL` set. **Do not run this in the implementation session** — it requires the change to already be deployed. Instead, rely on CI's post-deploy smoke step.

For now, verify the test file is syntactically valid and Vitest can collect it (without running, since `SMOKE_BASE_URL` is unset locally):

```bash
npx vitest list --project=smoke 2>&1 | grep "navigator-no-results"
```

Expected: the test path appears in the list. If `SMOKE_BASE_URL` validation throws at collection time, the test will be skipped — that's fine; the post-deploy CI run picks it up.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/navigator-no-results.smoke.test.ts
git commit -m "test(smoke): assert navigator chunk ships #159 result-region markup"
```

---

## Task 4: Local manual smoke (hybrid dev)

**Files:** none (manual verification)

Per `[[project_local_hybrid_dev]]`: run CAP + approuter against real HANA, type into the navigator search, confirm no visible flicker.

- [ ] **Step 1: Build the navigator island**

```bash
cd d:/projects/tutorials-poc
npm --prefix hugo-apps run build
```

(Equivalent to the inner step of `npm run build:apps`; we skip the MediaPipe
vendor copy since it's not needed for a navigator-only iteration.)

- [ ] **Step 2: Build Hugo**

`npm run build:hugo` is the Hugo-only script (`hugo --source hugo --minify`).
For a lightweight dev loop, `npm run dev` runs `hugo server --source hugo` —
note that `dev` requires `npm run fetch-tutorials` to have completed at
least once, since `hugo/content/tutorials/` is gitignored and generated.

```bash
npm run dev
```

This serves Hugo on `http://localhost:1313`.

- [ ] **Step 3: Manual flicker check**

Open `http://localhost:1313/tutorial-navigator/` in a browser.

1. Slowly type `zzzzz` into the search input, one character at a time, with ~500 ms between keystrokes.
2. Confirm: the "No results match your filters" illustration appears once after the second character and stays put. **No flicker, no fade-out/fade-in, no visible churn.**
3. Open DevTools → Elements. Inspect the `.navigator-empty` div. Type one more `z`. Confirm the same DOM node persists (DevTools highlights flashes only if the node was recreated; with the fix, no highlight).
4. Type `cap` — confirm result cards appear and the empty-state visibly hides without flicker.
5. Backspace to empty input — confirm the browse view (paginated `displayedItems`) returns and the empty-state visibly hides.
6. Type one character (`c`) — confirm the "Keep typing…" sub-threshold illustration appears once and stays put if you type and delete sub-threshold-length input repeatedly.

- [ ] **Step 4: Manual aria-busy check**

In DevTools, set the network throttling to "Slow 3G" or use the "Performance > Network" tab to add a fixed delay. Type `cap` — confirm:

1. `<div class="navigator-result-area" aria-busy="true">` appears in DevTools while the request is in flight.
2. `<ui5-busy-indicator active>` appears overlaid in the top-center of the result region (visible only if the request takes >400 ms).
3. `aria-busy="false"` and `<ui5-busy-indicator>` (no `active`) once the response settles.

- [ ] **Step 5: Note any issues**

If any of the above checks fail, **stop and revisit Task 2** — the template restructure is wrong. Common pitfalls:

- `v-show` not propagating to `display:none`: check that the Vue render function actually emits the `style="display: none"` attribute (DevTools → Elements). If it doesn't, the `v-show` was misapplied (e.g., on a `<template>` instead of an element).
- Empty state always visible on initial load before tutorials fetch: the guard `!loading && !isSubThreshold && displayedItems.length === 0` should evaluate to `false` while `loading` is `true` (tutorials.value.length === 0). Double-check `loading` computed.
- Busy indicator not centering: check `position: relative` is on `.navigator-result-area` (Step 3 of Task 2).

---

## Task 5: PR

**Files:** none (PR creation)

Per `[[feedback_pr_over_direct_merge]]`: open a PR, do **not** fast-merge to `main`.

- [ ] **Step 1: Push the branch**

```bash
cd d:/projects/tutorials-poc
git push -u origin fix/navigator-no-results-flash-159
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create \
  --title "fix(navigator): stop the no-results flash on every keystroke (#159)" \
  --body "$(cat <<'EOF'
Closes #159.

## Problem

Typing into the navigator search box, when the query has no matches, made
the empty-state \`ui5-illustrated-message\` "No results match your filters"
flash on every additional keystroke. Spec at
[docs/superpowers/specs/2026-06-01-tutorial-navigator-no-results-flash-design.md](docs/superpowers/specs/2026-06-01-tutorial-navigator-no-results-flash-design.md).

## Fix

The \`<Transition mode="out-in">\` block in
\`hugo-apps/src/navigator/TutorialNavigator.vue\` was acting as a
state-machine discriminator, mounting/unmounting the heavy illustrated
empty-state on every \`isSearching\` flip. Replaced with persistent
siblings gated by \`v-show\` outside the \`<Transition>\` (which now
wraps only the initial-load skeleton). Busy state moved to
\`aria-busy\` on the wrapper plus a delayed \`ui5-busy-indicator\` that
overlays without displacing siblings.

## Tests

- \`hugo-apps/src/navigator/TutorialNavigator.test.ts\` — minimal-harness
  Vitest contract test asserting the empty-state DOM node identity is
  preserved across consecutive empty searches and across mid-flight
  busy-state flips. Follows the existing pattern of
  \`__tests__/vt-card-marker.test.ts\`.
- \`test/smoke/navigator-no-results.smoke.test.ts\` — post-deploy smoke
  asserting the navigator JS chunk on the deployed approuter contains
  the new contract markers (\`data-region-busy\`, \`aria-busy\`,
  \`navigator-empty\`, \`navigator-hint\`).

## Manual verification

- \`http://localhost:1313/tutorial-navigator/\` — slowly type \`zzzzz\`,
  confirm the empty-state appears once and stays put. Verified locally.

## Risk

- Pure UI change in one Vue island.
- No schema / API / auth / persistence changes.
- One additive CSS rule.

## Out of scope

- CommandPalette (cmd-K) text-swap flicker — same mechanism, different
  surface. Worth filing a sibling issue if Daniel hits it too.
EOF
)"
```

- [ ] **Step 3: Confirm CI passes on the PR**

Watch the PR's checks. The unit suite must pass; smoke runs only after a deploy. Address any review feedback before merge.

---

## Closeout

Once the PR is merged and the next deploy lands:

1. Verify on DEV: `https://<dev-approuter>/tutorial-navigator/` — repeat the manual flicker check from Task 4 Step 3.
2. Confirm the smoke job (`navigator-no-results.smoke.test.ts`) passes in the post-deploy CI step.
3. Comment on issue #159 with the deployed URL and a one-line confirmation.
4. Close issue #159.

---

## Reference: relevant memories

- `[[feedback_hugo_before_mbt]]` — Hugo MUST finish before any approuter packaging step.
- `[[feedback_pr_over_direct_merge]]` — Default to PR; subagent review ≠ PR review.
- `[[feedback_verify_branch_before_commit]]` — Always check `git branch --show-current` in the same Bash invocation as `git commit`.
- `[[project_u7_illustrated]]` — `ui5-illustrated-message` precedent in this codebase (404, MyCompletions empty, navigator filter empty).
- `[[feedback_ui5_dialog_open_property]]` — UI5 v2 API gotcha (not directly relevant here, but a reminder to verify `ui5-busy-indicator` v2 props via the UI5 MCP if anything looks off).
